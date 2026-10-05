const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const SQL = `
-- ========================= PAYROLL MODULE =========================

-- M1: Payroll schedules (pay frequency + dates)
CREATE TABLE IF NOT EXISTS payroll_schedules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  pay_period VARCHAR(20) NOT NULL CHECK (pay_period IN ('monthly', 'bi_weekly')),
  start_day SMALLINT NOT NULL DEFAULT 1 CHECK (start_day BETWEEN 1 AND 31),
  end_day SMALLINT NOT NULL DEFAULT 31 CHECK (end_day BETWEEN 1 AND 31),
  payment_day SMALLINT NOT NULL CHECK (payment_day BETWEEN 1 AND 31),
  holiday_payment_rule VARCHAR(20) NOT NULL DEFAULT 'before'
    CHECK (holiday_payment_rule IN ('before', 'next_business_day')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_hourly BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT payroll_schedules_company_name_unique UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS payroll_schedules_company_id_idx ON payroll_schedules(company_id);

-- M2/M3/M4: Pay elements (allowances, deductions, contributions share one table by \`kind\`)
CREATE TABLE IF NOT EXISTS pay_elements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('allowance', 'deduction', 'contribution')),
  name VARCHAR(120) NOT NULL,
  payslip_name VARCHAR(120) NOT NULL,
  category VARCHAR(60),
  calc_type VARCHAR(20) NOT NULL CHECK (calc_type IN ('fixed', 'percent_of_basic')),
  calc_value NUMERIC(14, 2) NOT NULL CHECK (calc_value >= 0),
  based_on VARCHAR(20) NOT NULL DEFAULT 'fixed'
    CHECK (based_on IN ('fixed', 'present_days')),
  is_taxable BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT pay_elements_company_kind_name_unique UNIQUE (company_id, kind, name)
);
CREATE INDEX IF NOT EXISTS pay_elements_company_kind_idx ON pay_elements(company_id, kind);

-- M5: Salary templates
CREATE TABLE IF NOT EXISTS salary_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT salary_templates_company_name_unique UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS salary_templates_company_id_idx ON salary_templates(company_id);

CREATE TABLE IF NOT EXISTS salary_template_items (
  id BIGSERIAL PRIMARY KEY,
  salary_template_id BIGINT NOT NULL REFERENCES salary_templates(id) ON DELETE CASCADE,
  pay_element_id BIGINT NOT NULL REFERENCES pay_elements(id) ON DELETE CASCADE,
  UNIQUE (salary_template_id, pay_element_id)
);
CREATE INDEX IF NOT EXISTS salary_template_items_template_idx ON salary_template_items(salary_template_id);

-- M6: Employee pay-element assignments (overrides + template link)
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS payroll_schedule_id BIGINT REFERENCES payroll_schedules(id) ON DELETE SET NULL;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS salary_template_id BIGINT REFERENCES salary_templates(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS employee_pay_elements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pay_element_id BIGINT NOT NULL REFERENCES pay_elements(id) ON DELETE CASCADE,
  override_calc_type VARCHAR(20) CHECK (override_calc_type IN ('fixed', 'percent_of_basic')),
  override_calc_value NUMERIC(14, 2) CHECK (override_calc_value IS NULL OR override_calc_value >= 0),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (employee_id, pay_element_id)
);
CREATE INDEX IF NOT EXISTS employee_pay_elements_employee_idx ON employee_pay_elements(employee_id);
CREATE INDEX IF NOT EXISTS employee_pay_elements_company_idx ON employee_pay_elements(company_id);

-- M9: Monthly inputs
CREATE TABLE IF NOT EXISTS monthly_inputs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payroll_schedule_id BIGINT NOT NULL REFERENCES payroll_schedules(id) ON DELETE CASCADE,
  is_off_cycle BOOLEAN NOT NULL DEFAULT FALSE,
  pay_element_id BIGINT REFERENCES pay_elements(id) ON DELETE SET NULL,
  pay_element_label VARCHAR(120) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  pay_date DATE NOT NULL,
  period_month VARCHAR(7) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'finalized')),
  consumed_by_run_id BIGINT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS monthly_inputs_company_period_idx ON monthly_inputs(company_id, period_month, status);
CREATE INDEX IF NOT EXISTS monthly_inputs_employee_idx ON monthly_inputs(employee_id);

-- M10: Payroll runs + line items
CREATE TABLE IF NOT EXISTS payroll_runs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_schedule_id BIGINT NOT NULL REFERENCES payroll_schedules(id) ON DELETE RESTRICT,
  is_off_cycle BOOLEAN NOT NULL DEFAULT FALSE,
  period_month VARCHAR(7) NOT NULL,
  pay_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'finalized', 'closed')),
  total_gross NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_net NUMERIC(16, 2) NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS payroll_runs_company_period_idx ON payroll_runs(company_id, period_month, status);

CREATE TABLE IF NOT EXISTS payroll_run_employees (
  id BIGSERIAL PRIMARY KEY,
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  basic_salary NUMERIC(14, 2) NOT NULL DEFAULT 0,
  present_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  absent_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  total_allowances NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_contributions NUMERIC(14, 2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'finalized', 'closed')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (payroll_run_id, employee_id)
);
CREATE INDEX IF NOT EXISTS payroll_run_employees_run_idx ON payroll_run_employees(payroll_run_id);

CREATE TABLE IF NOT EXISTS payroll_run_lines (
  id BIGSERIAL PRIMARY KEY,
  payroll_run_employee_id BIGINT NOT NULL REFERENCES payroll_run_employees(id) ON DELETE CASCADE,
  line_kind VARCHAR(20) NOT NULL
    CHECK (line_kind IN ('basic', 'allowance', 'deduction', 'contribution', 'loan', 'expense', 'monthly_input', 'absence')),
  label VARCHAR(120) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  source_ref VARCHAR(60),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS payroll_run_lines_employee_idx ON payroll_run_lines(payroll_run_employee_id);

-- M11: Tax certificate send log
CREATE TABLE IF NOT EXISTS tax_certificates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  total_income NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total_tax NUMERIC(16, 2) NOT NULL DEFAULT 0,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (employee_id, tax_year)
);
CREATE INDEX IF NOT EXISTS tax_certificates_company_year_idx ON tax_certificates(company_id, tax_year);
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
    console.log('Payroll phase 1 migration applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
