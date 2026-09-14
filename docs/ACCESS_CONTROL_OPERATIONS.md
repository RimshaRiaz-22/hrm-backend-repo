..# Access Control (RBAC) — Operations & Testing Guide

This guide covers how to run, verify, and manually test the **Dynamic Roles & Permissions** module in the HRM backend and frontend.

---

## What this module does

- **Access roles** are company-defined permission profiles (separate from job-title **job roles** at `/api/v1/job-roles`).
- Each module supports four actions: `view`, `add`, `edit`, `delete`.
- On login, the API returns a `permissions` object the UI uses to show/hide navigation and gate actions.
- **`super_admin`** always has full access.
- **`company_admin`** still bypasses permission checks during the transition period (legacy bypass).
- All other users are enforced via their assigned **access role**.

### Database tables

| Table | Purpose |
|-------|---------|
| `system_modules` | Catalog of permissionable modules (~39 keys) |
| `access_roles` | Company-specific roles (4 defaults per company) |
| `access_role_permissions` | Permission matrix per role |
| `users.access_role_id` | Links each user to an access role |

### Default roles (seeded per company)

| Role | Typical legacy `users.role` mapping | Permissions |
|------|-------------------------------------|-------------|
| Company Admin | `company_admin` | All modules, all actions |
| HR Manager | `admin`, `hr`, `manager` | All modules, no `delete` |
| Department Manager | `department_manager` | HR + team modules, no `delete` |
| Employee | `employee` | Self-service modules only |

---

## Prerequisites

