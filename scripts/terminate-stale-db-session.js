require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  options: '-c timezone=UTC',
});

const STALE_PIDS = [3727620];

(async () => {
  for (const pid of STALE_PIDS) {
    const result = await pool.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
    console.log(`terminate ${pid}:`, result.rows[0]);
  }
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
