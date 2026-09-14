'use strict';

/**
 * Migrate department_line_managers from primary/additional pools to a single
 * department head (manager_role = 'head').
 *
 * Usage: node scripts/migrate-department-head.js
 */

const pool = require('../src/db');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE department_line_managers
        ADD COLUMN IF NOT EXISTS manager_role VARCHAR(20) NOT NULL DEFAULT 'head'
    `);

    await client.query(`
      ALTER TABLE department_line_managers
        DROP CONSTRAINT IF EXISTS department_line_managers_role_check
    `);

    await client.query(`
      ALTER TABLE department_line_managers
        ADD CONSTRAINT department_line_managers_role_check
        CHECK (manager_role IN ('head', 'primary', 'additional'))
    `);

    const updated = await client.query(`
      UPDATE department_line_managers
      SET manager_role = 'head', updated_at = NOW()
      WHERE manager_role = 'primary'
      RETURNING id
    `);

    const deleted = await client.query(`
      DELETE FROM department_line_managers
      WHERE manager_role = 'additional'
      RETURNING id
    `);

    const deduped = await client.query(`
      DELETE FROM department_line_managers dlm
      WHERE dlm.manager_role = 'head'
        AND dlm.id NOT IN (
          SELECT MIN(id)
          FROM department_line_managers
          WHERE manager_role = 'head'
          GROUP BY department_id
        )
      RETURNING id
    `);

    await client.query('COMMIT');
    console.log(
      `migrate-department-head: promoted ${updated.rowCount} primary→head, ` +
        `removed ${deleted.rowCount} additional, deduped ${deduped.rowCount} extra heads.`
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    console.error('migrate-department-head failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
