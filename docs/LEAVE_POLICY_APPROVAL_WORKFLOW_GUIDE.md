# Leave Policy & Approval Workflow — Implementation Guide

Full reference for the Leave module: policies, eligibility, the configurable multi-step
approval workflow, balances, and the leave request lifecycle. Supersedes
[LEAVE_MANAGER_APPROVAL_API_GUIDE.md](./LEAVE_MANAGER_APPROVAL_API_GUIDE.md) (that guide only
covers the legacy two-tier manager→admin flow, which still exists here as the *default*
fallback when no workflow is configured).

**Backend files:**
- `src/services/leavePolicy.service.js` — policies, eligibility, balances-on-activation
- `src/services/leaveApprovalWorkflow.service.js` — configurable approval engine
- `src/services/leaveRequest.service.js` — request lifecycle, balances-on-approval
- `src/services/leaveBalance.service.js` — balance CRUD, deduction, grant-on-hire
- `src/controllers/leave.controller.js` — HTTP layer
- `src/routes/leaves.routes.js` — route wiring, all under `/api/v1/leaves`
- `src/controllers/auth.controller.js` — `GET /v1/auth/profile`'s `is_line_manager` flag

**Frontend files:**
- `pages/AdminPages/CompanyAdmin/LeavePolicy/` — admin policy list, add/edit, `ConfigureWorkflowModal.jsx`, `PolicyDetails.jsx`
- `pages/AdminPages/CompanyAdmin/LeaveRequest/` — admin request list + override actions
- `pages/AdminPages/Employee/LeavePolicy/` — employee's eligible policies (read-only)
- `pages/AdminPages/Employee/LeaveRequest/` — submit + view own requests
- `pages/AdminPages/Employee/TeamRequests/TeamLeaveRequest/` (or equivalent) — approver queue, gated by `LineManagerRoute`

---

## 1. Data model

| Table | Purpose | Key columns |
|---|---|---|
| `leave_policies` | A named leave type (Annual, Sick, …) scoped to a company | `paid_status` (paid/unpaid), `days_per_year`, `status` (active/inactive), `eligible_department_id`, `eligible_designation_id` |
| `leave_policy_eligible_employees` | Explicit per-employee override of who's eligible | `leave_policy_id`, `employee_id` — presence of *any* row for a policy makes it the **sole** eligibility source (department/designation columns are ignored) |
| `leave_balances` | Per employee/policy/year balance | `total_days`, `used_days`, `available_days`, unique on `(employee_id, leave_policy_id, year)` |
| `leave_policy_approval_steps` | **Configured** approval chain for a policy | `step_order`, `approver_type`, `access_role_id`, `approver_user_id` — empty for a policy = default flow |
| `leave_requests` | A submitted leave request | `status`, `from_date`/`to_date`, `total_days`, `manager_comment`/`manager_reviewed_by`/`manager_reviewed_at`, `hr_comment`/`hr_reviewed_by`/`hr_reviewed_at` |
| `leave_request_approvals` | **Snapshot** of the policy's steps, copied onto the request at submission time | Same shape as `leave_policy_approval_steps` plus `status` (pending/approved/rejected/skipped), `acted_by`, `acted_at`, `comment` |

Manager-hierarchy tables used to resolve dynamic approver types (shared with other modules):
- `employee_line_managers(employee_id, manager_id, manager_role)` — role is `primary` or `additional`
- `department_line_managers(department_id, employee_id, manager_role)` — role `head` resolves "department head"

**Why a snapshot table exists:** editing a policy's workflow later must never change an
already-submitted request's approval chain. `leave_policy_approval_steps` is the live config;
`leave_request_approvals` is a frozen copy made at `POST /requests` time.

---

## 2. Eligibility ("who can even see/request this policy")

Resolved in `leavePolicy.service.js` (`isEmployeeEligibleForPolicy`, `computeEligibleEmployeeIds`):

1. If `leave_policy_eligible_employees` has **any** rows for the policy → eligibility is **exactly** that explicit list. Department/designation columns are ignored entirely.
2. Otherwise → eligible if `eligible_department_id` matches the employee's department (or is `NULL` = unrestricted) **and** `eligible_designation_id` matches (or is `NULL`).
3. If both `eligible_department_id` and `eligible_designation_id` are `NULL` and there are no explicit employees → **every employee in the company** is eligible.

Balances are only granted to currently-eligible employees, and only while the policy is
`active` (see §5, "Balance grant/freeze on activate/deactivate").

Eligibility is a **separate concern from the approval workflow** — it controls who can
*submit* a request against the policy, not who *approves* it.

---

## 3. Approval workflow engine

