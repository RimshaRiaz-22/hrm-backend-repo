# Line Manager API Guide

Organizational setup: configure a department head, and who reports to whom on an employee.

## Overview

| Level | Rule |
|-------|------|
| **Department** | One optional **department head** (single employee) |
| **Employee** | Zero or one **primary** manager + zero or more **additional** managers |
| **Eligible managers** | All employees in the selected department **plus** the department head (even if the head belongs to another department) |
| **Top-level employee** | No managers assigned |

**Validation**

- Line managers must belong to the same company.
- An employee cannot be their own manager.
- Each manager must be a member of the employee’s department or the department head.
- Primary reporting chain cannot form a cycle.
- Leave / request approvals use `employee_line_managers` (primary and additional).

**Legacy fields** (still supported on department)

| Legacy | Maps to |
|--------|---------|
| `primary_manager_id` | `department_head_id` |
| `line_manager_ids` | First ID = department head (rest ignored) |
| `line_manager_id` on employee | Single primary assignment |
| `line_manager_id` in `employee_job_details` | Synced from employee’s primary manager |

---

## Department APIs

### Create department

**API:** `POST /v1/departments`

| Attribute | Type | Description |
|-----------|------|-------------|
| `department_head_id` | integer \| null | Department head (employee ID) |
| `primary_manager_id` | integer \| null | **Legacy alias** for `department_head_id` |
| `line_manager_ids` | integer[] | **Legacy.** First ID = department head |

**Example**

```json
{
  "company_id": 1,
  "name": "IT",
  "department_head_id": 10
}
```

---

### Update department

**API:** `PATCH /v1/departments/:departmentId`

| Attribute | Type | Description |
|-----------|------|-------------|
| `department_head_id` | integer \| null | Replace / clear department head |
| `primary_manager_id` | integer \| null | **Legacy alias** |
| `line_manager_ids` | integer[] | **Legacy.** First ID = head |

- Send `department_head_id: null` to clear the head.
- Omit head fields to keep the existing head unchanged.
- Clearing a head who is still assigned as a manager to employees in that department (and is not a member of the department) returns **409**.

---

### Get departments

**APIs**

- `GET /v1/departments?company_id=1`
- `GET /v1/departments/:departmentId?company_id=1`

**Response attributes (manager-related)**

| Attribute | Description |
|-----------|-------------|
| `department_head_id` | Department head employee ID |
| `department_head` | Head employee object (`id`, `name`, `email`, …) |
| `primary_manager_id` / `primary_manager` | Compat aliases for the head |
| `additional_manager_ids` / `additional_managers` | Always empty (compat) |
| `line_manager_ids` / `line_managers` | Compat list containing the head with `role: "head"` |

---

## Employee APIs

### Create / update employee

Inside `official`:

```json
{
  "department_id": 5,
  "line_managers": [
    { "manager_id": 10, "role": "primary" },
    { "manager_id": 11, "role": "additional" }
  ]
}
```

| Attribute | Description |
|-----------|-------------|
| `line_managers` | Array of `{ manager_id, role }` where role is `primary` or `additional` |
| `line_manager_id` | **Legacy.** Sets a single primary manager |

Changing `department_id` without sending managers keeps previous managers only if they remain eligible for the new department; otherwise they are cleared.

---

## Example: Usama → Rimsha → Fatima

1. Department Engineering with `department_head_id = Usama`.
2. Rimsha in Engineering, primary = Usama.
3. Fatima in Engineering, primary = Rimsha, additional = Usama.

Org chart (primary chain): Usama → Rimsha → Fatima.  
Approvals: Fatima’s leave is visible to Rimsha and Usama; either can approve or reject at the manager stage.

---

## Migrations

```bash
node scripts/migrate-department-head.js
```

Promotes department `primary` rows to `head` and removes department-level `additional` pool rows.
