const pool = require('../db');
const { SYSTEM_MODULES_SEED } = require('../constants/systemModules.seed');

async function listActiveModules() {
  const result = await pool.query(
    `SELECT module_key, label, category, sort_order
     FROM system_modules
     WHERE is_active = TRUE
     ORDER BY category ASC, sort_order ASC, label ASC`
  );
  if (result.rowCount > 0) {
    return result.rows;
  }
  return SYSTEM_MODULES_SEED.map((m) => ({
    module_key: m.module_key,
    label: m.label,
    category: m.category,
    sort_order: m.sort_order,
  }));
}

module.exports = {
  listActiveModules,
};
