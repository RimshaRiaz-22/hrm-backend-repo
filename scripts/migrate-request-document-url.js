const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE requests ADD COLUMN IF NOT EXISTS document_url TEXT;
`;

async function run() {
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('Request document_url column migrated successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
