# Payroll Module - Build Flow

This document defines the order in which the Payroll module should be built, based on dependencies between submodules (Payroll Setting, Sandwich Rule, Expenses, Loans/Advance/PF, Monthly Inputs, Run Payroll, Post-Payroll).

## Build Order

### 1. Master Data / Foundation
- Allowance categories, deduction types, contribution types (master data tables)
- These feed Payroll Settings — must exist first

### 2. Payroll Settings (Setup → Pay)
- Payroll Schedule (pay period, holiday rules, start/end/payment dates)
- Allowance (category, calc basis: fixed / percentage / present-days)
- Deduction (name, calc basis)
- Contribution (name, calc basis)
- Salary Template (bundles allowances + deductions + contributions)

### 3. Employee Profile Assignment
- Link employee → Payroll Schedule
- Link employee → Allowances / Deductions / Contributions or Salary Template
- This is the join layer everything downstream reads from

### 4. Sandwich Rule (Company Profile setting)
- Simple config flag, but must exist before payroll calculation logic since it changes absence-deduction math

### 5. Expenses Module
- Expense Category (depends on Allowance master data — "Expense" type allowance)
- Paid In: Salary vs Cash
- Request → Approval flow (employee → approver)

### 6. Loan / Advance / PF Module
- Loan / Advance / PF request types
- Recovery method (Salary Deduction vs Cash), installment config
- Approval flow
- Repayment tracking (manual + auto salary deduction)

### 7. Monthly Inputs
- Regular vs Off-Cycle input types
- Status state machine: Draft → Pending → Approved → Finalized
- Bulk import support
- Role-based permission gates per action (post / approve / finalize)

### 8. Run Payroll (core engine)
- Regular vs Off-Cycle runs
- Same state machine: Draft → Pending → Approved → Finalized → Closed
- Calculation must pull from ALL prior modules at once:
  - Salary Template (base + allowances/deductions/contributions)
  - Finalized Monthly Inputs
  - Active loan deductions
  - Expense reimbursements (if Paid In = Salary)
  - Attendance + Sandwich Rule → absence deductions
- Draft-stage adjustments (individual edit + bulk update)
- Import salary data support

### 9. Post-Payroll
- Email salary slips (with optional password protection)
- Export payroll sheets
- Email Tax Certificates (requires payroll Closed first)
- Employee self-service payslip access (unlocked after Closed)

### 10. Role / Permission Layer (cross-cutting)
- Not a separate stage — applies to Monthly Inputs and Run Payroll state transitions (who can create / post / approve / finalize / close)
- Should be built alongside #7 and #8, not after

## Why This Order

Master data → Settings → Employee assignment must exist before anything can reference them. Expenses and Loans are independent of each other but both depend on Employee Profile + their own master data (Allowance for Expenses). Monthly Inputs and Run Payroll are the two modules that *consume* everything before them, so they come last, with Run Payroll depending on Monthly Inputs being finalized. Post-Payroll only makes sense once Run Payroll can reach "Closed."

---

## Backend Code-Wise Flow

This project follows a `db (init.sql)` → `services` → `controllers` → `routes` layering, with `middleware` for auth/roles and `jobs` for scheduled/async work. Existing pieces already in the codebase: `loans` / `loan_request_details` / `loan_payments` tables + `loanRequest.service.js`, `expense_request_details` table + `expenseRequest.service.js`, and a basic `salary_entries` table + `salaries.controller.js`/`salaries.routes.js`. Everything else below is net-new.

For **each** submodule, the internal build order is always the same 4 layers:

```
1. Schema (init.sql)      → tables, FKs, constraints, indexes
2. Service                → query/business logic, no HTTP concerns
3. Controller             → request/response, validation, calls service
4. Routes + middleware     → wire endpoint, attach auth/role guard
```

### Stage A — Payroll Settings (foundation tables)
- Schema: `payroll_schedules`, `allowances`, `deductions`, `contributions`, `salary_templates` (+ join tables `salary_template_allowances`, `salary_template_deductions`, `salary_template_contributions`)
- Service: `payrollSchedule.service.js`, `allowance.service.js`, `deduction.service.js`, `contribution.service.js`, `salaryTemplate.service.js`
- Controller + Routes: one pair per entity, CRUD only (list/create/update/delete), scoped by `company_id` like existing modules
- No dependency on anything else — build first

