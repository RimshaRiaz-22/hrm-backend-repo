const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const DEFAULT_CATEGORIES = [
  { name: 'Travel', code: 'travel' },
  { name: 'Meals', code: 'meals' },
  { name: 'Office', code: 'office' },
  { name: 'Client', code: 'client' },
  { name: 'Others', code: 'others' },
];

const sql = `
CREATE TABLE IF NOT EXISTS expense_categories (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(20),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  CONSTRAINT expense_categories_company_name_unique UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS expense_categories_company_idx
  ON expense_categories(company_id);

ALTER TABLE expense_request_details
  DROP CONSTRAINT IF EXISTS expense_request_details_category_check;

ALTER TABLE expense_request_details
  ALTER COLUMN category TYPE VARCHAR(120);

ALTER TABLE expense_request_details
  ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES expense_categories(id);

ALTER TABLE expense_request_details
  ADD COLUMN IF NOT EXISTS paid_in VARCHAR(20);

ALTER TABLE expense_request_details
  DROP CONSTRAINT IF EXISTS expense_request_details_paid_in_check;

ALTER TABLE expense_request_details
  ADD CONSTRAINT expense_request_details_paid_in_check
  CHECK (paid_in IS NULL OR paid_in IN ('salary', 'cash'));

ALTER TABLE expense_request_details
  ADD COLUMN IF NOT EXISTS payment_confirmed_by BIGINT REFERENCES users(id);

ALTER TABLE expense_request_details
  ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(120);

ALTER TABLE expense_request_details
  ADD COLUMN IF NOT EXISTS payment_notes TEXT;

CREATE INDEX IF NOT EXISTS expense_request_details_category_idx
  ON expense_request_details(category_id);
`;

async function seedCompanyCategories(client, companyId) {
  const categoryIdByCode = new Map();

  for (const item of DEFAULT_CATEGORIES) {
    const result = await client.query(
      `INSERT INTO expense_categories (company_id, name, code, paid_in, effective_from, status)
       VALUES ($1, $2, $3, 'salary', CURRENT_DATE, 'active')
       ON CONFLICT (company_id, name) DO UPDATE
         SET code = EXCLUDED.code,
             updated_at = (NOW() AT TIME ZONE 'UTC')
       RETURNING id, code`,
      [companyId, item.name, item.code]
    );
    const row = result.rows[0];
    if (row?.code) {
      categoryIdByCode.set(row.code, Number(row.id));
    }
  }

  return categoryIdByCode;
}

async function backfillExpenseCategoryIds(client) {
  const companies = await client.query(`SELECT id FROM companies`);
  for (const company of companies.rows) {
    const companyId = Number(company.id);
    const categoryIdByCode = await seedCompanyCategories(client, companyId);

    for (const [code, categoryId] of categoryIdByCode.entries()) {
      await client.query(
        `UPDATE expense_request_details erd
         SET category_id = $1,
             category = ec.name
         FROM requests r
         JOIN expense_categories ec ON ec.id = $1
         WHERE erd.request_id = r.id
           AND r.company_id = $2
           AND erd.category_id IS NULL
           AND LOWER(COALESCE(erd.category, '')) = $3`,
        [categoryId, companyId, code]
      );
    }
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await backfillExpenseCategoryIds(client);
    await client.query('COMMIT');
    console.log('Migration OK: expense_categories table and expense_request_details columns are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
