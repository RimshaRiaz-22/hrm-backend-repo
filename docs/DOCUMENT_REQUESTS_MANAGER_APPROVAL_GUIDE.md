# Document Requests — Manager & HR Approval Guide

Simple overview of the **Document Requests** module: approval flow, new fields, and API endpoints.

Base URL for all examples: `/api/v1/document-requests`

For line-manager setup, see [Line Manager API Guide](./LINE_MANAGER_API_GUIDE.md).  
HR **Requests** (attendance, WFH, loan, etc.) use a **separate** module (`/api/v1/requests`).  
Leave requests use `/api/v1/leaves/requests`.

---

## Purpose

Employees request official documents (experience letter, salary certificate, NOC, etc.). Requests go through a **two-step flow**:

1. **Line manager** reviews and approves or rejects direct reports’ requests.
2. **Admin / HR** uploads the final document file → status becomes **`ready`**.

HR does **not** “approve” document requests — they **upload** the file. The employee can then download it.

---

## Document types

| Type | Description |
|------|-------------|
| `experience_letter` | Experience letter |
| `salary_certificate` | Salary certificate |
| `noc` | No Objection Certificate |
| `bank_letter` | Bank letter |
| `other` | Other (purpose must be detailed) |

---

## Approval flow

```
Employee submits  →  pending
        ↓
Manager approves  →  manager_approved   (or rejected)
        ↓
HR uploads file   →  ready
```

**Shortcuts**

- HR can upload or reject directly from **`pending`** (skip manager step), same as leave/HR requests.
- Manager can only act on **`pending`** → `manager_approved` or `rejected`.
- HR can upload or reject from **`pending`** or **`manager_approved`**.

### Status values

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for manager and/or HR |
| `manager_approved` | Manager approved; waiting for HR to upload |
| `ready` | HR uploaded the final document |
| `rejected` | Rejected by manager or HR |
| `cancelled` | Cancelled by employee (while `pending` or `manager_approved`) |

### Who sees team document requests

A manager sees a request when they are assigned to the employee in **`employee_line_managers`**.

**Permission module:** `documents` (view for list/detail, edit for manager approve/reject).

---

## New / updated database fields

Added on the **`document_requests`** table:

| Field | Type | Description |
|-------|------|-------------|
| `manager_comment` | TEXT | Comment from line manager when approving/rejecting |
| `manager_reviewed_by` | BIGINT → `employees.id` | Which manager acted |
| `manager_reviewed_at` | TIMESTAMP | When the manager acted |
| `review_stage` | VARCHAR | `manager` while in manager review; cleared after HR upload/reject |
| `status` | Now includes **`manager_approved`** |

Existing HR fields (unchanged):

| Field | Description |
|-------|-------------|
| `reviewed_by` | Admin/HR user who uploaded or rejected |
| `reviewed_at` | HR action timestamp |
| `file_url`, `file_name` | Final document after HR upload |
| `rejection_reason` | Reason when rejected |

**Migration script:** `scripts/migrate-document-request-manager-approval.js`

---

## New fields in API responses

List and detail APIs return these properties on each document request:

| Field | Description |
|-------|-------------|
| `manager_comment` | Manager’s comment |
| `manager_reviewed_by` | Object: `{ id, first_name, last_name, email, employee_code, role: "manager" }` |
| `manager_reviewed_at` | ISO timestamp |
| `hr_reviewed_by` | Object: `{ id, name, email, role: "admin" }` |
| `hr_reviewed_at` | Same as final `reviewed_at` |
| `review_stage` | Current review stage, if any |
| `approved_by` | Who acted last — for UI “Approved By” column |
| `employee_name`, `employee_email`, `employee_code` | Flat employee fields on HR/team lists |

**`approved_by` logic**

- `ready` → shows HR/admin reviewer
- `manager_approved` or manager-stage `rejected` → shows manager
- Otherwise → `null`

---

## API endpoints

### Employee APIs

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/` | Submit a new document request → `pending` |
| `GET` | `/my` | List own document requests |
| `PATCH` | `/:id/cancel` | Cancel while `pending` or `manager_approved` |

**Submit example**

```http
POST /api/v1/document-requests
Authorization: Bearer <token>
Content-Type: application/json

