const pool = require('../src/db');

async function main() {
  await pool.query(`
    ALTER TABLE holidays
      ADD COLUMN IF NOT EXISTS color VARCHAR(7) NOT NULL DEFAULT '#3788D8'
  `);
  console.log('holidays.color column is ready.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
