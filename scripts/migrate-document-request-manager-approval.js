const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS manager_comment TEXT;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS manager_reviewed_by BIGINT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS manager_reviewed_at TIMESTAMP;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS review_stage VARCHAR(20);

ALTER TABLE document_requests DROP CONSTRAINT IF EXISTS document_requests_status_check;
ALTER TABLE document_requests ADD CONSTRAINT document_requests_status_check
  CHECK (status IN ('pending', 'manager_approved', 'ready', 'rejected', 'cancelled'));

ALTER TABLE document_requests DROP CONSTRAINT IF EXISTS document_requests_review_stage_check;
ALTER TABLE document_requests ADD CONSTRAINT document_requests_review_stage_check
  CHECK (review_stage IS NULL OR review_stage IN ('manager', 'hr', 'ceo'));

CREATE INDEX IF NOT EXISTS document_requests_manager_reviewed_by_idx ON document_requests(manager_reviewed_by);
`;

async function main() {
  await pool.query(sql);
  console.log(
    'Migration OK: document_requests supports manager_approved status and manager review fields.'
  );
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
