# Org Chart API Guide

Read-only organizational chart for Company Admin. Display only — does not change approvals or reporting assignment.

## Tree model

```text
Company (company name)
  ├─ Company Admin
  │    └─ Departments (group)
  │         └─ Department → managers → primary reports (solid) / additional (dashed)
  ├─ Staff access roles (HR Manager, Marketing, …)
  │    └─ Role holders
  └─ …
```

**Edges**

- **Solid arrow** — primary line manager (`employee_line_managers.manager_role = primary`)
- **Dashed arrow** — additional line manager (`manager_role = additional`)

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/root` | Company + Departments group + staff access-role boxes |
| `GET` | `/departments` | Expand Departments group → department nodes |
| `GET` | `/departments/:departmentId/managers` | Managers for a department |
| `GET` | `/departments/:departmentId/managers/:managerId/reports` | Dept-scoped direct reports |
| `GET` | `/departments/:departmentId/unassigned` | Employees in dept with no manager |
| `GET` | `/roles/:accessRoleId/members` | People assigned to a staff access role |

Company is taken from the authenticated user (JWT / linked company). Do not pass `company_id` in the query.

## Example responses

### Root

```json
{
  "error": false,
  "message": "Org chart root fetched successfully.",
  "data": {
    "node": {
      "id": "company-1",
      "type": "company",
      "entity_id": 1,
      "label": "Acme Corp",
      "meta": { "logo_url": null, "departments_count": 2 },
      "has_children": true,
      "children_loaded": true
    },
    "children": [
      {
        "id": "dept-5",
        "type": "department",
        "entity_id": 5,
        "label": "Engineering",
        "meta": {
          "department_code": "ENG",
          "employees_count": 12,
          "managers_count": 2,
          "unassigned_count": 3
        },
        "has_children": true,
        "children_loaded": false
      }
    ]
  }
}
```

### Unassigned (sidebar)

```json
{
  "error": false,
  "data": {
    "department": { "id": 5, "name": "Engineering" },
    "unassigned_count": 2,
    "employees": [
      {
        "id": 40,
        "name": "Ali Khan",
        "email": "ali@example.com",
        "employee_no": "EMP-040",
        "designation": "Intern"
      }
    ]
  }
}
```

## Frontend

- Company Setup card **Organizational Setup** → `/org-chart`
- React Flow tree with lazy expand/collapse
- Selecting a department loads the unassigned sidebar

## Sync note

After deploying, run module sync so `org_chart` appears in Roles & Permissions:

```bash
node scripts/sync-system-modules.js
```