### Stage B — Employee Profile Assignment
- Schema: join tables linking `employees` → `payroll_schedules`, `employees` → `allowances`/`deductions`/`contributions` (or `salary_templates`), each with effective-date columns
- Service: extend `employee` service (or new `employeeSalary.service.js`) with assign/unassign/list-assigned methods
- Controller + Routes: likely nested under existing `employee.routes.js` (e.g. `/employees/:id/salary`)
- Depends on Stage A tables existing (FKs)

### Stage C — Sandwich Rule
- Schema: single column/flag on `companies` (or a `company_payroll_settings` table if more flags are expected later)
- Service: extend `companies.service.js` or add to a settings service
- Controller + Routes: extend existing companies profile endpoints
- No dependency — can be built in parallel with A/B

### Stage D — Expenses (extend existing)
- Schema: already have `expense_request_details`; add `expense_categories` table (references `allowances` where category = "Expense"), with `paid_in` (salary/cash) and `effective_from`
- Service: extend `expenseRequest.service.js` + new `expenseCategory.service.js`
- Controller + Routes: new `expenseCategory.controller.js`/`.routes.js`; extend existing expense request endpoints to reference category
- Depends on Stage A (Allowance)

### Stage E — Loan / Advance / PF (extend existing)
- Schema: already have `loans`, `loan_request_details`, `loan_payments` — likely need to add `loan_type` (loan/advance/PF-temp/PF-permanent), `recovery_method`, `installment_amount`, `installment_basis` columns if not present
- Service: extend `loanRequest.service.js` with recovery-method-aware repayment logic
- Controller + Routes: extend existing loan endpoints; add repayment endpoint if missing
- Depends on Stage B (employee profile) only

### Stage F — Monthly Inputs
- Schema: `monthly_inputs` (header: schedule_id, is_off_cycle, status) + `monthly_input_lines` (employee_id, pay_element, pay_date, amount)
- Service: `monthlyInputs.service.js` — status transition methods (draft/pending/approve/finalize/return), bulk import parsing
- Controller + Routes: `monthlyInputs.controller.js`/`.routes.js`, one endpoint per transition, guarded by role middleware
- Depends on Stage A (schedule, pay elements) + Stage B (which employees are eligible)

### Stage G — Run Payroll (core engine)
- Schema: `payroll_runs` (header: schedule_id, is_off_cycle, status, period dates) + `payroll_run_entries` (per-employee computed breakdown, stored as line items or JSONB snapshot)
- Service: `payrollRun.service.js` — the calculation engine:
  - Pulls salary template (Stage A/B)
  - Pulls finalized monthly inputs (Stage F)
  - Pulls active loan deductions (Stage E)
  - Pulls expense reimbursements where paid_in = salary (Stage D)
  - Pulls attendance + sandwich rule flag (Stage C) → absence deduction
  - Same status-transition pattern as Monthly Inputs, plus draft-stage edit/bulk-update methods
- Controller + Routes: `payrollRun.controller.js`/`.routes.js`, run/list/individual-edit/bulk-update/export endpoints
- Depends on every prior stage — build last, and only once A–F are stable

### Stage H — Post-Payroll
- Service: extend `email.service.js` with payslip + tax certificate templates/senders; add export helper (reuse existing export patterns if any)
- Controller + Routes: endpoints for "email slips", "export sheet", "send tax certificate" — all gated on `payroll_runs.status = closed`
- Depends on Stage G reaching `closed`

### Stage I — Roles/Permissions (cross-cutting, not sequential)
- Extend existing `roles.controller.js`/`roles.service.js` + `auth.middleware.js` with payroll-specific permission checks (create/post/approve/finalize/close) for Monthly Inputs and Run Payroll
- Build alongside Stage F and G, not after — the transition endpoints need the guard from day one, not bolted on later

### Suggested delivery order
`Stage A → Stage B → (Stage C, D, E in any order/parallel) → Stage F (+ I) → Stage G (+ I) → Stage H`