### 3.1 Approver types

Every step in a chain is one of:

| `approver_type` | Resolves to |
|---|---|
| `primary_manager` | The requester's `employee_line_managers` row with `manager_role = 'primary'` |
| `additional_manager` | Same, `manager_role = 'additional'` (an employee can have several) |
| `department_head` | `department_line_managers` row with `manager_role = 'head'` for the requester's department |
| `access_role` | Any **active** user in the company holding the selected `access_role_id` |
| `user` | One specific, fixed `approver_user_id` — regardless of who's requesting |

Resolution is `resolveStepApproverUserIds(db, companyId, employeeId, step)` → an array of
`users.id`. It's evaluated fresh every time someone tries to act (not cached), so an employee
transferring managers mid-flight correctly changes who can act on their pending steps.

### 3.2 Config lifecycle

- `GET /v1/leaves/policies/:id/approval-steps` — read the current chain for a policy.
- `PUT /v1/leaves/policies/:id/approval-steps` — **replace-all** save. Body: `{ approval_steps: [{ approver_type, access_role_id?, approver_user_id? }, ...] }`. Order in the array = `step_order` (1-indexed), max **10 steps**. Validates each `access_role_id`/`approver_user_id` belongs to the company (and for `user`, that the account is active).
- Also attaches `resolved_approvers` per step in the `GET` response when possible — see §3.6.

### 3.3 Snapshot at submission

`createLeaveRequest` → `snapshotApprovalStepsForRequest(client, leaveRequestId, policyId, companyId)`:
copies whatever steps are currently configured for the policy into `leave_request_approvals`
for that specific request. **No-op if the policy has zero configured steps** — this is exactly
what makes "empty = default flow" work: a request with no snapshot rows always falls back to
the legacy manager→admin path everywhere downstream.

### 3.4 Advancing the chain

`actOnRequestStep(client, companyId, actingUserId, leaveRequestId, requesterEmployeeId, decision, comment, nowUtc)`:

1. Finds the current pending step (lowest `step_order` with `status = 'pending'`).
2. Resolves that step's eligible `users.id` set; the acting user must be in it, else `404 Leave request not found` (deliberately not `403`, to avoid confirming the request exists to someone who can't act on it).
3. Marks the step `approved` or `rejected`.
4. Returns `{ finalStatus }`:
   - `'rejected'` → the whole request is immediately rejected, no further steps matter.
   - `'approved'` → only if **no pending steps remain** (i.e. this was the last one) — the request is fully approved and the leave balance is deducted right there.
   - `null` → more steps remain; `leave_requests.status` is set to `'manager_approved'` (reused generically as "in progress, not final") so every existing status badge/filter shows meaningful progress. The *authoritative* "whose turn is it" signal is always `leave_request_approvals`, never this coarse status column.

### 3.5 Admin override

A Company Admin acting via `PATCH /v1/leaves/requests/:id/status` **always** works on a
`pending`/`manager_approved` request, workflow or not: `skipPendingStepsForRequest` marks any
still-pending steps `'skipped'` before applying the admin's decision directly. This is a
structural no-op (0 rows affected) when there's no workflow, so it never changes behavior for
policies without one.

### 3.6 Resolved-approver preview (config UI only)

`attachResolvedApprovers` (called from `getPolicyApprovalSteps`) tries to show **real
names/emails** instead of just the generic type label, so an admin configuring a workflow can
see who it currently means:

- `access_role` steps: resolved **unconditionally** — every active user in the company currently holding that role, company-wide, since this doesn't depend on the requester.
- `primary_manager` / `additional_manager` / `department_head` steps: only resolved when the **policy is explicitly scoped to a small (≤15), named set of eligible employees** (via `leave_policy_eligible_employees`). For each such employee, resolves who the step currently means for them. Department/designation-scoped or fully open policies are left with just the generic description — there's no single concrete answer since it varies per requester.

