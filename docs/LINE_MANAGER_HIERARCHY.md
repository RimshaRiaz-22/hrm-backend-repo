# Line Manager Hierarchy (Developer Guide)

Org-chart / reporting display only (v1). Does **not** route leave or request approvals.

## Model

| Piece | Storage | Rule |
|-------|---------|------|
| Eligible managers for a department | `department_line_managers` | Many employees per department; picked from **any** company employee |
| Employee’s manager | `employee_job_details.line_manager_id` | Optional; **one** manager; must be eligible for the employee’s `department_id` |

```text
Company
  └─ Department
       └─ department_line_managers (eligible: Usama, Rimsha, …)
  └─ Employee (job details)
       ├─ department_id → Department
       └─ line_manager_id → one eligible manager (or null for CEO / top-level)
```

### Schema (`src/db/init.sql`)

- `department_line_managers(company_id, department_id, employee_id, …)` with `UNIQUE(department_id, employee_id)` and cascade deletes.
- `employee_job_details.line_manager_id BIGINT NULL REFERENCES employees(id) ON DELETE SET NULL`.

## Example: Usama → Rimsha → Fatima

1. **Leadership** department: eligible managers `[Usama]`.
2. **Engineering** department: eligible managers `[Usama, Rimsha]`.
3. Create **Usama** in Leadership, `line_manager_id` omitted / null.
4. Create **Rimsha** in Engineering, `line_manager_id = Usama`.
5. Create **Fatima** in Engineering, `line_manager_id = Rimsha`.

Tree: Usama → Rimsha → Fatima.

## Department API

### Payloads

```json
POST /api/v1/departments
{
  "company_id": 1,
  "name": "Engineering",
  "line_manager_ids": [10, 11]
}
```

```json
PATCH /api/v1/departments/:id
{
  "company_id": 1,
  "line_manager_ids": [10]
}
```

| `line_manager_ids` on PATCH | Behavior |
|-----------------------------|----------|
| omitted | Keep existing mappings |
| `[]` | Clear all eligible managers (blocked if any employee still reports to one of them in this department) |
| `[…]` | Replace set atomically with department row |

### Responses

List / detail / create / update include:

```json
{
  "department": {
    "id": 5,
    "name": "Engineering",
    "line_manager_ids": [10, 11],
    "line_managers": [
      {
        "id": 10,
        "name": "Usama Khan",
        "employee_no": "EMP-001",
        "department": "Leadership",
        "designation": "CEO"
      }
    ]
  }
}
```

### Validation

- Array of **unique positive integers**.
- Every id must belong to the same company.
- New selections prefer **active** employees (`users.is_active`).
- Removing a manager who is still `line_manager_id` for someone in that department → **409** with a clear message (no silent clear).
- Saves department + mappings in one DB transaction; department cache is invalidated as before.

## Employee API

### Payloads

```json
POST /api/v1/employees
{
  "personal": { "first_name": "Fatima", "last_name": "Ali", "...": "..." },
  "official": {
    "department_id": 5,
    "line_manager_id": 11
  }
}
```

| `official.line_manager_id` | Create | PATCH |
|----------------------------|--------|-------|
| omitted | null | preserve |
| `null` / `""` | clear | clear |
| positive int | set (after employee id exists) | set |

### Department change without new manager

If `department_id` changes and `line_manager_id` is **not** sent: keep the previous manager only if they remain in `department_line_managers` for the new department; otherwise clear to `null` (same transaction).

### Validation

- Same company as the employee.
- Present in `department_line_managers` for the employee’s department.
- Not self (`line_manager_id !== employee_id`).
- No reporting cycle (walk manager chain; Usama cannot report to Fatima if Fatima → Rimsha → Usama).
- Self/cycle checks run **after** INSERT on create (employee id must exist).

### Responses

Detail / nested `official` (and list `official`) include:

```json
{
  "line_manager_id": "11",
  "line_manager_name": "Rimsha Ahmed",
  "line_manager": {
    "id": "11",
    "name": "Rimsha Ahmed",
    "employee_no": "EMP-002"
  }
}
```

## Unit tests

Pure helpers live in `src/services/lineManager.service.js`.

```bash
node --test test/lineManager.service.test.js
```

No live DB required for those tests.
