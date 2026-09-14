# HR Requests — Manager & Admin Approval Guide

Simple overview of the HR **Requests** module: what it does, how approval works, new fields, and API endpoints.

Base URL for all examples: `/api/v1/requests`

For line-manager setup, see [Line Manager API Guide](./LINE_MANAGER_API_GUIDE.md).  
Leave requests use a **separate** module (`/api/v1/leaves/requests`).  
Document requests use a **separate** module (`/api/v1/document-requests`).

---

## Purpose

Employees submit HR requests from the portal. Requests go through a **two-step approval flow** (same idea as leave):

1. **Line manager** reviews direct reports’ requests.
2. **Admin / HR** gives final approval or rejection.

This keeps managers involved before HR takes action on attendance, WFH, resignation, loans, advances, and PF requests.

---

## Request types in this module

| Type | Description |
|------|-------------|
| `attendance_correction` | Fix missed or wrong clock-in/out |
| `wfh` | Work from home for selected dates |
| `resignation` | Employee resignation / notice period |
| `loan` | Employee loan request |
| `advance` | Salary advance request |
| `pf_temporary` | PF temporary withdrawal |
| `pf_permanent` | PF permanent withdrawal |

**Not in this flow**

- **Document requests** — separate module (`document_requests` table, upload-by-HR flow).
- **Expense** — backend still supports it, but it is **hidden in the UI** for now.

Use `request_type=financial` in list APIs to fetch loan, advance, PF temporary, and PF permanent together.

---

## Approval flow

```
Employee submits  →  pending
        ↓
Manager approves  →  manager_approved   (optional step; manager can reject instead)
        ↓
Admin/HR approves →  approved
```

**Shortcuts**

- Admin/HR can approve directly from **`pending`** (skip manager step).
- Manager can only act on **`pending`** → `manager_approved` or `rejected`.
- Admin/HR can act on **`pending`** or **`manager_approved`** → `approved` or `rejected`.

### Status values

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for manager and/or admin |
| `manager_approved` | Manager approved; waiting for admin/HR |
| `approved` | Final approval (business action applied where needed) |
| `rejected` | Rejected by manager or admin |
| `cancelled` | Cancelled by employee |

### Who sees team requests

A manager sees a request when they are assigned to the employee in **`employee_line_managers`**.

Profile flag: `GET /api/v1/auth/profile` → `employee.is_line_manager`

---

## New / updated database fields

These fields were added on the **`requests`** table for manager approval (mirrors leave):

| Field | Type | Description |
|-------|------|-------------|
| `manager_comment` | TEXT | Comment from line manager when approving/rejecting |
| `manager_reviewed_by` | BIGINT → `employees.id` | Which manager acted (employee record, not user id) |
| `manager_reviewed_at` | TIMESTAMP | When the manager acted |
| `review_stage` | VARCHAR | `manager`, `hr`, or `ceo` while in review; cleared after final action |
| `status` | VARCHAR | Now includes **`manager_approved`** for all request types above |

Existing HR fields (unchanged):

| Field | Description |
|-------|-------------|
| `reviewed_by` | Admin/HR user who gave final approval/rejection |
| `reviewed_at` | Final review timestamp |
| `hr_comment` | Comment from admin/HR on reject (or related notes) |

---

## New fields in API responses

List and detail APIs now return these extra properties on each request:

| Field | Description |
|-------|-------------|
| `manager_comment` | Manager’s comment |
| `manager_reviewed_by` | Object: `{ id, first_name, last_name, email, employee_code, role: "manager" }` |
| `manager_reviewed_at` | ISO timestamp |
| `hr_reviewed_by` | Object: `{ id, name, email, role: "admin" }` |
| `hr_reviewed_at` | Same as final `reviewed_at` |
| `review_stage` | Current review stage, if any |
| `approved_by` | **Who acted last** — useful for UI “Approved By” column |

**`approved_by` logic (summary)**

- `approved` → shows HR/admin reviewer
- `manager_approved` or manager-stage `rejected` → shows manager
- Otherwise → `null`

---

## API endpoints

### Employee APIs (unchanged paths, updated behavior)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/` | Submit a new request → status `pending` |
| `GET` | `/my` | List own requests |
| `PATCH` | `/:id/cancel` | Cancel own pending request |
| `GET` | `/resignation/preview` | Preview resignation dates before submit |

