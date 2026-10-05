const pool = require('./index');

/**
 * Additive schema for Performance Management.
 * Safe to run on every boot: additive schema plus targeted idempotent constraint updates.
 */
const PERFORMANCE_MODULE_SQL = `
CREATE TABLE IF NOT EXISTS performance_competencies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS performance_competencies_company_id_idx
  ON performance_competencies(company_id);
CREATE INDEX IF NOT EXISTS performance_competencies_company_status_idx
  ON performance_competencies(company_id, status);

CREATE TABLE IF NOT EXISTS performance_competency_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS performance_competency_templates_company_id_idx
  ON performance_competency_templates(company_id);

CREATE TABLE IF NOT EXISTS performance_competency_template_items (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id BIGINT NOT NULL REFERENCES performance_competency_templates(id) ON DELETE CASCADE,
  competency_id BIGINT NOT NULL REFERENCES performance_competencies(id) ON DELETE RESTRICT,
  weightage NUMERIC(6,2) NOT NULL CHECK (weightage > 0 AND weightage <= 100),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (template_id, competency_id)
);

CREATE INDEX IF NOT EXISTS performance_competency_template_items_template_id_idx
  ON performance_competency_template_items(template_id);

CREATE TABLE IF NOT EXISTS performance_competency_template_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id BIGINT NOT NULL REFERENCES performance_competency_templates(id) ON DELETE CASCADE,
  scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('company', 'department', 'designation', 'employee')),
  department_id BIGINT REFERENCES departments(id) ON DELETE CASCADE,
  designation_id BIGINT REFERENCES designations(id) ON DELETE CASCADE,
  employee_id BIGINT REFERENCES employees(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS performance_competency_template_assignments_company_id_idx
  ON performance_competency_template_assignments(company_id);
CREATE INDEX IF NOT EXISTS performance_competency_template_assignments_template_id_idx
  ON performance_competency_template_assignments(template_id);
CREATE INDEX IF NOT EXISTS performance_competency_template_assignments_employee_id_idx
  ON performance_competency_template_assignments(employee_id);

CREATE TABLE IF NOT EXISTS performance_goals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('monthly', 'semi_monthly', 'quarterly', 'annually')),
  start_date DATE,
  end_date DATE,
  default_weightage NUMERIC(6,2) CHECK (default_weightage IS NULL OR (default_weightage > 0 AND default_weightage <= 100)),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS performance_goals_company_id_idx ON performance_goals(company_id);
CREATE INDEX IF NOT EXISTS performance_goals_company_status_idx ON performance_goals(company_id, status);

CREATE TABLE IF NOT EXISTS performance_goal_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id BIGINT NOT NULL REFERENCES performance_goals(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weightage NUMERIC(6,2) NOT NULL CHECK (weightage > 0 AND weightage <= 100),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (goal_id, employee_id)
);

CREATE INDEX IF NOT EXISTS performance_goal_assignments_company_id_idx
  ON performance_goal_assignments(company_id);
CREATE INDEX IF NOT EXISTS performance_goal_assignments_employee_id_idx
  ON performance_goal_assignments(employee_id);

CREATE TABLE IF NOT EXISTS performance_competency_assignments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  competency_id BIGINT NOT NULL REFERENCES performance_competencies(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weightage NUMERIC(6,2) NOT NULL CHECK (weightage > 0 AND weightage <= 100),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (competency_id, employee_id)
);

CREATE INDEX IF NOT EXISTS performance_competency_assignments_company_id_idx
  ON performance_competency_assignments(company_id);
CREATE INDEX IF NOT EXISTS performance_competency_assignments_employee_id_idx
  ON performance_competency_assignments(employee_id);

CREATE TABLE IF NOT EXISTS performance_appraisal_cycles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  cycle_type VARCHAR(20) NOT NULL CHECK (cycle_type IN ('monthly', 'semi_monthly', 'yearly', 'quarterly', 'custom')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  rating_deadline DATE,
  goal_contribution NUMERIC(6,2) NOT NULL CHECK (goal_contribution >= 0 AND goal_contribution <= 100),
  competency_contribution NUMERIC(6,2) NOT NULL CHECK (competency_contribution >= 0 AND competency_contribution <= 100),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT performance_appraisal_cycles_contribution_sum_chk
    CHECK (ABS((goal_contribution + competency_contribution) - 100) < 0.01)
);

CREATE INDEX IF NOT EXISTS performance_appraisal_cycles_company_id_idx
  ON performance_appraisal_cycles(company_id);
CREATE INDEX IF NOT EXISTS performance_appraisal_cycles_company_status_idx
  ON performance_appraisal_cycles(company_id, status);

CREATE TABLE IF NOT EXISTS performance_appraisal_participants (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cycle_id BIGINT NOT NULL REFERENCES performance_appraisal_cycles(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  template_id BIGINT REFERENCES performance_competency_templates(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'in_progress', 'submitted', 'pip_suggested', 'pip_created', 'pip_dismissed')
  ),
  goal_score NUMERIC(8,4),
  competency_score NUMERIC(8,4),
  calculated_rating NUMERIC(8,4),
  final_rating NUMERIC(8,4),
  rating_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  overall_remarks TEXT,
  strengths TEXT,
  areas_for_improvement TEXT,
  overall_remarks_attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMP,
  submitted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (cycle_id, employee_id)
);

CREATE INDEX IF NOT EXISTS performance_appraisal_participants_company_id_idx
  ON performance_appraisal_participants(company_id);
CREATE INDEX IF NOT EXISTS performance_appraisal_participants_cycle_id_idx
  ON performance_appraisal_participants(cycle_id);
CREATE INDEX IF NOT EXISTS performance_appraisal_participants_employee_id_idx
  ON performance_appraisal_participants(employee_id);

CREATE TABLE IF NOT EXISTS performance_appraisal_goal_ratings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  participant_id BIGINT NOT NULL REFERENCES performance_appraisal_participants(id) ON DELETE CASCADE,
  goal_id BIGINT REFERENCES performance_goals(id) ON DELETE SET NULL,
  goal_title VARCHAR(200) NOT NULL,
  goal_description TEXT,
  weightage NUMERIC(6,2) NOT NULL CHECK (weightage > 0 AND weightage <= 100),
  rating NUMERIC(4,2) CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  achievement_status VARCHAR(40),
  remarks TEXT,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS performance_appraisal_goal_ratings_participant_id_idx
  ON performance_appraisal_goal_ratings(participant_id);

CREATE TABLE IF NOT EXISTS performance_appraisal_competency_ratings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  participant_id BIGINT NOT NULL REFERENCES performance_appraisal_participants(id) ON DELETE CASCADE,
  competency_id BIGINT REFERENCES performance_competencies(id) ON DELETE SET NULL,
  competency_name VARCHAR(120) NOT NULL,
  competency_description TEXT,
  default_weightage NUMERIC(6,2) NOT NULL CHECK (default_weightage > 0 AND default_weightage <= 100),
  weightage NUMERIC(6,2) NOT NULL CHECK (weightage > 0 AND weightage <= 100),
  rating NUMERIC(4,2) CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  remarks TEXT,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS performance_appraisal_competency_ratings_participant_id_idx
  ON performance_appraisal_competency_ratings(participant_id);

CREATE TABLE IF NOT EXISTS performance_pips (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  participant_id BIGINT NOT NULL REFERENCES performance_appraisal_participants(id) ON DELETE CASCADE,
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  cycle_id BIGINT NOT NULL REFERENCES performance_appraisal_cycles(id) ON DELETE CASCADE,
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days > 0),
  focus_areas TEXT,
  check_in_schedule TEXT,
  progress_notes TEXT,
  final_outcome TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (participant_id)
);

CREATE INDEX IF NOT EXISTS performance_pips_company_id_idx ON performance_pips(company_id);
CREATE INDEX IF NOT EXISTS performance_pips_employee_id_idx ON performance_pips(employee_id);
`;

