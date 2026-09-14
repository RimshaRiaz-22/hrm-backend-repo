CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  gender VARCHAR(20),
  profile_picture_url TEXT,
  employee_id VARCHAR(50),
  work_email VARCHAR(120),
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  father_name VARCHAR(120),
  mother_name VARCHAR(120),
  blood_group VARCHAR(10),
  qualification VARCHAR(120),
  dob DATE,
  marital_status VARCHAR(30),
  religion VARCHAR(60),
  employee_code VARCHAR(50) UNIQUE NOT NULL,
  attendance_machine_code VARCHAR(50),
  national_id VARCHAR(50),
  national_id_expiry DATE,
  passport_no VARCHAR(50),
  passport_expiry DATE,
  eobi_number VARCHAR(50),
  ntn_no VARCHAR(50),
  country VARCHAR(80) NOT NULL,
  state_province VARCHAR(80) NOT NULL,
  city VARCHAR(80) NOT NULL,
  zip_postal_code VARCHAR(30),
  nationality VARCHAR(60),
  permanent_address TEXT,
  temporary_address TEXT,
  personal_email VARCHAR(120),
  home_phone VARCHAR(30),
  work_phone_mobile VARCHAR(30),
  emergency_contact_name VARCHAR(120),
  emergency_contact_no VARCHAR(30),
  dependant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  check_in_time TIMESTAMP,
  check_out_time TIMESTAMP,
  work_hours NUMERIC(5, 2) DEFAULT 0,
  status VARCHAR(20) NOT NULL CHECK (status IN ('present', 'late', 'absent')),
  work_mode VARCHAR(20) NOT NULL CHECK (work_mode IN ('office', 'remote')),
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  source VARCHAR(20) NOT NULL DEFAULT 'employee'
    CHECK (source IN ('employee', 'admin')),
  remarks TEXT,
  rejection_reason TEXT,
  approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, attendance_date)
);

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS remarks TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS check_in_latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS check_in_longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS check_out_latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS check_out_longitude DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS attendance_location_settings (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 1000 CHECK (radius_meters > 0 AND radius_meters <= 50000),
  shift_start TIME NOT NULL,
  shift_end TIME NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0 AND break_minutes <= 480),
  grace_minutes INTEGER NOT NULL DEFAULT 0 CHECK (grace_minutes >= 0 AND grace_minutes <= 240),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reuse attendance_location_settings as the company work-location table.
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS company_id BIGINT;
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS name VARCHAR(120);
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS country VARCHAR(80);
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS city VARCHAR(80);
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30);
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS geofencing_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attendance_location_settings ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE attendance_location_settings ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE attendance_location_settings ALTER COLUMN shift_start DROP NOT NULL;
ALTER TABLE attendance_location_settings ALTER COLUMN shift_end DROP NOT NULL;
ALTER TABLE attendance_location_settings ALTER COLUMN shift_start SET DEFAULT '00:00'::time;
ALTER TABLE attendance_location_settings ALTER COLUMN shift_end SET DEFAULT '00:00'::time;
ALTER TABLE attendance_location_settings ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
ALTER TABLE attendance_location_settings ALTER COLUMN updated_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
CREATE INDEX IF NOT EXISTS attendance_location_settings_company_id_idx ON attendance_location_settings(company_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attendance_location_settings_company_name_unique'
  ) THEN
    ALTER TABLE attendance_location_settings
      ADD CONSTRAINT attendance_location_settings_company_name_unique UNIQUE (company_id, name);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS leave_management (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type VARCHAR(20) NOT NULL CHECK (leave_type IN ('sick', 'casual', 'annual')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  leave_days INTEGER NOT NULL CHECK (leave_days > 0),
  remaining_balance INTEGER DEFAULT 0 CHECK (remaining_balance >= 0),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE attendance_location_settings DROP CONSTRAINT IF EXISTS attendance_location_settings_company_id_fkey;
ALTER TABLE attendance_location_settings
  ADD CONSTRAINT attendance_location_settings_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS departments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  department_code VARCHAR(50),
  branch_or_location VARCHAR(120),
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  head_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  parent_dept_id BIGINT REFERENCES departments(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT departments_company_name_unique UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS designations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT designations_company_name_unique UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  employee_id BIGINT UNIQUE REFERENCES employees(id) ON DELETE SET NULL,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  password_hash TEXT,
  role VARCHAR(30) NOT NULL CHECK (
    role IN (
      'super_admin',
      'company_admin',
      'department_manager',
      'employee',
      'admin',
      'hr',
      'manager'
    )
  ),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  profile_picture_url TEXT,
  otp_code VARCHAR(10),
  otp_expires_at TIMESTAMP,
  password_reset_code VARCHAR(10),
  password_reset_expires_at TIMESTAMP,
  last_login_at TIMESTAMP,
  device_id VARCHAR(255),
  signup_type VARCHAR(30) NOT NULL DEFAULT 'email',
  phone_number VARCHAR(30),
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dob DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Upgrade existing `users` tables from older installs (safe to re-run)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (
    role IN (
      'super_admin',
      'company_admin',
      'department_manager',
      'employee',
      'admin',
      'hr',
      'manager'
    )
  );
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_type VARCHAR(30) NOT NULL DEFAULT 'email';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_code VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status VARCHAR(30);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS religion VARCHAR(60);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS national_id VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS national_id_expiry DATE;

CREATE TABLE IF NOT EXISTS attendance_punches (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  action_type VARCHAR(20) NOT NULL CHECK (
    action_type IN ('clock_in', 'break_start', 'break_end', 'clock_out')
  ),
  punched_at TIMESTAMP NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (source IN ('employee', 'admin')),
  marked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  work_location_id BIGINT REFERENCES attendance_location_settings(id) ON DELETE SET NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS attendance_punches_employee_date_idx
  ON attendance_punches(employee_id, attendance_date);

CREATE INDEX IF NOT EXISTS attendance_punches_punched_at_idx
  ON attendance_punches(punched_at);

ALTER TABLE attendance_punches ADD COLUMN IF NOT EXISTS attendance_status VARCHAR(20);

-- ---------------------------------------------------------------------------
-- Companies: org profile (M1). Safe to re-run on existing databases.
-- Company admins live in `users`; tenant data lives in `companies` + users.company_id.
-- ---------------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN IF NOT EXISTS super_admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS type VARCHAR(80);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cover_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website VARCHAR(500);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_email VARCHAR(120);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_phone_no VARCHAR(30);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS currency VARCHAR(10);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country VARCHAR(80);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(80);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS salary_method VARCHAR(30);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS national_id_mandatory BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payslip_password_protected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS idle_timeout_mins INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS loan_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS attendance_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sandwich_rule BOOLEAN NOT NULL DEFAULT FALSE;

-- Allow duplicate company names and business emails across tenants.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_name_key;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_company_email_key;

COMMENT ON COLUMN companies.super_admin_id IS 'Optional platform super-admin owner; tenant-created companies leave NULL.';

-- Departments: safe upgrades for existing DBs
ALTER TABLE departments ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS name VARCHAR(120);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS department_code VARCHAR(50);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS branch_or_location VARCHAR(120);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS head_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS parent_dept_id BIGINT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'departments_company_name_unique'
  ) THEN
    ALTER TABLE departments
      ADD CONSTRAINT departments_company_name_unique UNIQUE (company_id, name);
  END IF;
END
$$;

-- Employee shifts and official/salary details (safe upgrades for existing DBs)
CREATE TABLE IF NOT EXISTS shifts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  break_start_time TIME,
  break_end_time TIME,
  working_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclude_break_from_working_hours BOOLEAN NOT NULL DEFAULT FALSE,
  working_hours_threshold_minutes INTEGER NOT NULL DEFAULT 0 CHECK (
    working_hours_threshold_minutes >= 0 AND working_hours_threshold_minutes <= 240
  ),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT shifts_company_name_unique UNIQUE (company_id, name)
);

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS break_start_time TIME;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS break_end_time TIME;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS working_days JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS exclude_break_from_working_hours BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS working_hours_threshold_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
ALTER TABLE shifts ALTER COLUMN updated_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shifts_working_hours_threshold_minutes_check'
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT shifts_working_hours_threshold_minutes_check
      CHECK (working_hours_threshold_minutes >= 0 AND working_hours_threshold_minutes <= 240);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS employee_job_details (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  designation VARCHAR(120),
  department VARCHAR(120),
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  location VARCHAR(160),
  hire_date DATE,
  joining_date DATE,
  probation_end_date DATE,
  contract_end_date DATE,
  salary NUMERIC(12, 2),
  salary_type VARCHAR(50),
  currency VARCHAR(10),
  medical_allowance NUMERIC(12, 2),
  conveyance_allowance NUMERIC(12, 2),
  other_allowance NUMERIC(12, 2),
  salary_effective_date DATE,
  tax_exemption_status VARCHAR(50),
  eobi_applicable BOOLEAN,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Designations: safe upgrades for existing DBs
ALTER TABLE designations ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE designations ADD COLUMN IF NOT EXISTS name VARCHAR(120);
ALTER TABLE designations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE designations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'designations_company_name_unique'
  ) THEN
    ALTER TABLE designations
      ADD CONSTRAINT designations_company_name_unique UNIQUE (company_id, name);
  END IF;
END
$$;

-- Salary types (value + label), company-scoped; amount is set on employee, not here
CREATE TABLE IF NOT EXISTS salary_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  payroll_type VARCHAR(50),
  basic_salary NUMERIC(10, 2) CHECK (basic_salary IS NULL OR (basic_salary >= 0 AND basic_salary <= 99999999.99)),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT salary_entries_company_value_unique UNIQUE (company_id, value)
);

CREATE INDEX IF NOT EXISTS salary_entries_company_id_idx ON salary_entries(company_id);

-- Migrate older installs (payroll_type + basic_salary only)
ALTER TABLE salary_entries ADD COLUMN IF NOT EXISTS value VARCHAR(50);
ALTER TABLE salary_entries ADD COLUMN IF NOT EXISTS label VARCHAR(120);
ALTER TABLE salary_entries ALTER COLUMN basic_salary DROP NOT NULL;
ALTER TABLE salary_entries DROP CONSTRAINT IF EXISTS salary_entries_payroll_type_check;

-- Company attendance schedules (company admin CRUD; separate from employee attendance logs)
CREATE TABLE IF NOT EXISTS attendance_schedules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  working_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  shift_start TIME NOT NULL,
  shift_end TIME NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0 AND break_minutes <= 480),
  grace_minutes INTEGER NOT NULL DEFAULT 0 CHECK (grace_minutes >= 0 AND grace_minutes <= 240),
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS attendance_schedules_company_id_idx ON attendance_schedules(company_id);

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS work_location_id BIGINT;
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_work_location_id_fkey;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_work_location_id_fkey
  FOREIGN KEY (work_location_id) REFERENCES attendance_location_settings(id) ON DELETE SET NULL;