**Submit example**

```http
POST /api/v1/requests
Authorization: Bearer <token>
Content-Type: application/json

{
  "request_type": "wfh",
  "details": { ... }
}
```

---

### Line manager APIs (**NEW**)

Generic team endpoints work for **all** manager-approval request types.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/team` | List direct reports’ requests |
| `GET` | `/team/:id` | Get one team request |
| `PATCH` | `/team/:id/status` | Manager approve or reject |

**List team requests**

```http
GET /api/v1/requests/team?request_type=wfh&status=pending&page=1&limit=10
Authorization: Bearer <token>
```

| Query param | Description |
|-------------|-------------|
| `request_type` | Filter by type, or `financial` for loan/advance/PF types |
| `status` | `pending`, `manager_approved`, `approved`, `rejected`, `cancelled` |
| `search` | Employee name, code, email, or request details |
| `date` | Filter by request date |
| `page`, `limit` | Pagination |

**Manager approve / reject**

```http
PATCH /api/v1/requests/team/:id/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "manager_approved",
  "manager_comment": "Looks fine."
}
```

| Body field | Required | Values |
|------------|----------|--------|
| `status` | Yes | `manager_approved` or `rejected` |
| `manager_comment` | No | Max 2000 characters |

**Backward-compatible aliases (attendance correction only)**

These still work but prefer `/team` for new integrations:

| Method | Endpoint |
|--------|----------|
| `GET` | `/attendance-correction/team` |
| `GET` | `/attendance-correction/team/:id` |
| `PATCH` | `/attendance-correction/team/:id/status` |

---

### Admin / HR APIs (**UPDATED**)

| Method | Endpoint | What changed |
|--------|----------|--------------|
| `GET` | `/admin` | Returns `manager_approved` requests; supports `request_type=financial` |
| `GET` | `/pending` | Same list filters as admin |
| `PATCH` | `/:id/approve` | Can approve from **`pending`** or **`manager_approved`** |
| `PATCH` | `/:id/reject` | Can reject from **`pending`** or **`manager_approved`** |
| `PATCH` | `/:id` | Edit request (where allowed by type/status) |

**Admin list example**

```http
GET /api/v1/requests/admin?request_type=resignation&status=manager_approved&page=1&limit=10
Authorization: Bearer <token>
```

**Admin final approve**

```http
PATCH /api/v1/requests/:id/approve
Authorization: Bearer <token>
Content-Type: application/json

{
  "hr_comment": "Approved by HR."
}
```

**Admin reject**

```http
PATCH /api/v1/requests/:id/reject
Authorization: Bearer <token>
Content-Type: application/json

{
  "hr_comment": "Reason for rejection."
}
```

On final approve/reject, **`manager_reviewed_by`** is kept for audit. **`reviewed_by`** / **`reviewed_at`** store the admin/HR action.

---

## Email notifications

Emails are sent on key events (same pattern as attendance correction / leave):

| Event | Who is notified |
|-------|-----------------|
| Request submitted | Assigned line managers + HR |
| Manager approved | Employee + HR |
| Manager rejected | Employee |
| Admin approved | Employee |
| Admin rejected | Employee |

---

## Frontend pages (reference)

| Role | Page | Route |
|------|------|-------|
| Employee | My Requests | `/employee/requests` |
| Manager | Team Requests | `/employee-team-requests` |
| Admin | Requests | `/requests/pending` |
| Manager (leave only) | Team Leave Requests | `/employee-team-leave-requests` |

---

## Quick checklist for integrators

1. Employee submits → `POST /api/v1/requests`
2. Manager lists team → `GET /api/v1/requests/team`
3. Manager acts → `PATCH /api/v1/requests/team/:id/status`
4. Admin lists → `GET /api/v1/requests/admin?status=manager_approved`
5. Admin final action → `PATCH /api/v1/requests/:id/approve` or `/reject`
6. Show **Approved By** from response field `approved_by`

---

## Migration note

Run once on existing databases if not already applied:

```bash
node scripts/migrate-request-manager-approval-all-types.js
```

This allows `manager_approved` status for all HR request types (not only attendance correction).
