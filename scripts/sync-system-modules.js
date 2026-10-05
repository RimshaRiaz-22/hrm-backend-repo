/**
 * Sync system_modules to match SYSTEM_MODULES_SEED (UI catalog).
 * Deactivates removed keys like `uploads`.
 *
 * Run: node scripts/sync-system-modules.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = require('../src/db');
const { SYSTEM_MODULES_SEED } = require('../src/constants/systemModules.seed');

async function main() {
  const client = await pool.connect();
  try {
    const activeKeys = SYSTEM_MODULES_SEED.map((m) => m.module_key);

    for (const mod of SYSTEM_MODULES_SEED) {
      await client.query(
        `INSERT INTO system_modules (module_key, label, category, sort_order, is_active, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP)
         ON CONFLICT (module_key) DO UPDATE SET
           label = EXCLUDED.label,
           category = EXCLUDED.category,
           sort_order = EXCLUDED.sort_order,
           is_active = TRUE,
           updated_at = CURRENT_TIMESTAMP`,
        [mod.module_key, mod.label, mod.category, mod.sort_order]
      );
    }

    const deactivated = await client.query(
      `UPDATE system_modules
       SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE module_key <> ALL($1::varchar[])
       RETURNING module_key`,
      [activeKeys]
    );

    const active = await client.query(
      `SELECT module_key, label, category, sort_order
       FROM system_modules
       WHERE is_active = TRUE
       ORDER BY category ASC, sort_order ASC`
    );

    console.log(`Active modules: ${active.rowCount}`);
    for (const row of active.rows) {
      console.log(`  [${row.category}] ${row.module_key} — ${row.label}`);
    }
    console.log(
      `Deactivated: ${deactivated.rowCount}`,
      deactivated.rows.map((r) => r.module_key).join(', ') || '(none)'
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