1. **PostgreSQL** — connection configured in `.env` (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
2. **Node.js** — install dependencies at repo root and in `front-end/`.
3. **Redis** (optional) — permission cache; app falls back to DB if Redis is unavailable.
4. **JWT** — `JWT_SECRET` must be set in `.env`.

```bash
# Backend
npm install

# Frontend
cd front-end && npm install
```

---

## One-time setup: run the migration

From the **backend root**:

```bash
npm run migrate:access-control
```

This script:

1. Creates RBAC tables (if missing).
2. Seeds `system_modules`.
3. Creates 4 default access roles for every existing company.
4. Backfills `users.access_role_id` from legacy `users.role`.

**Expected output** (approximate for 61 companies):

```
Migration OK: access control ready
{ modules: 39, roles: 244, permissions: 5978, users_with_access_role: 391 }
```

### Verify migration

```bash
node scripts/check-access-control.js
```

You should see all three RBAC tables listed and non-zero counts.

### Re-run safety

The migration is idempotent for schema and module seeding. Re-running on an already-migrated DB is safe; it will skip existing data where appropriate.

### Troubleshooting a stuck migration

If migration hangs on `Applying access-control schema...` or `CREATE TABLE`:

1. A previous run may have left an **idle-in-transaction** session holding locks.
2. Check blocking sessions (optional): `node scripts/check-db-locks.js` (if present).
3. Terminate stale backend PIDs: edit `STALE_PIDS` in `scripts/terminate-stale-db-session.js`, then:

```bash
node scripts/terminate-stale-db-session.js
npm run migrate:access-control
```

---

## Starting the system

### Backend (port 3002 by default)

```bash
# From repo root
npm run dev
```

API base: `http://localhost:3002/api`

### Frontend (port 5173 by default)

```bash
cd front-end
npm run dev
```

Ensure `front-end/src/urls.jsx` points at your backend:

```js
export const BASE_URL = 'http://localhost:3002/api';
```

> **Note:** `front-end/src/vite.config.js` proxies `/api` to port `5000`. If you use the Vite proxy instead of `urls.jsx`, align the proxy target with your backend port.

---

## UI testing checklist

### 1. Login and inspect permissions

1. Open `http://localhost:5173` and log in as a **company admin** (or any user with an access role).
2. Open browser DevTools → **Application** → **Local Storage**.
3. Confirm `permissions` is stored (JSON map of `module_key → { view, add, edit, delete }`).
4. Confirm the login/profile response includes:
   - `permissions`
   - `access_role_id`
   - `access_role_name`

### 2. Sidebar navigation filtering

- Users with **HR dashboard** permission see the admin sidebar (Dashboard, Employees, etc.).
- Users with only **employee dashboard** permission see the employee portal nav.
- **Super admin** sees everything.
- Nav items without `view` permission on their `moduleKey` are hidden (`filterNavByPermissions` in `front-end/src/lib/permissions.js`).

### 3. Roles & Permissions page

| URL | Action |
|-----|--------|
| `/access-roles` | List company access roles |
| `/access-roles/new` | Create role (2-step wizard: name → permission grid) |
| `/access-roles/:id/edit` | Edit existing role |

**Who can access:** Company Admin, Super Admin, or any user whose access role grants `access_roles.view`.

**Test flow:**

1. Log in as company admin → sidebar should show **Roles & Permissions**.
2. Create a custom role (e.g. "Payroll Viewer") with only `payroll_settings.view`.
3. Assign that role to a test user (see [Not yet implemented](#not-yet-implemented) for employee assignment UI).
4. Log in as that user → payroll nav items appear; admin-only items are hidden.

### 4. Permission enforcement on API (departments)

**Departments** is the first fully enforced module. Test with a user who lacks `departments.view`:

```http
GET /api/v1/departments
Authorization: Bearer <token>
```

Expected: `403` with message like `You do not have permission to view departments.`

Repeat for `POST /api/v1/departments` (`add`), `PATCH` (`edit`), `DELETE` (`delete`).

---

## API testing (curl / Postman)

Base URL: `http://localhost:3002/api/v1`

### Login

```http
POST /auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "your-password"
}
```

Save `accessToken` from the response. Also note `permissions`, `access_role_id`, and `access_role_name`.

### Profile / refresh permissions

```http
GET /auth/profile
Authorization: Bearer <accessToken>
```

Alias: `GET /auth/me`

### List system modules

```http
GET /access-roles/system-modules
Authorization: Bearer <accessToken>
```

### List access roles

```http
GET /access-roles
Authorization: Bearer <accessToken>
```

Optional query: `?search=HR&page=1&limit=20`

### Get one role (with permission matrix)

```http
GET /access-roles/:id
Authorization: Bearer <accessToken>
```

### Create access role

```http
POST /access-roles
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "Custom Reviewer",
  "description": "Can view employees and leave requests"
}
```

Then save permissions:

```http
PUT /access-roles/:id/permissions
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "permissions": {
    "employees": { "view": true, "add": false, "edit": false, "delete": false },
    "leave_requests": { "view": true, "add": false, "edit": true, "delete": false }
  }
}
```

### Update / delete role

```http
PATCH /access-roles/:id
DELETE /access-roles/:id
```

### Job roles vs access roles

| Concept | API path | Purpose |
|---------|----------|---------|
| Job role (title) | `/api/v1/job-roles` | Employee job title / designation role |
| Access role | `/api/v1/access-roles` | Login permissions (RBAC) |

---

## Permission payload shape

Login and profile return permissions like:

```json
{
  "permissions": {
    "employees": { "view": true, "add": true, "edit": true, "delete": false },
    "departments": { "view": true, "add": true, "edit": true, "delete": true },
    "access_roles": { "view": true, "add": true, "edit": true, "delete": true }
  },
  "access_role_id": 12,
  "access_role_name": "Company Admin"
}
```

Frontend check:

```js
import { can } from '@/lib/permissions.js';

can(permissions, 'employees', 'edit'); // true/false
```

---

## Enforcement status (current)

| Area | Status |
|------|--------|
| Login / profile `permissions` payload | Done |
| Access roles CRUD API | Done |
| Default roles on company create | Done |
| Frontend nav filtering | Done |
| Frontend Roles & Permissions UI | Done |
| **Departments** routes | Enforced |
| **Attendance** routes | Partially secured (public endpoints removed) |
| Remaining ~35 route files | Not yet enforced |
| Employee `access_role_id` on create/invite | Not yet implemented |
| Employee access role dropdown (Add Employee) | Not yet implemented |

During transition, `company_admin` users bypass `requireModulePermission` on the backend. Remove this bypass once all routes are migrated.

---

## Not yet implemented

These are planned but not wired yet:

- Selecting **access role** when creating or inviting an employee.
- Showing access role on employee profile.
- Permission middleware on all remaining API routes.
- Frontend `<Can module action>` component for button-level gating.
- Full replacement of legacy `canAdmin*(userRole)` checks.

Until employee assignment is built, change a user's access role directly in the DB:

```sql
-- Find roles for a company
SELECT id, name FROM access_roles WHERE company_id = 1;

-- Assign role to user
UPDATE users SET access_role_id = 5 WHERE email = 'test@example.com';
```

After updating, the user must **log out and log back in** (or call `/auth/profile`) to refresh cached permissions.

---

## New company onboarding

When a company is created via the API, default access roles are seeded automatically (`seedCompanyDefaultRoles`). No manual migration step is needed for new companies after the initial DB migration.

---

## Useful scripts

| Command | Purpose |
|---------|---------|
| `npm run migrate:access-control` | Run RBAC migration |
| `node scripts/check-access-control.js` | Verify table counts |
| `node scripts/terminate-stale-db-session.js` | Kill stuck DB sessions blocking DDL |

---

## Quick smoke test (5 minutes)

1. `node scripts/check-access-control.js` — counts look healthy.
2. `npm run dev` (backend) + `cd front-end && npm run dev` (frontend).
3. Login as company admin → **Roles & Permissions** visible in sidebar.
4. Create a test role with limited permissions.
5. `GET /auth/profile` — confirm `permissions` reflects the logged-in user's role.
6. `GET /api/v1/departments` with a low-permission user token — expect `403` if `departments.view` is false.

---

## Related files

| File | Description |
|------|-------------|
| `scripts/migrate-access-control.js` | Migration script |
| `src/services/accessControl.service.js` | Permission resolver + Redis cache |
| `src/services/accessRoles.service.js` | Role CRUD |
| `src/middleware/auth.middleware.js` | `attachPermissions`, `requireModulePermission` |
| `src/constants/systemModules.seed.js` | Module catalog |
| `src/constants/accessRoleTemplates.js` | Default role templates |
| `front-end/src/lib/permissions.js` | Frontend permission helpers |
| `front-end/src/pages/AdminPages/CompanyAdmin/AccessRoles/` | Roles UI |
