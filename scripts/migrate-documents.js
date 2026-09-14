const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
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
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'rejected')),
  file_url TEXT,
  file_name VARCHAR(255),
  rejection_reason TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS document_requests_company_id_idx ON document_requests(company_id);
CREATE INDEX IF NOT EXISTS document_requests_employee_id_idx ON document_requests(employee_id);
CREATE INDEX IF NOT EXISTS document_requests_company_status_idx ON document_requests(company_id, status);

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
`;

async function main() {
  await pool.query(sql);
  console.log('Migration OK: Document module tables ready');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
