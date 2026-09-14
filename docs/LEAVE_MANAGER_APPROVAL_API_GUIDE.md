# Leave Manager Approval API Guide

Leave approval flow after organizational line managers are configured.  
For department/employee manager setup, see [Line Manager API Guide](./LINE_MANAGER_API_GUIDE.md).

---

## Flow

1. Employee submits leave → **`pending`**
2. **Primary and additional** assigned managers + company admin see the request
3. Any assigned manager approves → **`manager_approved`** (no balance change)
4. Company admin final approve → **`approved`** (balance deducted)
5. Company admin can approve directly from **`pending`** (skip manager step)

---

## Status values

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for manager and/or admin |
| `manager_approved` | Manager approved; waiting for admin |
| `approved` | Final approval; balance deducted |
| `rejected` | Rejected by manager or admin |
| `cancelled` | Cancelled by employee or admin |

---

## Who sees team requests

A manager sees team leave requests when they appear in `employee_line_managers` for a subordinate (role `primary` or `additional`).

**Profile flag:** `GET /v1/auth/profile` → `employee.is_line_manager` (`true` / `false`)

---

## Employee APIs

### Submit leave

**API:** `POST /v1/leaves/requests`

Creates request with status `pending`. Notifies all assigned line managers.

### List own requests

**API:** `GET /v1/leaves/requests/me`

### Cancel own request

**API:** `PATCH /v1/leaves/requests/me/:requestId/cancel`

Allowed while status is `pending` or `manager_approved`.

---

## Line manager APIs

### List team requests

**API:** `GET /v1/leaves/requests/team`

Returns requests for employees where the logged-in manager is in `employee_line_managers`.

| Query param | Description |
|-------------|-------------|
| `status` | Filter by status |
| `leave_policy_id` | Filter by policy |
| `search` | Search employee name, code, policy, reason |
| `page`, `limit` | Pagination |

### Get team request detail

**API:** `GET /v1/leaves/requests/team/:requestId`

### Approve or reject (manager)

**API:** `PATCH /v1/leaves/requests/team/:requestId/status`

| Attribute | Type | Description |
|-----------|------|-------------|
| `status` | string | `manager_approved` or `rejected` |
| `manager_comment` | string \| null | Optional comment |

**Approve**

```json
{
  "status": "manager_approved",
  "manager_comment": "Approved."
}
```

**Reject**

```json
{
  "status": "rejected",
  "manager_comment": "Not approved."
}
```

**Rules**

- Only when request status is `pending`
- Only if caller is an assigned manager of that employee
- No balance change on `manager_approved`

---

## Company admin APIs

### List all requests

**API:** `GET /v1/leaves/requests`

### Get request detail

**API:** `GET /v1/leaves/requests/:requestId`

### Approve / reject / cancel

**API:** `PATCH /v1/leaves/requests/:requestId/status`

| Attribute | Type | Description |
|-----------|------|-------------|
| `status` | string | `approved`, `rejected`, or `cancelled` |
| `hr_comment` | string \| null | Optional comment |

Works when status is `pending` or `manager_approved`.

**Direct approve (from pending)**

```json
{
  "status": "approved",
  "hr_comment": "Approved."
}
```

**Final approve (after manager)**

```json
{
  "status": "approved",
  "hr_comment": "Final approval."
}
```

Balance is deducted only when status becomes `approved`.

---

## Response fields (leave request)

| Attribute | Description |
|-----------|-------------|
| `status` | Current status |
| `manager_comment` | Comment from line manager |
| `hr_comment` | Comment from company admin |
| `manager_reviewed_by` | Line manager who approved/rejected at manager stage (`id`, `first_name`, `last_name`, `email`, `role: "manager"`) |
| `hr_reviewed_by` | Company admin who gave final approval/rejection/cancel (`id`, `name`, `email`, `role: "admin"`) |
| `approved_by` | Convenience field for UI: who approved/rejected based on current status (`type`: `"manager"` or `"admin"`, plus `name`, `email`) |
| `employee` | `{ id, first_name, last_name, employee_code, email }` |

---

## Migrations

```bash
node scripts/migrate-leave-manager-approval.js
node scripts/migrate-multi-line-managers.js
node scripts/migrate-leave-request-reviewers.js
```
