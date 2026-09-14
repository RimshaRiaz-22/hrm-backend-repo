require('dotenv').config();
const pool = require('../src/db');

const statements = [
  `CREATE TABLE IF NOT EXISTS system_modules (
    module_key VARCHAR(80) PRIMARY KEY,
    label VARCHAR(120) NOT NULL,
    category VARCHAR(80) NOT NULL DEFAULT 'General',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
];

(async () => {
  console.log('Running DDL step 1...');
  for (const sql of statements) {
    await pool.query(sql);
    console.log('OK');
  }
  await pool.end();
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
