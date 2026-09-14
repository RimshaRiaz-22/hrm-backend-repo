# Leave Module – API Reference

**Base URL:** `/api/v1/leaves`

## Response Format

All endpoints return the following response envelope:

```json
{
  "error": false,
  "message": "Success",
  "data": { ... }
}
```

`error` is `true` and `data` is typically `null` on failure — see each endpoint's **Error
Responses**.

> **Note:** This document contains the endpoint reference only. For implementation details
> (workflow engine, eligibility rules, state machine, data model, etc.), refer to
> [Leave Policy & Approval Workflow – Implementation Guide](./LEAVE_POLICY_APPROVAL_WORKFLOW_GUIDE.md).

## Table of Contents

1. [Leave Policies](#1-leave-policies)
2. [Approval Workflow Configuration](#2-approval-workflow-configuration)
3. [Leave Balances](#3-leave-balances)
4. [Leave Requests – Employee](#4-leave-requests--employee)
5. [Leave Requests – Team / Approver](#5-leave-requests--team--approver)
6. [Leave Requests – Company Admin](#6-leave-requests--company-admin)
7. [Status Values](#7-status-values)

---

## 1. Leave Policies

### Create Leave Policy

| Item | Value |
|---|---|
| Method | `POST` |
| Endpoint | `/api/v1/leaves/policies` |
| Access | Company Admin |

**Description**
Creates a new leave policy for the company. If created with `status: "active"`, `leave_balances`
rows are immediately granted to every currently-eligible employee for the current year.

**Request Body**
```json
{
  "name": "Parental Leaves",
  "code": "PL",
  "paid_status": "paid",
  "days_per_year": 10,
  "status": "active",
  "eligible_department_id": null,
  "eligible_designation_id": null,
  "eligible_employee_ids": [41]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Yes | Max 120 chars |
| `code` | string | Yes | Normalized to 1–20 uppercase letters/digits |
| `paid_status` | string | Yes | `paid` or `unpaid` |
| `days_per_year` | number | Yes | ≥ 0 |
| `status` | string | No | `active` (default) or `inactive` |
| `eligible_department_id` | integer | No | Restrict eligibility to a department |
| `eligible_designation_id` | integer | No | Restrict eligibility to a designation |
| `eligible_employee_ids` | integer[] | No | If provided, overrides department/designation scoping entirely |

**Success Response `201`**
```json
{
  "leave_policy": {
    "id": 7,
    "company_id": 3,
    "name": "Parental Leaves",
    "code": "PL",
    "paid_status": "paid",
    "days_per_year": 10,
    "status": "active",
    "eligible_department_id": null,
    "eligible_designation_id": null,
    "created_at": "2026-07-24T05:58:00.000Z",
    "updated_at": "2026-07-24T05:58:00.000Z"
  }
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"code must be 1–20 uppercase letters or digits (e.g. AL)."` | Invalid field(s) |
| 403 | `"Only a Company Admin can perform this action."` | Caller isn't a company admin |
| 409 | `"A leave policy with this name or code already exists for this company."` | Duplicate name/code |

---

### Bulk Import Leave Policies

| Item | Value |
|---|---|
| Method | `POST` |
| Endpoint | `/api/v1/leaves/policies/import` |
| Access | Company Admin |

**Description**
Creates up to 50 leave policies in a single atomic transaction. If any row fails validation, no
rows are saved. Imported policies get no eligibility scoping (company-wide).

**Request Body**
```json
{
  "rows": [
    { "name": "Sick Leave", "code": "SL", "paid_status": "paid", "days_per_year": 12, "status": "active" }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `rows` (or `entries`) | object[] | Yes | Max 50 rows, each shaped like the Create Leave Policy body |

**Success Response `201`**
```json
{
  "created": [
    { "id": 8, "name": "Sick Leave", "code": "SL", "paid_status": "paid", "days_per_year": 12, "status": "active", "...": "..." }
  ],
  "created_count": 1
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"rows must be a non-empty array."` | Missing/empty `rows` |
| 400 | `"Maximum 50 leave policies per import request."` | Too many rows |
| 400 | `"Import rejected: 1 invalid row(s). No rows were saved."` with `data: { errors: [{ row_index, reason }], valid_count, invalid_count }` | One or more rows invalid |

---

### Get All Leave Policies

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/policies` |
| Access | Company Admin |

**Description**
Lists all leave policies for the company, with filtering, sorting, and pagination.

**Query Parameters**

| Parameter | Description |
|---|---|
| `status` | `active` / `inactive` |
| `paid_status` | `paid` / `unpaid` |
| `search` | Matches name or code |
| `created_from` | `YYYY-MM-DD`, inclusive |
| `created_to` | `YYYY-MM-DD`, inclusive |
| `sort_by` | `created_at` |
| `sort_order` | `asc` / `desc` |
| `page`, `limit` | Pagination |
| `no_pagination` | `true` to return all matching rows |

**Success Response `200`**
```json
{
  "leave_policies": [
    { "id": 7, "name": "Parental Leaves", "code": "PL", "paid_status": "paid", "days_per_year": 10, "status": "active", "...": "..." }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 7, "total_pages": 1 },
  "sort": { "sort_by": "created_at", "sort_order": "desc" },
  "filters": { "status": null, "paid_status": null, "search": null, "created_from": null, "created_to": null }
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"status filter must be one of: active, inactive."` | Invalid `status` |
| 400 | `"created_to cannot be before created_from."` | Invalid date range |

---

### Get Leave Policy by ID

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/policies/:id` |
| Access | Company Admin |

**Description**
Returns a single policy's details, including its resolved eligible employees/department/designation names.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave policy ID |

**Success Response `200`**
```json
{
  "leave_policy": {
    "id": 7,
    "name": "Parental Leaves",
    "code": "PL",
    "paid_status": "paid",
    "days_per_year": 10,
    "status": "active",
    "eligible_department_id": null,
    "eligible_designation_id": null,
    "eligible_department_name": null,
    "eligible_designation_name": null,
    "eligible_employee_ids": [41],
    "eligible_employees": [
      { "id": 41, "name": "employee four", "email": "employee4@gmail.com" }
    ]
  }
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"Leave policy id must be a positive integer."` | Invalid `id` |
| 404 | `"Leave policy not found."` | Doesn't exist / wrong company |

---

### Update Leave Policy

| Item | Value |
|---|---|
| Method | `PATCH` |
| Endpoint | `/api/v1/leaves/policies/:id` |
| Access | Company Admin |

**Description**
Updates a policy. Any subset of the create fields may be sent. Changing eligibility re-grants or
prunes `leave_balances` for the affected employees. Setting `status` to `inactive` **freezes**
existing balances (`total_days = used_days`, `available_days = 0`) rather than deleting them.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave policy ID |

**Request Body**
```json
{ "days_per_year": 12, "status": "inactive" }
```
Same fields/validation as Create Leave Policy — all optional.

**Success Response `200`**
```json
{ "leave_policy": { "id": 7, "days_per_year": 12, "status": "inactive", "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"days_per_year must be a number greater than or equal to 0."` | Invalid field |
| 404 | `"Leave policy not found."` | Doesn't exist |
| 409 | `"A leave policy with this name or code already exists for this company."` | Duplicate name/code |

---

### Delete Leave Policy

| Item | Value |
|---|---|
| Method | `DELETE` |
| Endpoint | `/api/v1/leaves/policies/:id` |
| Access | Company Admin |

**Description**
Deletes a policy and its balances. Blocked if any leave requests have ever been submitted against
it. Deleting cascades to `leave_policy_approval_steps` and `leave_policy_eligible_employees`.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave policy ID |

**Success Response `200`**
```json
{ "leave_policy": { "id": 7, "name": "Parental Leaves", "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave policy not found."` | Doesn't exist |
| 409 | `"This leave policy cannot be deleted because leave requests have been submitted against it."` | Requests exist |

---

### Get My Leave Policies

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/policies/me` |
| Access | Employee |

**Description**
Lists the authenticated employee's eligible, currently **active** leave policies.

**Query Parameters**

| Parameter | Description |
|---|---|
| `search` | Matches name or code |
| `page`, `limit` | Pagination |

**Success Response `200`**
```json
{
  "leave_policies": [ { "id": 7, "name": "Parental Leaves", "code": "PL", "...": "..." } ],
  "pagination": { "...": "..." },
  "sort": { "...": "..." },
  "filters": { "...": "..." }
}
```

---

### Get My Leave Policy by ID

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/policies/me/:id` |
| Access | Employee |

**Description**
Returns a single policy only if it's `active` **and** the authenticated employee is eligible for it.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave policy ID |

**Success Response `200`**
```json
{ "leave_policy": { "id": 7, "name": "Parental Leaves", "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave policy not found."` | Not active, not eligible, or doesn't exist |

---

## 2. Approval Workflow Configuration

### Get Approval Workflow

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/policies/:id/approval-steps` |
| Access | Company Admin |

**Description**
Returns the configured approval workflow for the selected leave policy. An empty array means the
default flow applies (line manager → Company Admin). Where possible, each step also includes
`resolved_approvers` — real names/emails currently matching that step, for a live preview in the
config UI.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave policy ID |

**Success Response `200`**
```json
{
  "approval_steps": [
    {
      "id": 12,
      "step_order": 1,
      "approver_type": "user",
      "access_role_id": null,
      "access_role_name": null,
      "approver_user_id": 9,
      "approver_user_name": "employee two",
      "approver_user_email": "employee02@gmail.com"
    },
    {
      "id": 13,
      "step_order": 2,
      "approver_type": "access_role",
      "access_role_id": 2,
      "access_role_name": "Company Admin",
      "approver_user_id": null,
      "approver_user_name": null,
      "approver_user_email": null,
      "resolved_approvers": [
        {
          "employee_id": null,
          "employee_name": null,
          "approvers": [ { "user_id": 1, "name": "John Doe", "email": "companyadmin@gmail.com" } ]
        }
      ]
    }
  ]
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave policy not found."` | Doesn't exist |

---

### Update Approval Workflow

| Item | Value |
|---|---|
| Method | `PUT` |
| Endpoint | `/api/v1/leaves/policies/:id/approval-steps` |
| Access | Company Admin |

**Description**
Replaces the entire approval chain for the policy (replace-all, not incremental). Array order
determines step order. Sending an empty array reverts the policy to the default flow.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave policy ID |

**Request Body**
```json
{
  "approval_steps": [
    { "approver_type": "primary_manager" },
    { "approver_type": "access_role", "access_role_id": 2 },
    { "approver_type": "user", "approver_user_id": 9 }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `approval_steps` | object[] | Yes | Max 10 steps |
| `approval_steps[].approver_type` | string | Yes | `primary_manager` \| `additional_manager` \| `department_head` \| `access_role` \| `user` |
| `approval_steps[].access_role_id` | integer | Only for `access_role` | Must belong to the company |
| `approval_steps[].approver_user_id` | integer | Only for `user` | Must be an active user in the company |

**Success Response `200`**
Same shape as *Get Approval Workflow*.

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"Step 2: access_role_id does not belong to your company."` | Invalid reference |
| 400 | `"Step 3: approver_user_id does not belong to your company or is inactive."` | Invalid reference |
| 400 | `"Maximum 10 approval steps."` | Too many steps |
| 404 | `"Leave policy not found."` | Doesn't exist |

---

## 3. Leave Balances

### Get My Leave Balances

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/balances/me` |
| Access | Employee |

**Description**
Returns the authenticated employee's own leave balances as a flat list.

**Query Parameters**

| Parameter | Description |
|---|---|
| `year` | Defaults to current year |
| `leave_policy_id` | Filter to one policy |
| `search` | Matches policy name/code |
| `page`, `limit` | Pagination |

**Success Response `200`**
```json
{
  "year": 2026,
  "leave_balances": [
    {
      "id": 55,
      "employee_id": 41,
      "leave_policy_id": 7,
      "leave_policy": { "id": 7, "name": "Parental Leaves", "code": "PL", "paid_status": "paid" },
      "year": 2026,
      "total_days": 10,
      "used_days": 2,
      "available_days": 8,
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "pagination": { "...": "..." },
  "sort": { "...": "..." },
  "filters": { "year": 2026, "leave_policy_id": null, "search": null }
}
```

---

### Get All Leave Balances

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/balances` |
| Access | Company Admin |

**Description**
Returns company-wide leave balances, **grouped by employee** (not a flat row list).

**Query Parameters**

| Parameter | Description |
|---|---|
| `year` | Defaults to current year |
| `employee_id` | Filter to one employee |
| `leave_policy_id` | Filter to one policy |
| `search` | Matches employee/policy fields |
| `page`, `limit` | Pagination (paginates by employee) |

**Success Response `200`**
```json
{
  "employees": [
    {
      "employee_id": 41,
      "employee": { "id": 41, "employee_code": "EMP004", "first_name": "employee", "last_name": "four", "email": "employee4@gmail.com" },
      "leave_policies": [
        { "id": 55, "leave_policy_id": 7, "leave_policy": { "...": "..." }, "year": 2026, "total_days": 10, "used_days": 2, "available_days": 8 }
      ]
    }
  ],
  "pagination": { "...": "..." },
  "sort": { "...": "..." },
  "filters": { "year": 2026, "employee_id": null, "leave_policy_id": null, "search": null }
}
```

---

### Get Leave Balance by ID

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/balances/:id` |
| Access | Company Admin |

**Description**
Returns a single balance row, including employee details.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave balance ID |

**Success Response `200`**
```json
{ "leave_balance": { "id": 55, "employee": { "...": "..." }, "total_days": 10, "used_days": 2, "available_days": 8, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave balance not found."` | Doesn't exist |

---

### Update Leave Balance

| Item | Value |
|---|---|
| Method | `PATCH` |
| Endpoint | `/api/v1/leaves/balances/:id` |
| Access | Company Admin |

**Description**
Manually adjusts a balance. `available_days` is always recomputed server-side as
`total_days - used_days` — it cannot be set directly.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave balance ID |

**Request Body**
```json
{ "total_days": 12, "used_days": 3 }
```
Either or both fields. `used_days` cannot exceed `total_days`.

**Success Response `200`**
```json
{ "leave_balance": { "id": 55, "total_days": 12, "used_days": 3, "available_days": 9, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"Provide total_days and/or used_days to update."` | Empty body |
| 400 | `"used_days cannot be greater than total_days."` | Invalid values |
| 404 | `"Leave balance not found."` | Doesn't exist |

---

### Delete Leave Balance

| Item | Value |
|---|---|
| Method | `DELETE` |
| Endpoint | `/api/v1/leaves/balances/:id` |
| Access | Company Admin |

**Description**
Deletes a balance row.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave balance ID |

**Success Response `200`**
```json
{ "leave_balance": { "id": 55, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave balance not found."` | Doesn't exist |

---

## 4. Leave Requests – Employee

### Submit Leave Request

| Item | Value |
|---|---|
| Method | `POST` |
| Endpoint | `/api/v1/leaves/requests` |
| Access | Employee |

**Description**
Submits a leave request for the authenticated employee against an active, eligible policy. On
success, the policy's currently configured approval steps (if any) are snapshotted onto the
request, and notification emails go to the employee, company admin/HR, and line manager.

**Request Body**
```json
{
  "leave_policy_id": 7,
  "from_date": "2026-08-01",
  "to_date": "2026-08-05",
  "reason": "Family event"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `leave_policy_id` | integer | Yes | Must be active and the employee eligible |
| `from_date` | date | Yes | `YYYY-MM-DD` |
| `to_date` | date | No | Defaults to `from_date` |
| `reason` | string | Yes | Max 1000 chars |

**Success Response `201`**
```json
{
  "leave_request": {
    "id": 101,
    "employee_id": 41,
    "leave_policy_id": 7,
    "leave_policy": { "id": 7, "name": "Parental Leaves", "code": "PL", "paid_status": "paid" },
    "from_date": "2026-08-01",
    "to_date": "2026-08-05",
    "total_days": 5,
    "reason": "Family event",
    "status": "pending",
    "manager_comment": null,
    "hr_comment": null,
    "manager_reviewed_by": null,
    "manager_reviewed_at": null,
    "hr_reviewed_by": null,
    "hr_reviewed_at": null,
    "approved_by": null,
    "approval_progress": { "total_steps": 2, "current_step_order": 1, "current_step_description": "employee two" },
    "created_at": "...",
    "updated_at": "..."
  }
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"to_date cannot be before from_date."` | Invalid date range |
| 400 | `"This leave policy is not active."` | Policy inactive |
| 404 | `"Leave policy not found."` | Doesn't exist / not eligible |
| 409 | `"You already have a pending or approved leave request overlapping these dates."` | Date overlap |

---

### Get My Leave Requests

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/requests/me` |
| Access | Employee |

**Description**
Lists the authenticated employee's own requests.

**Query Parameters**

| Parameter | Description |
|---|---|
| `status` | `pending` / `manager_approved` / `approved` / `rejected` / `cancelled` |
| `from_date`, `to_date` | Date range filter |
| `search` | Matches reason/policy fields |
| `sort_by` | `created_at` / `from_date` / `status` |
| `sort_order` | `asc` / `desc` |
| `page`, `limit` | Pagination |

**Success Response `200`**
```json
{
  "leave_requests": [ { "id": 101, "status": "pending", "...": "..." } ],
  "pagination": { "...": "..." },
  "sort": { "...": "..." },
  "filters": { "...": "..." }
}
```

---

### Get My Leave Request by ID

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/requests/me/:id` |
| Access | Employee |

**Description**
Returns a single request owned by the authenticated employee.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave request ID |

**Success Response `200`**
```json
{ "leave_request": { "id": 101, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave request not found."` | Doesn't exist / not owned by caller |

---

### Cancel My Leave Request

| Item | Value |
|---|---|
| Method | `PATCH` |
| Endpoint | `/api/v1/leaves/requests/me/:id/cancel` |
| Access | Employee |

**Description**
Cancels the caller's own request. Allowed only while `pending` or `manager_approved`.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave request ID |

**Success Response `200`**
```json
{ "leave_request": { "id": 101, "status": "cancelled", "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"Only pending or manager-approved leave requests can be cancelled. This request is already approved."` | Already finalized |
| 404 | `"Leave request not found."` | Doesn't exist |

---

## 5. Leave Requests – Team / Approver

### Get Team Leave Requests

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/requests/team` |
| Access | Employee (must be a resolved approver for at least one request) |

**Description**
Lists requests the logged-in user can currently act on, or has already acted on. This includes:
direct reports (legacy flow with no configured workflow), the resolved approver of the current
pending workflow step, and anyone who already acted on an earlier step (kept visible, read-only).

**Query Parameters**

| Parameter | Description |
|---|---|
| `status` | Filter by status |
| `leave_policy_id` | Filter by policy |
| `search` | Matches employee/policy/reason fields |
| `sort_by`, `sort_order` | Sorting |
| `page`, `limit` | Pagination |

**Success Response `200`**
```json
{
  "leave_requests": [
    {
      "id": 101,
      "employee": { "id": 41, "employee_code": "EMP004", "first_name": "employee", "last_name": "four", "email": "employee4@gmail.com" },
      "status": "pending",
      "approval_progress": { "total_steps": 2, "current_step_order": 1, "current_step_description": "employee two" },
      "is_actionable_by_me": true,
      "...": "..."
    }
  ],
  "pagination": { "...": "..." },
  "sort": { "...": "..." },
  "filters": { "...": "..." }
}
```

---

### Get Team Leave Request by ID

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/requests/team/:id` |
| Access | Employee (must be a resolved approver, or have already acted) |

**Description**
Same visibility rule as the team list, for a single request.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave request ID |

**Success Response `200`**
```json
{ "leave_request": { "id": 101, "is_actionable_by_me": true, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave request not found."` | Doesn't exist / caller has no access |

---

### Update Team Leave Request Status

| Item | Value |
|---|---|
| Method | `PATCH` |
| Endpoint | `/api/v1/leaves/requests/team/:id/status` |
| Access | Employee (must be the resolved approver of the current step) |

**Description**
Acts on the request's current pending step. Works for the legacy single manager step **and**
every step of a configured multi-step workflow, including the final one — approving the final
step fully approves the request and deducts the leave balance.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave request ID |

**Request Body**
```json
{ "status": "manager_approved", "manager_comment": "Looks good" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | Yes | `manager_approved` (= approve) or `rejected` |
| `manager_comment` | string | No | Max 1000 chars |

**Success Response `200`**
```json
{ "leave_request": { "id": 101, "status": "approved", "approval_progress": { "...": "..." }, "is_actionable_by_me": false, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"Only pending or manager-approved leave requests can be updated. This request is already rejected."` | Already finalized |
| 404 | `"Leave request not found."` | Doesn't exist, or it's not currently the caller's turn |

---

## 6. Leave Requests – Company Admin

### Get All Leave Requests

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/requests` |
| Access | Company Admin |

**Description**
Lists all leave requests across the company.

**Query Parameters**

| Parameter | Description |
|---|---|
| `status` | Filter by status |
| `employee_id` | Filter by employee |
| `leave_policy_id` | Filter by policy |
| `search` | Matches employee/policy fields |
| `sort_by`, `sort_order` | Sorting |
| `page`, `limit` | Pagination |

**Success Response `200`**
```json
{
  "leave_requests": [ { "id": 101, "employee": { "...": "..." }, "status": "pending", "...": "..." } ],
  "pagination": { "...": "..." },
  "sort": { "...": "..." },
  "filters": { "...": "..." }
}
```

---

### Get Leave Request by ID

| Item | Value |
|---|---|
| Method | `GET` |
| Endpoint | `/api/v1/leaves/requests/:id` |
| Access | Company Admin |

**Description**
Returns a single request, company-admin view.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave request ID |

**Success Response `200`**
```json
{ "leave_request": { "id": 101, "employee": { "...": "..." }, "...": "..." } }
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 404 | `"Leave request not found."` | Doesn't exist |

---

### Update Leave Request Status (Admin Override)

| Item | Value |
|---|---|
| Method | `PATCH` |
| Endpoint | `/api/v1/leaves/requests/:id/status` |
| Access | Company Admin |

**Description**
Company Admin override. Always available on `pending`/`manager_approved` requests regardless of
any configured workflow's remaining steps — any still-pending steps are marked `skipped` first,
then the decision is applied directly. Approving deducts the leave balance.

**Request Parameters**

| Parameter | In | Description |
|---|---|---|
| `id` | Path | Leave request ID |

**Request Body**
```json
{ "status": "approved", "hr_comment": "Confirmed with team" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | Yes | `approved` \| `rejected` \| `cancelled` |
| `hr_comment` | string | No | Max 1000 chars |

**Success Response `200`**
```json
{
  "leave_request": {
    "id": 101,
    "status": "approved",
    "hr_reviewed_by": { "id": 1, "name": "John Doe", "email": "companyadmin@gmail.com", "role": "admin" },
    "...": "..."
  }
}
```

**Error Responses**

| Status | Message | Cause |
|---|---|---|
| 400 | `"Only pending or manager-approved leave requests can be updated. This request is already cancelled."` | Already finalized |
| 404 | `"Leave request not found."` | Doesn't exist |

---

## 7. Status Values

| Status | Meaning |
|---|---|
| Pending | Request submitted and awaiting approval |
| Manager Approved | Workflow in progress — at least one step cleared, more remain (or the legacy manager step cleared, awaiting admin) |
| Approved | Fully approved — leave balance deducted |
| Rejected | Rejected at some step (manager, a configured approver, or admin) |
| Cancelled | Cancelled by the employee or an admin, while still pending/manager-approved |