Response shape added per step when resolvable:
```json
"resolved_approvers": [
  { "employee_id": 41, "employee_name": "David Employee3", "approvers": [{ "user_id": 12, "name": "David Employee3", "email": "employee3@acme.com" }] }
]
```
(`employee_id`/`employee_name` are `null` for `access_role` steps, since those aren't per-employee.)

---

## 4. Leave request lifecycle (state machine)

```
pending ──(reject)──────────────────────────► rejected
   │
   ├──(no workflow) manager approves ───────► manager_approved ──(admin approves)──► approved
   │                                                          └─(admin rejects)────► rejected
   │
   └──(workflow) step 1..N-1 approved ───────► manager_approved (generic "in progress")
                 step N (last) approved ─────► approved  (balance deducted here)
                 any step rejected ───────────► rejected

pending / manager_approved ──(employee cancels)──► cancelled
pending / manager_approved ──(admin, any time)───► approved | rejected | cancelled  (override, skips remaining steps)
```

Balance deduction (`deductBalanceForApprovedLeave`) happens exactly once, at the moment a
request reaches `approved` — whether that's via the admin endpoint or the last workflow step —
and accounts for company holidays in the date range (`computeBillableLeaveDays`); the stored
`total_days` on the request itself stays the plain inclusive calendar count.

---

## 5. Full API reference

All routes are under `/api/v1/leaves`, gated by `protect(moduleKey, action)`:
`leave_policies` for policy/workflow endpoints, `leave_balances` for balance endpoints,
`leave_requests` for request endpoints. Every response uses the standard envelope
`{ error: boolean, message: string, data: <payload or null> }`.

### 5.1 Leave Policies (admin)

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| `POST` | `/policies` | `{ name, code, paid_status, days_per_year, status?, eligible_department_id?, eligible_designation_id?, eligible_employee_ids? }` | `code` normalized to 1–20 uppercase alnum. Creating an `active` policy immediately grants `leave_balances` rows to every currently-eligible employee for the current year. |
| `POST` | `/policies/import` | `{ rows: [...] }`, max 50 | Atomic — one bad row rolls back the whole batch. |
| `GET` | `/policies` | `status`, `paid_status`, `search`, `created_from`, `created_to`, `sort_by`, `sort_order`, `page`, `limit` | Admin list, all policies in the company. |
| `GET` | `/policies/:id` | — | Detail + `eligible_employees` (name/email), `eligible_department_name`, `eligible_designation_name`. |
| `PATCH` | `/policies/:id` | Same fields as create, all optional | Changing eligibility re-grants/prunes balances for the delta; deactivating **freezes** balances (`total_days = used_days`, `available_days = 0`) instead of deleting them. |
| `DELETE` | `/policies/:id` | — | **409** if any `leave_requests` reference this policy (checked explicitly before delete). Balances for the policy are deleted first, then the policy row (cascades approval steps + eligible-employee rows). |
| `GET` | `/policies/me` | — | Employee-only: their eligible **active** policies. |
| `GET` | `/policies/me/:id` | — | 404 unless active *and* the employee is eligible. |

### 5.2 Approval workflow config (admin)

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/policies/:id/approval-steps` | — | Returns `{ approval_steps: [...] }`, each step including `resolved_approvers` where resolvable (§3.6). Empty array = default flow. |
| `PUT` | `/policies/:id/approval-steps` | `{ approval_steps: [{ approver_type, access_role_id?, approver_user_id? }] }` | Replace-all. Max 10 steps. `access_role`/`user` steps are validated against the company. |

### 5.3 Leave Balances

| Method | Path | Notes |
|---|---|---|
| `GET` | `/balances/me` | Employee's own balances (query: `year`, `leave_policy_id`, `search`, `page`, `limit`; can be grouped by employee for a "my balances" card view). |
| `GET` | `/balances` | Admin, company-wide, same filters plus `employee_id`. |
| `GET` | `/balances/:id` | Single balance. |
| `PATCH` | `/balances/:id` | Admin manual adjustment of `total_days`/`used_days`/`available_days`. |
| `DELETE` | `/balances/:id` | Admin delete. |

### 5.4 Leave Requests — employee

| Method | Path | Body | Checks |
|---|---|---|---|
| `POST` | `/requests` | `{ leave_policy_id, from_date, to_date?, reason }` | `to_date` defaults to `from_date` (single-day). Policy must be `active`. **409** if an active/pending/approved request already overlaps the date range for this employee. On success: snapshots approval steps (if any configured), emails employee + company admin + line manager. |
| `GET` | `/requests/me` | `status`, `from_date`, `to_date`, `search`, pagination | Each item includes `approval_progress` (`null` if no workflow). |
| `GET` | `/requests/me/:id` | — | 404 unless owned by the caller. |
| `PATCH` | `/requests/me/:id/cancel` | — | Allowed only while `pending` or `manager_approved`. |

### 5.5 Leave Requests — team / approver

| Method | Path | Body | Checks |
|---|---|---|---|
| `GET` | `/requests/team` | `status`, `leave_policy_id`, `search`, pagination | Visible if: (a) no workflow configured **and** caller is the requester's manager (`employee_line_managers`), **or** (b) caller is the resolved approver of the *current* pending step, **or** (c) caller has *already acted* on any step of this request (keeps it visible read-only after acting, instead of disappearing). Each item includes `approval_progress` and `is_actionable_by_me`. |
| `GET` | `/requests/team/:id` | — | Same visibility rule as above, single item. |
| `PATCH` | `/requests/team/:id/status` | `{ status: 'manager_approved' \| 'rejected', manager_comment? }` | This is the **generic "act on current step" endpoint** — used for the legacy single manager step *and* every step of a configured chain, including the final one (which deducts balance and fully finalizes). `status` value is reused as a decision flag: anything other than `'rejected'` means "approve". Errors: 404 if not found/not your turn, 400 if the request has no pending step or isn't in an actionable status. |

### 5.6 Leave Requests — company admin

| Method | Path | Body | Checks |
|---|---|---|---|
| `GET` | `/requests` | `status`, `employee_id`, `leave_policy_id`, `search`, pagination | Full company view. |
| `GET` | `/requests/:id` | — | — |
| `PATCH` | `/requests/:id/status` | `{ status: 'approved' \| 'rejected' \| 'cancelled', hr_comment? }` | **Override**, always available on `pending`/`manager_approved` regardless of workflow state — skips any remaining pending steps first (§3.5). Approving deducts balance; both approve/reject send emails. |

### Response shape — a single leave request item

```jsonc
{
  "id": 101,
  "employee_id": 41,
  "leave_policy_id": 7,
  "leave_policy": { "id": 7, "name": "Parental Leaves", "code": "PL", "paid_status": "paid" },
  "from_date": "2026-08-01",
  "to_date": "2026-08-05",
  "total_days": 5,
  "reason": "...",
  "status": "manager_approved",
  "manager_comment": null,
  "hr_comment": null,
  "manager_reviewed_by": { "id": 12, "first_name": "...", "last_name": "...", "email": "...", "role": "manager" },
  "manager_reviewed_at": "2026-07-24T05:30:00.000Z",
  "hr_reviewed_by": null,
  "hr_reviewed_at": null,
  "approved_by": null,           // set once status is approved/rejected/cancelled — { type: 'manager'|'admin', name, email }
  "approval_progress": {          // null if this request has no configured workflow
    "total_steps": 2,
    "current_step_order": 2,
    "current_step_description": "Access Role: Company Admin"
  },
  "is_actionable_by_me": false,   // only present on /team endpoints
  "created_at": "...",
  "updated_at": "..."
}
```

---

## 6. Notification emails

Fired (fire-and-forget, failures only logged) via `leaveEmailNotification.service.js`:

| Event | Recipients |
|---|---|
| Request submitted | Employee, company admin/HR, line manager |
| Interim workflow step cleared | Same as "manager approved" template |
| Final approval (any path) | Employee — plus a separate "balance updated" email with before/after totals |
| Rejected at a non-final step | "Rejected by manager" template |
| Rejected at final/admin step | "Rejected" template |
| Cancelled | Employee/admin |

---

## 7. Cross-cutting fix: `is_line_manager` profile flag

`GET /v1/auth/profile` returns `employee.is_line_manager`, which the frontend uses to gate the
entire "Team Leave Requests" page/nav item (`LineManagerRoute`, `Shell.jsx`). It must return
`true` for **anyone with something actionable to see**, not just literal line managers, or a
workflow-configured approver (e.g. a named "Finance Manager" who isn't anyone's people-manager)
would never even reach the page that shows their queue. Computed in `auth.controller.js` as
`true` if **any** of:

1. `employee_line_managers` — caller manages someone directly.
2. `department_line_managers` (`manager_role = 'head'`) — caller heads a department.
3. `leave_policy_approval_steps` — caller is named (`approver_user_id`) or matches an `access_role_id` in **any** policy's configured chain (proactive — shows the tab even before a request exists).
4. `leave_request_approvals` (`status = 'pending'`) — caller matches a currently pending step of an already-submitted request.

---

## 8. Frontend notes

- `ConfigureWorkflowModal.jsx` — two-column layout: left is the editable step list (add/remove/reorder, per-step approver-type + access-role/employee pickers via `SearchableSelect`), right is a live, read-only **Approval Flow Preview** built from the same `resolveStepPreview` logic, styled with the same colored-card language as the Organizational Setup chart (violet = manager types, indigo = department head, amber = access role, blue = specific employee, sky = start, emerald = end/approved).
- `PolicyDetails.jsx` — read-only drawer showing policy fields, the configured Approval Steps (icon + name + email/description, connected by arrows), and Eligible Employees (icon + name + email), using the same bordered-card + icon-badge visual language.
- Team/approver list pages read `is_actionable_by_me` to decide between an actionable status dropdown and a read-only badge, and `approval_progress.current_step_description` to show "Step X of Y — waiting on …".
