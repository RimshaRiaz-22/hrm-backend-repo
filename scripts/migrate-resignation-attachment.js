const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');

const sql = `
ALTER TABLE resignation_details ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE resignation_details ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255);
ALTER TABLE resignation_details ADD COLUMN IF NOT EXISTS attachment_mime_type VARCHAR(100);
`;

async function run() {
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('Resignation attachment columns migrated successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