async function ensurePerformanceModuleSchema() {
  await pool.query(PERFORMANCE_MODULE_SQL);
  await pool.query(`
    DO $$
    DECLARE
      constraint_name text;
    BEGIN
      SELECT con.conname
        INTO constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = 'performance_goals'
        AND nsp.nspname = 'public'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%frequency%'
      LIMIT 1;

      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.performance_goals DROP CONSTRAINT %I', constraint_name);
      END IF;

      ALTER TABLE public.performance_goals
        ADD CONSTRAINT performance_goals_frequency_chk
        CHECK (frequency IN ('monthly', 'semi_monthly', 'quarterly', 'annually'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    DO $$
    DECLARE
      constraint_name text;
    BEGIN
      SELECT con.conname
        INTO constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = 'performance_appraisal_cycles'
        AND nsp.nspname = 'public'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%cycle_type%'
      LIMIT 1;

      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.performance_appraisal_cycles DROP CONSTRAINT %I', constraint_name);
      END IF;

      UPDATE public.performance_appraisal_cycles
         SET cycle_type = 'yearly'
       WHERE cycle_type = 'annual';

      UPDATE public.performance_appraisal_cycles
         SET cycle_type = 'custom'
       WHERE cycle_type = 'ad_hoc';

      ALTER TABLE public.performance_appraisal_cycles
        ADD CONSTRAINT performance_appraisal_cycles_cycle_type_chk
        CHECK (cycle_type IN ('monthly', 'semi_monthly', 'yearly', 'quarterly', 'custom'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE public.performance_appraisal_participants
      ADD COLUMN IF NOT EXISTS overall_remarks_attachments JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
}

module.exports = {
  ensurePerformanceModuleSchema,
};
