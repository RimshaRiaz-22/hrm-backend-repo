# Roles and Permissions — Simple Developer Guide

## How it works

1. Company Admin creates an access role from **Roles & Permissions**.
2. Company Admin selects which modules the role can:
   - view
   - add
   - edit
   - delete
3. Company Admin assigns the access role while creating or editing an employee.
4. The role ID is saved in:

```text
users.access_role_id
```

5. When the employee logs in, the backend finds the assigned role and returns its permissions.
6. The frontend stores the permissions and uses them to show or hide modules, pages, and actions.
7. The backend checks the same permissions before allowing protected API operations.

## Important difference

`role_id` and `access_role_id` are different:

- `role_id` is the employee's job role.
- `access_role_id` controls application permissions.

Always use `access_role_id` for module access.

## Creating and configuring a role

Use the Access Roles APIs to:

- Get the available system modules.
- Create an access role.
- Save its permission matrix.
- Update or delete the role.

The system-module response provides:

```json
{
  "module_key": "employees",
  "label": "Employees",
  "category": "Main Modules"
}
```

Use `module_key` when saving or checking a permission.

Example saved permission:

```json
{
  "employees": {
    "view": true,
    "add": true,
    "edit": false,
    "delete": false
  }
}
```

New custom roles start with all permissions disabled.

## Assigning the role to an employee

The Add/Edit Employee request sends:

```json
{
  "official": {
    "access_role_id": 286
  }
}
```

The backend checks that the role belongs to the same company and saves it on the employee's user account.

Employee list/details return:

```json
{
  "access_role_id": "286",
  "access_role_name": "Employee"
}
```

## Login response

The login API returns:

```json
{
  "token": "<jwt>",
  "user": {
    "id": 467,
    "role": "employee",
    "company_id": "85",
    "access_role_id": 286,
    "access_role_name": "Employee"
  },
  "permissions": {
    "employee_dashboard": {
      "view": true,
      "add": false,
      "edit": false,
      "delete": false
    },
    "attendance": {
      "view": true,
      "add": true,
      "edit": false,
      "delete": false
    }
  }
}
```

The JWT remains small. Permissions are returned separately in the response.

The profile API returns the same important attributes:

```text
user.access_role_id
user.access_role_name
permissions
```

Use the profile API to refresh permissions after a role change.

## Frontend storage

The frontend stores these login attributes in Redux and `localStorage.authAccessData`:

```text
token
user
permissions
```

Permission format:

```text
permissions[moduleKey][action]
```

Example:

```js
permissions.employees.view
permissions.employees.add
permissions.employees.edit
permissions.employees.delete
```

## Showing modules

Every navigation item has a `moduleKey`:

```js
{
  label: 'Employees',
  path: '/employees',
  moduleKey: 'employees'
}
```

The module is shown only when:

```js
permissions.employees.view === true
```

If a navigation group has no permitted children, the complete group is hidden.

## Protecting pages

Use `PermissionRoute`:

```jsx
<PermissionRoute moduleKey="employees" action="view" portal="admin">
  <EmployeeManagement />
</PermissionRoute>
```

If permission is missing, the user is redirected to an allowed page.

## Showing action buttons

Use `check(moduleKey, action)`:

```jsx
const { check } = usePermissions();

{check('employees', 'add') ? (
  <Button>Add Employee</Button>
) : null}
```

Examples:

```js
check('employees', 'view');
check('employees', 'add');
check('employees', 'edit');
check('employees', 'delete');
```

## Backend protection

Backend routes use the same module key and action:

```js
router.get('/', ...protect('employees', 'view'), controller.list);
router.post('/', ...protect('employees', 'add'), controller.create);
router.patch('/:id', ...protect('employees', 'edit'), controller.update);
router.delete('/:id', ...protect('employees', 'delete'), controller.remove);
```

The backend checks:

1. The JWT is valid.
2. The user exists and is active.
3. The user's effective permissions are loaded.
4. The required module/action is `true`.

When permission is missing, the API returns `403`.

Frontend checks control visibility. Backend checks provide security. Both must use the same `moduleKey`.

## Special behavior

- Super Admin has full permission.
- Company Admin currently bypasses backend module restrictions.
- `hr_dashboard` permission also applies to dashboard module keys such as `employee_dashboard`.
- Access-role permissions are cached for approximately 60 seconds.
- Saving role permissions clears the permission cache.
- After changing an employee's assigned role, reload the app or call the profile API to receive updated frontend permissions.

## Simple testing flow

1. Create a test access role.
2. Enable only the required module permissions.
3. Assign the role to a test employee.
4. Login as that employee.
5. Check that login returns:

```text
access_role_id
access_role_name
permissions
```

6. Confirm only permitted modules appear.
7. Confirm denied pages redirect.
8. Confirm denied buttons are hidden.
9. Call a denied backend operation and confirm it returns `403`.
10. Change the role, reload/profile-refresh, and verify the updated permissions.

## Main files

Backend:

```text
src/routes/accessRoles.routes.js
src/services/accessRoles.service.js
src/services/accessControl.service.js
src/middleware/auth.middleware.js
src/middleware/routeProtection.js
src/controllers/employee.controller.js
src/controllers/auth.controller.js
```

Frontend:

```text
front-end/src/lib/permissions.js
front-end/src/lib/constants.js
front-end/src/store/authSlice.js
front-end/src/hooks/useProfile.js
front-end/src/components/routing/PermissionRoute.jsx
front-end/src/pages/AdminPages/CompanyAdmin/AccessRoles/
front-end/src/pages/AdminPages/CompanyAdmin/employeeManagement/AddEmployee.jsx
```
