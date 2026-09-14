const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
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
`;

async function main() {
  await pool.query(sql);
  const check = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'religions'
     ORDER BY ordinal_position`
  );
  console.log('Migration OK: religions table ready');
  console.log('Columns:', check.rows.map((r) => `${r.column_name} (${r.data_type})`).join(', '));
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