-- Employee types (value + label), company-scoped; company admin CRUD
CREATE TABLE IF NOT EXISTS employee_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT employee_types_company_value_unique UNIQUE (company_id, value)
);

CREATE INDEX IF NOT EXISTS employee_types_company_id_idx ON employee_types(company_id);

-- Religions (value + label), company-scoped; company admin CRUD
CREATE TABLE IF NOT EXISTS religions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT religions_company_value_unique UNIQUE (company_id, value)
);

CREATE INDEX IF NOT EXISTS religions_company_id_idx ON religions(company_id);

-- Dependant relationship types (value + label), company-scoped
CREATE TABLE IF NOT EXISTS dependant_relationship_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dependant_relationship_types_company_value_unique UNIQUE (company_id, value)
);

CREATE INDEX IF NOT EXISTS dependant_relationship_types_company_id_idx ON dependant_relationship_types(company_id);

-- Company-level dependants (relationship + contact; not linked to a specific employee)
CREATE TABLE IF NOT EXISTS employee_dependants (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  relationship VARCHAR(50) NOT NULL,
  relationship_label VARCHAR(120),
  full_name VARCHAR(120) NOT NULL,
  phone_no VARCHAR(30),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_dependants_company_id_idx ON employee_dependants(company_id);

ALTER TABLE employee_dependants DROP CONSTRAINT IF EXISTS employee_dependants_relationship_check;
ALTER TABLE employee_dependants ADD COLUMN IF NOT EXISTS relationship_label VARCHAR(120);
ALTER TABLE employee_dependants ALTER COLUMN relationship TYPE VARCHAR(50);

-- Remove employee link from older installs
ALTER TABLE employee_dependants DROP CONSTRAINT IF EXISTS employee_dependants_employee_id_fkey;
DROP INDEX IF EXISTS employee_dependants_employee_id_idx;
ALTER TABLE employee_dependants DROP COLUMN IF EXISTS employee_id;

-- Migrate older installs that used dob instead of phone_no
ALTER TABLE employee_dependants ADD COLUMN IF NOT EXISTS phone_no VARCHAR(30);
ALTER TABLE employee_dependants DROP COLUMN IF EXISTS dob;

-- Document types (value + label), company-scoped; public CRUD
CREATE TABLE IF NOT EXISTS document_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT document_types_company_value_unique UNIQUE (company_id, value)
);

