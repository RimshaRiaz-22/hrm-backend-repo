require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  connectionTimeoutMillis: 15000,
  query_timeout: 15000,
  options: '-c timezone=UTC',
});

(async () => {
  const activity = await pool.query(`
    SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
    ORDER BY state, pid
  `);
  console.log('activity:', activity.rows);

  const locks = await pool.query(`
    SELECT l.pid, l.mode, c.relname, l.granted
    FROM pg_locks l
    LEFT JOIN pg_class c ON c.oid = l.relation
    WHERE l.pid <> pg_backend_pid()
    ORDER BY l.pid
    LIMIT 30
  `);
  console.log('locks sample:', locks.rows);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
