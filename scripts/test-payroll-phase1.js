require('dotenv').config();
const pool = require('../src/db');

async function main() {
  console.log('Payroll phase 1 manual test (placeholder)');
  console.log('TODO: wire payroll settings services once implemented');

  await pool.end();
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
