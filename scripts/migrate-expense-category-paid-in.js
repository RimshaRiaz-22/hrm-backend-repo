const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
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

CREATE INDEX IF NOT EXISTS expense_categories_company_effective_idx
  ON expense_categories(company_id, effective_from);
`;

async function main() {
  await pool.query(sql);
  const check = await pool.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'expense_categories'
       AND column_name IN ('paid_in', 'effective_from')
     ORDER BY column_name`
  );
  console.log('Migration OK: expense_categories paid_in + effective_from ready');
  console.log(
    'Columns:',
    check.rows
      .map(
        (r) =>
          `${r.column_name} (${r.data_type}, default=${r.column_default}, nullable=${r.is_nullable})`
      )
      .join('; ')
  );
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