CREATE INDEX IF NOT EXISTS document_types_company_id_idx ON document_types(company_id);

-- Employee roles (value + label), company-scoped; public CRUD (job roles, not auth roles)
CREATE TABLE IF NOT EXISTS employee_roles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value VARCHAR(50) NOT NULL,
  label VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT employee_roles_company_value_unique UNIQUE (company_id, value)
);

CREATE INDEX IF NOT EXISTS employee_roles_company_id_idx ON employee_roles(company_id);

-- Per-employee attendance profile (nested attendance_schedule on employee APIs)
CREATE TABLE IF NOT EXISTS employee_attendance_profiles (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  working_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  shift_start TIME NOT NULL,
  shift_end TIME NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0 AND break_minutes <= 480),
  grace_minutes INTEGER NOT NULL DEFAULT 0 CHECK (grace_minutes >= 0 AND grace_minutes <= 240),
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_attendance_profiles_company_id_idx ON employee_attendance_profiles(company_id);

-- Employee ↔ document type rows (optional custom name / file URL); resolves document_type name in responses
CREATE TABLE IF NOT EXISTS employee_documents (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  document_type_id BIGINT REFERENCES document_types(id) ON DELETE CASCADE,
  name VARCHAR(200),
  file_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_documents_employee_id_idx ON employee_documents(employee_id);
CREATE INDEX IF NOT EXISTS employee_documents_company_id_idx ON employee_documents(company_id);

-- Add/Update Employee (employeeNested.service.js replaceEmployeeDocuments) writes a
-- denormalized title/document_type/uploaded_on shape instead of the FK columns above.
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS title VARCHAR(200);
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS document_type VARCHAR(120);
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS uploaded_on DATE;
ALTER TABLE employee_documents ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE employee_documents ALTER COLUMN document_type_id DROP NOT NULL;

-- One bank account per employee for payroll. Later, replace employee_id unique with is_primary for multi-account support.
CREATE TABLE IF NOT EXISTS employee_bank_details (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  bank_name VARCHAR(100) NOT NULL,
  account_title VARCHAR(150) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  iban VARCHAR(50),
  branch_code VARCHAR(20),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_bank_details_employee_id_unique
  ON employee_bank_details(employee_id);

-- Upgrade older employee_bank_details tables that used employee_id as primary key
-- and legacy column names like account_no / branch.
ALTER TABLE employee_bank_details ADD COLUMN IF NOT EXISTS id BIGINT;
CREATE SEQUENCE IF NOT EXISTS employee_bank_details_id_seq;
ALTER TABLE employee_bank_details ALTER COLUMN id SET DEFAULT nextval('employee_bank_details_id_seq');
ALTER SEQUENCE employee_bank_details_id_seq OWNED BY employee_bank_details.id;
UPDATE employee_bank_details SET id = nextval('employee_bank_details_id_seq') WHERE id IS NULL;
SELECT setval(
  'employee_bank_details_id_seq',
  GREATEST(
    COALESCE((SELECT MAX(id) FROM employee_bank_details), 0),
    1
  ),
  true
);

ALTER TABLE employee_bank_details ADD COLUMN IF NOT EXISTS account_title VARCHAR(150);
ALTER TABLE employee_bank_details ADD COLUMN IF NOT EXISTS account_number VARCHAR(50);
ALTER TABLE employee_bank_details ADD COLUMN IF NOT EXISTS branch_code VARCHAR(20);
ALTER TABLE employee_bank_details ADD COLUMN IF NOT EXISTS note TEXT;

DO $$
DECLARE
  account_number_fallback text := '''Unknown Account Number''';
  branch_code_fallback text := 'NULL';
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'employee_bank_details' AND column_name = 'account_no'
  ) THEN
    account_number_fallback := 'NULLIF(TRIM(account_no), '''')';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'employee_bank_details' AND column_name = 'branch'
  ) THEN
    branch_code_fallback := 'NULLIF(TRIM(branch), '''')';
  END IF;

  EXECUTE format(
    'UPDATE employee_bank_details
     SET
       bank_name = COALESCE(NULLIF(TRIM(bank_name), ''''), ''Unknown Bank''),
       account_title = COALESCE(NULLIF(TRIM(account_title), ''''), ''Unknown Account''),
       account_number = COALESCE(NULLIF(TRIM(account_number), ''''), %s, ''Unknown Account Number''),
       branch_code = COALESCE(NULLIF(TRIM(branch_code), ''''), %s)
     WHERE bank_name IS NULL
        OR TRIM(bank_name) = ''''
        OR account_title IS NULL
        OR TRIM(account_title) = ''''
        OR account_number IS NULL
        OR TRIM(account_number) = ''''
        OR branch_code IS NULL',
    account_number_fallback,
    branch_code_fallback
  );
END $$;

ALTER TABLE employee_bank_details ALTER COLUMN id SET NOT NULL;
ALTER TABLE employee_bank_details ALTER COLUMN bank_name SET NOT NULL;
ALTER TABLE employee_bank_details ALTER COLUMN account_title SET NOT NULL;
ALTER TABLE employee_bank_details ALTER COLUMN account_number SET NOT NULL;

DO $$
DECLARE
  pkey_columns text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
  INTO pkey_columns
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
  WHERE t.relname = 'employee_bank_details'
    AND c.contype = 'p';

  IF pkey_columns IS DISTINCT FROM 'id' THEN
    ALTER TABLE employee_bank_details DROP CONSTRAINT IF EXISTS employee_bank_details_pkey;
    ALTER TABLE employee_bank_details ADD CONSTRAINT employee_bank_details_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- Dependants: store company-scoped dependant row ids on the employee (no junction table)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS dependant_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Nested attendance_schedule on employee APIs (no separate profile table required)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS attendance_schedule JSONB;

-- Job details: FK ids and distinct joining date (hire vs join); safe for existing DBs
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS designation_id BIGINT REFERENCES designations(id) ON DELETE SET NULL;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS employee_type_id BIGINT REFERENCES employee_types(id) ON DELETE SET NULL;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS role_id BIGINT REFERENCES employee_roles(id) ON DELETE SET NULL;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS joining_date DATE;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS probation_end_date DATE;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS contract_end_date DATE;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS medical_allowance NUMERIC(12, 2);
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS conveyance_allowance NUMERIC(12, 2);
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS other_allowance NUMERIC(12, 2);
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS salary_effective_date DATE;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS currency VARCHAR(10);
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS tax_exemption_status VARCHAR(50);
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS eobi_applicable BOOLEAN;
ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS work_location_id BIGINT;
ALTER TABLE employee_job_details DROP CONSTRAINT IF EXISTS employee_job_details_work_location_id_fkey;
ALTER TABLE employee_job_details
  ADD CONSTRAINT employee_job_details_work_location_id_fkey
  FOREIGN KEY (work_location_id) REFERENCES attendance_location_settings(id) ON DELETE SET NULL;

-- Holiday types (company-scoped); company admin CRUD
CREATE TABLE IF NOT EXISTS holiday_types (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT holiday_types_company_name_unique UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS holiday_types_company_id_idx ON holiday_types(company_id);

-- Company holidays (single-day or date range); start/end stored as UTC midnight (TIMESTAMPTZ)
CREATE TABLE IF NOT EXISTS holidays (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  holiday_type_id BIGINT NOT NULL REFERENCES holiday_types(id) ON DELETE RESTRICT,
  name VARCHAR(200) NOT NULL,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  color VARCHAR(7) NOT NULL DEFAULT '#3788D8',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT holidays_end_after_start CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS holidays_company_id_idx ON holidays(company_id);
CREATE INDEX IF NOT EXISTS holidays_holiday_type_id_idx ON holidays(holiday_type_id);
CREATE INDEX IF NOT EXISTS holidays_company_date_range_idx ON holidays(company_id, start_date, end_date);

-- Upgrade older installs that predate the color attribute
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS color VARCHAR(20);

-- Upgrade older installs that used DATE for holiday bounds
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_end_after_start;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'holidays'
      AND column_name = 'start_date'
      AND data_type = 'date'
  ) THEN
    ALTER TABLE holidays
      ALTER COLUMN start_date TYPE TIMESTAMPTZ
      USING ((start_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'UTC');
    ALTER TABLE holidays
      ALTER COLUMN end_date TYPE TIMESTAMPTZ
      USING ((end_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'UTC');
  END IF;
END
$$;
ALTER TABLE holidays
  ADD CONSTRAINT holidays_end_after_start CHECK (end_date >= start_date);

ALTER TABLE holidays
  ADD COLUMN IF NOT EXISTS color VARCHAR(7) NOT NULL DEFAULT '#3788D8';

-- Generic employee requests (master table for attendance correction, WFH, etc.)
CREATE TABLE IF NOT EXISTS requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_type VARCHAR(40) NOT NULL CHECK (
    request_type IN (
      'attendance_correction', 'wfh', 'resignation', 'document', 'loan', 'expense'
    )
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'manager_approved', 'approved', 'rejected', 'cancelled')
  ),
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  hr_comment TEXT,
  manager_comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS requests_company_status_type_idx
  ON requests(company_id, status, request_type);
CREATE INDEX IF NOT EXISTS requests_employee_status_idx
  ON requests(employee_id, status);

CREATE TABLE IF NOT EXISTS attendance_correction_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  correction_date DATE NOT NULL,
  original_check_in TIMESTAMP,
  original_check_out TIMESTAMP,

  corrected_check_in TIMESTAMP,
  corrected_check_out TIMESTAMP,

  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS attendance_correction_details_date_idx
  ON attendance_correction_details(correction_date);

ALTER TABLE attendance_correction_details
  ALTER COLUMN corrected_check_in DROP NOT NULL;
ALTER TABLE attendance_correction_details
  ALTER COLUMN corrected_check_out DROP NOT NULL;

-- Phase 2: WFH request details (one row per WFH day)
CREATE TABLE IF NOT EXISTS wfh_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  wfh_date DATE NOT NULL,
  reason TEXT NOT NULL,
  work_plan TEXT NOT NULL,
  UNIQUE (request_id, wfh_date)
);

CREATE INDEX IF NOT EXISTS wfh_request_details_date_idx
  ON wfh_request_details(wfh_date);
CREATE INDEX IF NOT EXISTS wfh_request_details_request_idx
  ON wfh_request_details(request_id);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS review_stage VARCHAR(20)
  CHECK (review_stage IS NULL OR review_stage IN ('manager', 'hr', 'ceo'));
-- manager_reviewed_by identifies the line manager (employees.id, via employee_line_managers),
-- same as leave_requests.manager_reviewed_by -- not a users(id) reviewer.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_reviewed_by BIGINT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_reviewed_at TIMESTAMP;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS document_url TEXT;

CREATE INDEX IF NOT EXISTS requests_manager_reviewed_by_idx ON requests(manager_reviewed_by);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_wfh_days_per_month INTEGER NOT NULL DEFAULT 8;

-- Phase 3: Resignation & notice period
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_status VARCHAR(30) NOT NULL DEFAULT 'active';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_working_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS exit_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS final_settlement_pending BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_employment_status_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_employment_status_check
      CHECK (employment_status IN ('active', 'serving_notice', 'exited'));
  END IF;
END
$$;

ALTER TABLE employee_job_details ADD COLUMN IF NOT EXISTS notice_period_days INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS resignation_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  last_intended_date DATE NOT NULL,
  reason TEXT,
  notice_period_days INTEGER NOT NULL DEFAULT 30,
  calculated_last_working_date DATE NOT NULL,
  attachment_url TEXT,
  attachment_name VARCHAR(255),
  attachment_mime_type VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS resignation_details_request_idx
  ON resignation_details(request_id);

CREATE TABLE IF NOT EXISTS notice_periods (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  notice_start_date DATE NOT NULL,
  notice_end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'serving'
    CHECK (status IN ('serving', 'completed', 'waived')),
  alert_7d_sent BOOLEAN NOT NULL DEFAULT false,
  alert_final_sent BOOLEAN NOT NULL DEFAULT false,
  waive_reason TEXT,
  waived_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  waived_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS notice_periods_employee_idx ON notice_periods(employee_id);
CREATE INDEX IF NOT EXISTS notice_periods_status_end_idx ON notice_periods(status, notice_end_date);

CREATE TABLE IF NOT EXISTS hr_exit_alerts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  notice_period_id BIGINT REFERENCES notice_periods(id) ON DELETE CASCADE,
  alert_type VARCHAR(30) NOT NULL CHECK (alert_type IN ('7_day_warning', 'final_settlement')),
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS hr_exit_alerts_company_created_idx
  ON hr_exit_alerts(company_id, created_at DESC);

-- Phase 5: Loan & expense request details (manual repayment / reimbursement)
CREATE TABLE IF NOT EXISTS loan_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  tenure_months INTEGER CHECK (tenure_months IS NULL OR tenure_months > 0),
  emi_amount NUMERIC(14, 2),
  repayment_type VARCHAR(20) NOT NULL CHECK (repayment_type IN ('installment', 'one_time')),
  purpose TEXT NOT NULL,
  repayment_start VARCHAR(10)
);

CREATE INDEX IF NOT EXISTS loan_request_details_request_idx
  ON loan_request_details(request_id);

-- Advance requests reuse the loan request infrastructure above
-- (request_type = 'advance', repayment_type forced to 'one_time' in loanRequest.service.js).
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_request_type_check;
ALTER TABLE requests
  ADD CONSTRAINT requests_request_type_check CHECK (
    request_type IN (
      'attendance_correction', 'wfh', 'resignation', 'document',
      'loan', 'advance', 'expense', 'pf_temporary', 'pf_permanent'
    )
  );

CREATE TABLE IF NOT EXISTS loans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  tenure_months INTEGER CHECK (tenure_months IS NULL OR tenure_months > 0),
  emi_amount NUMERIC(14, 2),
  repayment_type VARCHAR(20) NOT NULL CHECK (repayment_type IN ('installment', 'one_time')),
  outstanding_balance NUMERIC(14, 2) NOT NULL CHECK (outstanding_balance >= 0),
  start_month VARCHAR(7),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS loans_employee_status_idx ON loans(employee_id, status);
CREATE INDEX IF NOT EXISTS loans_company_idx ON loans(company_id);

CREATE TABLE IF NOT EXISTS loan_payments (
  id BIGSERIAL PRIMARY KEY,
  loan_id BIGINT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS loan_payments_loan_idx ON loan_payments(loan_id);

ALTER TABLE loans ADD COLUMN IF NOT EXISTS recovery_method VARCHAR(20)
  CHECK (recovery_method IS NULL OR recovery_method IN ('salary_deduction', 'cash'));
ALTER TABLE loans ADD COLUMN IF NOT EXISTS loan_source VARCHAR(20) NOT NULL DEFAULT 'loan'
  CHECK (loan_source IN ('loan', 'advance', 'pf_temporary'));

ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS payment_source VARCHAR(20) NOT NULL DEFAULT 'manual'
  CHECK (payment_source IN ('manual', 'payroll'));

-- Provident Fund balances (per employee; must be enrolled by company admin)
CREATE TABLE IF NOT EXISTS employee_pf_balances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  balance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  employee_contribution_rate NUMERIC(5, 2) NOT NULL DEFAULT 8.33
    CHECK (employee_contribution_rate > 0 AND employee_contribution_rate <= 100),
  employer_contribution_rate NUMERIC(5, 2) NOT NULL DEFAULT 8.33
    CHECK (employer_contribution_rate > 0 AND employer_contribution_rate <= 100),
  enrolled_at TIMESTAMP,
  enrolled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_pf_balances_company_idx ON employee_pf_balances(company_id);
CREATE INDEX IF NOT EXISTS employee_pf_balances_enrolled_idx ON employee_pf_balances(company_id, is_enrolled);

CREATE TABLE IF NOT EXISTS employee_pf_contribution_periods (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_month VARCHAR(7) NOT NULL,
  employee_amount NUMERIC(14, 2) NOT NULL CHECK (employee_amount >= 0),
  employer_amount NUMERIC(14, 2) NOT NULL CHECK (employer_amount >= 0),
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount > 0),
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, period_month)
);

CREATE INDEX IF NOT EXISTS employee_pf_contribution_periods_company_idx
  ON employee_pf_contribution_periods(company_id, period_month);

CREATE TABLE IF NOT EXISTS employee_pf_ledger (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN ('credit', 'debit', 'adjustment')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14, 2) NOT NULL CHECK (balance_after >= 0),
  reference_type VARCHAR(40),
  reference_id BIGINT,
  notes TEXT,
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS employee_pf_ledger_employee_idx
  ON employee_pf_ledger(employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pf_temporary_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  recovery_method VARCHAR(20) NOT NULL CHECK (recovery_method IN ('salary_deduction', 'cash')),
  installment_basis VARCHAR(30) NOT NULL
    CHECK (installment_basis IN ('fixed_amount', 'percentage_of_basic')),
  installment_amount NUMERIC(14, 2),
  installment_percentage NUMERIC(5, 2),
  emi_amount NUMERIC(14, 2) NOT NULL,
  tenure_months INTEGER NOT NULL CHECK (tenure_months > 0),
  loan_taken_date DATE NOT NULL,
  repayment_start VARCHAR(10),
  purpose TEXT NOT NULL,
  pf_balance_before NUMERIC(14, 2)
);

CREATE INDEX IF NOT EXISTS pf_temporary_request_details_request_idx
  ON pf_temporary_request_details(request_id);

CREATE TABLE IF NOT EXISTS pf_permanent_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  withdrawal_date DATE NOT NULL,
  purpose TEXT NOT NULL,
  payout_method VARCHAR(20) CHECK (payout_method IS NULL OR payout_method IN ('payroll', 'direct', 'off_cycle')),
  pf_balance_before NUMERIC(14, 2),
  payout_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (payout_status IN ('pending', 'payable', 'paid')),
  payable_at TIMESTAMP,
  paid_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pf_permanent_request_details_request_idx
  ON pf_permanent_request_details(request_id);

CREATE TABLE IF NOT EXISTS expense_categories (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(20),
  description TEXT,
  paid_in VARCHAR(20) NOT NULL DEFAULT 'salary' CHECK (paid_in IN ('salary', 'cash')),
  effective_from DATE NOT NULL DEFAULT (CURRENT_DATE),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT expense_categories_company_name_unique UNIQUE (company_id, name)
);

ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS paid_in VARCHAR(20);
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS effective_from DATE;

UPDATE expense_categories
SET paid_in = 'salary'
WHERE paid_in IS NULL OR TRIM(paid_in) = '';

UPDATE expense_categories
SET effective_from = COALESCE(created_at::date, CURRENT_DATE)
WHERE effective_from IS NULL;

ALTER TABLE expense_categories
  ALTER COLUMN paid_in SET DEFAULT 'salary';
ALTER TABLE expense_categories
  ALTER COLUMN paid_in SET NOT NULL;
ALTER TABLE expense_categories
  ALTER COLUMN effective_from SET DEFAULT (CURRENT_DATE);
ALTER TABLE expense_categories
  ALTER COLUMN effective_from SET NOT NULL;

ALTER TABLE expense_categories
  DROP CONSTRAINT IF EXISTS expense_categories_paid_in_check;
ALTER TABLE expense_categories
  ADD CONSTRAINT expense_categories_paid_in_check
  CHECK (paid_in IN ('salary', 'cash'));

CREATE INDEX IF NOT EXISTS expense_categories_company_idx
  ON expense_categories(company_id);

CREATE INDEX IF NOT EXISTS expense_categories_company_effective_idx
  ON expense_categories(company_id, effective_from);

CREATE TABLE IF NOT EXISTS expense_request_details (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  category_id BIGINT REFERENCES expense_categories(id),
  category VARCHAR(120),
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount > 0),
  items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  paid_in VARCHAR(20) CHECK (paid_in IN ('salary', 'cash')),
  reimbursement_month VARCHAR(7),
  reimbursement_date DATE,
  reimbursement_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (reimbursement_status IN ('pending', 'payable', 'paid')),
  payable_at TIMESTAMP,
  paid_at TIMESTAMP,
  payment_confirmed_by BIGINT REFERENCES users(id),
  payment_reference VARCHAR(120),
  payment_notes TEXT
);

CREATE INDEX IF NOT EXISTS expense_request_details_request_idx
  ON expense_request_details(request_id);

CREATE INDEX IF NOT EXISTS expense_request_details_category_idx
  ON expense_request_details(category_id);

-- Leave policies (company-scoped); company admin CRUD
CREATE TABLE IF NOT EXISTS leave_policies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(20) NOT NULL,
  paid_status VARCHAR(20) NOT NULL CHECK (paid_status IN ('paid', 'unpaid')),
  days_per_year NUMERIC(5, 2) NOT NULL CHECK (days_per_year >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_policies_company_name_unique UNIQUE (company_id, name),
  CONSTRAINT leave_policies_company_code_unique UNIQUE (company_id, code)
);

ALTER TABLE leave_policies ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
ALTER TABLE leave_policies ALTER COLUMN updated_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
ALTER TABLE leave_policies ADD COLUMN IF NOT EXISTS eligible_department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE leave_policies ADD COLUMN IF NOT EXISTS eligible_designation_id BIGINT REFERENCES designations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leave_policies_company_id_idx ON leave_policies(company_id);
CREATE INDEX IF NOT EXISTS leave_policies_company_status_idx ON leave_policies(company_id, status);
CREATE INDEX IF NOT EXISTS leave_policies_eligible_department_id_idx ON leave_policies(eligible_department_id);
CREATE INDEX IF NOT EXISTS leave_policies_eligible_designation_id_idx ON leave_policies(eligible_designation_id);

-- Leave balances per employee, policy, and year (or anniversary cycle)
CREATE TABLE IF NOT EXISTS leave_balances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE RESTRICT,
  year INTEGER NOT NULL CHECK (year >= 2000 AND year <= 2100),
  total_days NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (total_days >= 0),
  used_days NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (used_days >= 0),
  available_days NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (available_days >= 0),
  period_start DATE,
  period_end DATE,
  renewal_date DATE,
  cycle_status VARCHAR(20) CHECK (cycle_status IS NULL OR cycle_status IN ('active', 'expired')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_balances_used_lte_total CHECK (used_days <= total_days),
  CONSTRAINT leave_balances_employee_policy_year_unique UNIQUE (employee_id, leave_policy_id, year)
);

ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS period_end DATE;
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS renewal_date DATE;
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS cycle_status VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS leave_balances_employee_policy_period_unique
  ON leave_balances (employee_id, leave_policy_id, period_start)
  WHERE period_start IS NOT NULL;

CREATE INDEX IF NOT EXISTS leave_balances_company_id_idx ON leave_balances(company_id);
CREATE INDEX IF NOT EXISTS leave_balances_employee_id_idx ON leave_balances(employee_id);
CREATE INDEX IF NOT EXISTS leave_balances_leave_policy_id_idx ON leave_balances(leave_policy_id);
CREATE INDEX IF NOT EXISTS leave_balances_company_year_idx ON leave_balances(company_id, year);

-- Closed anniversary leave cycles (renewals / joining-date recalcs)
CREATE TABLE IF NOT EXISTS leave_policy_cycle_history (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  leave_balance_id BIGINT REFERENCES leave_balances(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  renewal_date DATE NOT NULL,
  total_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  used_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  available_days NUMERIC(5, 2) NOT NULL DEFAULT 0,
  closed_reason VARCHAR(40) NOT NULL DEFAULT 'renewed'
    CHECK (closed_reason IN ('renewed', 'joining_date_changed', 'policy_inactive', 'manual')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_policy_cycle_history_period_unique
    UNIQUE (employee_id, leave_policy_id, period_start)
);

CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_company_id_idx ON leave_policy_cycle_history(company_id);
CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_employee_id_idx ON leave_policy_cycle_history(employee_id);
CREATE INDEX IF NOT EXISTS leave_policy_cycle_history_policy_id_idx ON leave_policy_cycle_history(leave_policy_id);

-- Explicit employee-level eligibility overrides for a leave policy (optional; when rows
-- exist for a policy they take precedence over eligible_department_id/eligible_designation_id)
CREATE TABLE IF NOT EXISTS leave_policy_eligible_employees (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  leave_policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_policy_eligible_employees_unique UNIQUE (leave_policy_id, employee_id)
);

CREATE INDEX IF NOT EXISTS leave_policy_eligible_employees_policy_id_idx ON leave_policy_eligible_employees(leave_policy_id);
CREATE INDEX IF NOT EXISTS leave_policy_eligible_employees_employee_id_idx ON leave_policy_eligible_employees(employee_id);

-- Employee leave requests (pending -> manager_approved -> approved/rejected/cancelled)
CREATE TABLE IF NOT EXISTS leave_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE RESTRICT,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  total_days NUMERIC(5, 2) NOT NULL CHECK (total_days >= 0),
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'manager_approved', 'approved', 'rejected', 'cancelled')),
  manager_comment TEXT,
  hr_comment TEXT,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_requests_date_range_check CHECK (to_date >= from_date)
);

CREATE INDEX IF NOT EXISTS leave_requests_company_id_idx ON leave_requests(company_id);
CREATE INDEX IF NOT EXISTS leave_requests_employee_id_idx ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS leave_requests_leave_policy_id_idx ON leave_requests(leave_policy_id);
CREATE INDEX IF NOT EXISTS leave_requests_company_status_idx ON leave_requests(company_id, status);

-- Allow approved requests with 0 billable days (e.g. leave falls entirely on holidays/off-days).
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_total_days_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_total_days_check CHECK (total_days >= 0);

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS manager_comment TEXT;
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN ('pending', 'manager_approved', 'approved', 'rejected', 'cancelled'));

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS manager_reviewed_by BIGINT REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS manager_reviewed_at TIMESTAMP;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS hr_reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS hr_reviewed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS leave_requests_manager_reviewed_by_idx ON leave_requests(manager_reviewed_by);
CREATE INDEX IF NOT EXISTS leave_requests_hr_reviewed_by_idx ON leave_requests(hr_reviewed_by);

-- Configurable, ordered approval chain for a leave policy (optional; a policy with no rows here
-- uses the default line-manager-then-company-admin flow, unchanged).
CREATE TABLE IF NOT EXISTS leave_policy_approval_steps (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  leave_policy_id BIGINT NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL CHECK (step_order > 0),
  approver_type VARCHAR(20) NOT NULL CHECK (approver_type IN (
    'primary_manager', 'additional_manager', 'department_head', 'access_role', 'user'
  )),
  access_role_id BIGINT REFERENCES access_roles(id) ON DELETE CASCADE,
  approver_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_policy_approval_steps_unique_order UNIQUE (leave_policy_id, step_order)
);

CREATE INDEX IF NOT EXISTS leave_policy_approval_steps_policy_id_idx ON leave_policy_approval_steps(leave_policy_id);

-- Per-request snapshot of the policy's approval steps at submission time, so editing a policy's
-- workflow later never changes an already-in-flight request.
CREATE TABLE IF NOT EXISTS leave_request_approvals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  leave_request_id BIGINT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  approver_type VARCHAR(20) NOT NULL,
  access_role_id BIGINT REFERENCES access_roles(id) ON DELETE SET NULL,
  approver_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
  acted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  acted_at TIMESTAMP,
  comment TEXT,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT leave_request_approvals_unique_step UNIQUE (leave_request_id, step_order)
);

CREATE INDEX IF NOT EXISTS leave_request_approvals_request_id_idx ON leave_request_approvals(leave_request_id);
CREATE INDEX IF NOT EXISTS leave_request_approvals_request_status_idx ON leave_request_approvals(leave_request_id, status);

CREATE TABLE IF NOT EXISTS document_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL CHECK (
    document_type IN ('experience_letter', 'salary_certificate', 'noc', 'bank_letter', 'other')
  ),
  purpose TEXT NOT NULL,
  addressed_to VARCHAR(255),
  note TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'manager_approved', 'ready', 'rejected', 'cancelled')),
  file_url TEXT,
  file_name VARCHAR(255),
  rejection_reason TEXT,
  manager_comment TEXT,
  manager_reviewed_by BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  manager_reviewed_at TIMESTAMP,
  review_stage VARCHAR(20) CHECK (review_stage IS NULL OR review_stage IN ('manager', 'hr', 'ceo')),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS document_requests_company_id_idx ON document_requests(company_id);
CREATE INDEX IF NOT EXISTS document_requests_employee_id_idx ON document_requests(employee_id);
CREATE INDEX IF NOT EXISTS document_requests_company_status_idx ON document_requests(company_id, status);
CREATE INDEX IF NOT EXISTS document_requests_manager_reviewed_by_idx ON document_requests(manager_reviewed_by);

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  note TEXT,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  source VARCHAR(30) NOT NULL CHECK (source IN ('employee_upload', 'company_upload')),
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('self', 'specific', 'multiple', 'all')),
  target_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  target_employee_ids JSONB,
  uploaded_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'active')),
  rejection_reason TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS documents_company_id_idx ON documents(company_id);
CREATE INDEX IF NOT EXISTS documents_uploaded_by_idx ON documents(uploaded_by);
CREATE INDEX IF NOT EXISTS documents_company_source_status_idx ON documents(company_id, source, status);
CREATE INDEX IF NOT EXISTS documents_target_employee_id_idx ON documents(target_employee_id);

CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_name VARCHAR(255),
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS notes_company_id_idx ON notes(company_id);
CREATE INDEX IF NOT EXISTS notes_employee_name_idx ON notes(employee_name);
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

-- M2/M3/M4: Pay elements (allowances, deductions, contributions share one table by `kind`)
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
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS skipped_employees JSONB NOT NULL DEFAULT '[]'::jsonb;
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

-- Push notifications (FCM device tokens)
CREATE TABLE IF NOT EXISTS user_device_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  device_id VARCHAR(255),
  device_label VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (user_id, fcm_token)
);
CREATE INDEX IF NOT EXISTS user_device_tokens_user_id_idx ON user_device_tokens(user_id);
CREATE INDEX IF NOT EXISTS user_device_tokens_active_user_idx ON user_device_tokens(user_id, is_active);

-- Dynamic access control (auth roles + module permissions)
CREATE TABLE IF NOT EXISTS system_modules (
  module_key VARCHAR(80) PRIMARY KEY,
  label VARCHAR(120) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'General',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS access_roles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  is_system_template BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT access_roles_company_name_unique UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS access_roles_company_id_idx ON access_roles(company_id);

CREATE TABLE IF NOT EXISTS access_role_permissions (
  id BIGSERIAL PRIMARY KEY,
  access_role_id BIGINT NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
  module_key VARCHAR(80) NOT NULL REFERENCES system_modules(module_key) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_add BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT access_role_permissions_role_module_unique UNIQUE (access_role_id, module_key)
);

CREATE INDEX IF NOT EXISTS access_role_permissions_role_id_idx ON access_role_permissions(access_role_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS access_role_id BIGINT REFERENCES access_roles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_access_role_id_idx ON users(access_role_id);

-- ---------------------------------------------------------------------------
-- Line manager hierarchy
-- Department: optional single department head.
-- Employee: multiple assigned managers (primary and/or additional) from
-- department members + department head.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS department_line_managers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id BIGINT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_role VARCHAR(20) NOT NULL DEFAULT 'head' CHECK (manager_role IN ('head', 'primary', 'additional')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT department_line_managers_dept_employee_unique UNIQUE (department_id, employee_id)
);

CREATE TABLE IF NOT EXISTS employee_line_managers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_role VARCHAR(20) NOT NULL CHECK (manager_role IN ('primary', 'additional')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT employee_line_managers_employee_manager_unique UNIQUE (employee_id, manager_id)
);

CREATE INDEX IF NOT EXISTS employee_line_managers_company_id_idx ON employee_line_managers(company_id);
CREATE INDEX IF NOT EXISTS employee_line_managers_employee_id_idx ON employee_line_managers(employee_id);
CREATE INDEX IF NOT EXISTS employee_line_managers_manager_id_idx ON employee_line_managers(manager_id);
CREATE INDEX IF NOT EXISTS employee_line_managers_company_manager_idx ON employee_line_managers(company_id, manager_id);
CREATE UNIQUE INDEX IF NOT EXISTS employee_line_managers_one_primary_idx
  ON employee_line_managers(employee_id)
  WHERE manager_role = 'primary';

CREATE INDEX IF NOT EXISTS department_line_managers_company_id_idx
  ON department_line_managers(company_id);
CREATE INDEX IF NOT EXISTS department_line_managers_department_id_idx
  ON department_line_managers(department_id);
CREATE INDEX IF NOT EXISTS department_line_managers_employee_id_idx
  ON department_line_managers(employee_id);
CREATE INDEX IF NOT EXISTS department_line_managers_company_department_idx
  ON department_line_managers(company_id, department_id);

ALTER TABLE department_line_managers ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE department_line_managers ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES departments(id) ON DELETE CASCADE;
ALTER TABLE department_line_managers ADD COLUMN IF NOT EXISTS employee_id BIGINT REFERENCES employees(id) ON DELETE CASCADE;
ALTER TABLE department_line_managers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE department_line_managers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'department_line_managers_dept_employee_unique'
  ) THEN
    ALTER TABLE department_line_managers
      ADD CONSTRAINT department_line_managers_dept_employee_unique UNIQUE (department_id, employee_id);
  END IF;
END
$$;

ALTER TABLE employee_job_details
  ADD COLUMN IF NOT EXISTS line_manager_id BIGINT REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS employee_job_details_line_manager_id_idx
  ON employee_job_details(line_manager_id);
CREATE INDEX IF NOT EXISTS employee_job_details_company_line_manager_idx
  ON employee_job_details(company_id, line_manager_id);

ALTER TABLE department_line_managers ADD COLUMN IF NOT EXISTS manager_role VARCHAR(20) NOT NULL DEFAULT 'head';
ALTER TABLE department_line_managers DROP CONSTRAINT IF EXISTS department_line_managers_role_check;
ALTER TABLE department_line_managers
  ADD CONSTRAINT department_line_managers_role_check
  CHECK (manager_role IN ('head', 'primary', 'additional'));

-- Migrate legacy primary → head; drop department-level additional pools.
UPDATE department_line_managers
SET manager_role = 'head', updated_at = NOW()
WHERE manager_role = 'primary';

DELETE FROM department_line_managers
WHERE manager_role = 'additional';

-- Keep at most one head per department (prefer lowest id if duplicates).
DELETE FROM department_line_managers dlm
WHERE dlm.manager_role = 'head'
  AND dlm.id NOT IN (
    SELECT MIN(id)
    FROM department_line_managers
    WHERE manager_role = 'head'
    GROUP BY department_id
  );