{
  "document_type": "experience_letter",
  "purpose": "Visa application",
  "addressed_to": "Embassy of UAE",
  "note": "Need on company letterhead"
}
```

---

### Line manager APIs (**NEW**)

| Method | Endpoint | Permission | Purpose |
|--------|----------|------------|---------|
| `GET` | `/team` | `documents` view | List direct reports’ document requests |
| `GET` | `/team/:id` | `documents` view | Get one team document request |
| `PATCH` | `/team/:id/status` | `documents` edit | Manager approve or reject |

**List team document requests**

```http
GET /api/v1/document-requests/team?status=pending&page=1&limit=10
Authorization: Bearer <token>
```

| Query param | Description |
|-------------|-------------|
| `status` | `pending`, `manager_approved`, `ready`, `rejected`, `cancelled` |
| `search` | Employee name, code, email, document type, purpose |
| `page`, `limit` | Pagination |

**Manager approve / reject**

```http
PATCH /api/v1/document-requests/team/:id/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "manager_approved",
  "manager_comment": "Approved — please process."
}
```

| Body field | Required | Values |
|------------|----------|--------|
| `status` | Yes | `manager_approved` or `rejected` |
| `manager_comment` | No | Max 2000 characters |

Only **`pending`** requests can be updated by a line manager.

---

### Admin / HR APIs (**UPDATED**)

| Method | Endpoint | What changed |
|--------|----------|--------------|
| `GET` | `/` | Returns `manager_approved`; new manager/approved_by fields |
| `GET` | `/:id` | Same enriched response |
| `PATCH` | `/:id/upload` | Can upload from **`pending`** or **`manager_approved`** → `ready` |
| `PATCH` | `/:id/reject` | Can reject from **`pending`** or **`manager_approved`** |
| `PATCH` | `/:id/cancel` | Employee cancel from **`pending`** or **`manager_approved`** |

**HR list example**

```http
GET /api/v1/document-requests?status=manager_approved&no_pagination=true
Authorization: Bearer <token>
```

**HR upload final document**

```http
PATCH /api/v1/document-requests/:id/upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "file_url": "https://cdn.example.com/docs/letter.pdf",
  "file_name": "experience-letter.pdf"
}
```

**HR reject**

```http
PATCH /api/v1/document-requests/:id/reject
Authorization: Bearer <token>
Content-Type: application/json

{
  "rejection_reason": "Insufficient details provided."
}
```

---

## Email notifications

| Event | Who is notified |
|-------|-----------------|
| Document request submitted | Assigned line managers + HR |
| Manager approved | Employee + HR |
| Manager rejected | Employee |
| HR upload (ready) | Employee |
| HR rejected | Employee |

---

## Dashboard

HR dashboard pending document count includes **`pending` + `manager_approved`** (action needed by HR).

---

## Frontend pages (reference)

| Role | Page | Route / tab |
|------|------|-------------|
| Employee | My Requests | `/employee/requests` — document type filter |
| Manager | Team Requests → **Document Requests** tab | `/employee-team-requests` |
| Admin | Requests → **Document** tab | `/requests/pending` |

Manager document actions use **`documents`** permission; other Team Requests tabs use **`hr_requests`**.

---

## Postman quick reference

Import environment from `postman/HRM-Local.postman_environment.json`. Set `baseUrl` and `accessToken`.

### New requests (manager)

| Name | Method | URL |
|------|--------|-----|
| List team document requests | `GET` | `{{baseUrl}}/api/v1/document-requests/team?page=1&limit=10` |
| Get team document request | `GET` | `{{baseUrl}}/api/v1/document-requests/team/:id` |
| Manager approve/reject | `PATCH` | `{{baseUrl}}/api/v1/document-requests/team/:id/status` |

**PATCH body (approve):**

```json
{
  "status": "manager_approved",
  "manager_comment": "Looks good."
}
```

**PATCH body (reject):**

```json
{
  "status": "rejected",
  "manager_comment": "Please add more detail."
}
```

### Updated requests (HR / employee)

| Name | Method | URL | Notes |
|------|--------|-----|-------|
| HR list | `GET` | `{{baseUrl}}/api/v1/document-requests?status=manager_approved` | New status filter |
| My list | `GET` | `{{baseUrl}}/api/v1/document-requests/my` | Includes manager fields |
| Upload | `PATCH` | `{{baseUrl}}/api/v1/document-requests/:id/upload` | From `pending` or `manager_approved` |
| Reject | `PATCH` | `{{baseUrl}}/api/v1/document-requests/:id/reject` | From `pending` or `manager_approved` |
| Cancel | `PATCH` | `{{baseUrl}}/api/v1/document-requests/:id/cancel` | From `pending` or `manager_approved` |

All list/detail responses now include: `manager_comment`, `manager_reviewed_by`, `manager_reviewed_at`, `review_stage`, `hr_reviewed_by`, `approved_by`.

---

## Quick checklist for integrators

1. Employee submits → `POST /api/v1/document-requests`
2. Manager lists team → `GET /api/v1/document-requests/team`
3. Manager approves → `PATCH /api/v1/document-requests/team/:id/status` with `manager_approved`
4. HR lists pending → `GET /api/v1/document-requests?status=manager_approved`
5. HR uploads file → `PATCH /api/v1/document-requests/:id/upload` → status `ready`
6. Employee downloads from My Requests when status is `ready`
