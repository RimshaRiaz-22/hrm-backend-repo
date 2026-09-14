require('dotenv').config();
const pool = require('../src/db');
const monthlyInputService = require('../src/services/monthlyInput.service');
const payrollScheduleService = require('../src/services/payrollSchedule.service');
const payElementService = require('../src/services/payElement.service');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
  console.log('PASS:', message);
}

async function countByStatus(companyId, periodMonth, status) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM monthly_inputs
     WHERE company_id = $1 AND period_month = $2 AND status = $3`,
    [companyId, periodMonth, status]
  );
  return result.rows[0].total;
}

async function main() {
  const match = await pool.query(`
    SELECT au.id AS admin_id, au.email AS admin_email, au.company_id
    FROM users au
    WHERE au.role = 'company_admin'
      AND au.is_active = TRUE
      AND au.company_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM employees e
        WHERE e.company_id = au.company_id
          AND e.employment_status != 'exited'
      )
    ORDER BY au.id ASC
    LIMIT 1
  `);

  if (match.rowCount === 0) {
    console.log('SKIP: need an active company_admin whose company has employees');
    await pool.end();
    return;
  }

  const admin = match.rows[0];
  const authAdmin = { userId: admin.admin_id, email: admin.admin_email };
  const companyId = admin.company_id;
  const suffix = Date.now();
  const periodMonth = '2026-07';

  const employees = await pool.query(
    `SELECT id FROM employees
     WHERE company_id = $1 AND employment_status != 'exited'
     ORDER BY id ASC
     LIMIT 3`,
    [companyId]
  );
  if (employees.rowCount < 1) {
    console.log('SKIP: need at least 1 active employee in company');
    await pool.end();
    return;
  }

  const employeeIds = employees.rows.map((r) => Number(r.id));
  const primaryEmployeeId = employeeIds[0];

  // Setup: schedule + pay element
  const scheduleResult = await payrollScheduleService.create(authAdmin, {
    name: `MI Monthly Salary ${suffix}`,
    pay_period: 'monthly',
    start_day: 1,
    end_day: 31,
    payment_day: 28,
    holiday_payment_rule: 'before',
    is_default: false,
    is_hourly: false,
  });
  assert(!scheduleResult.error, 'setup: create schedule');
  const scheduleId = scheduleResult.schedule.id;

  const allowanceResult = await payElementService.createAllowance(authAdmin, {
    name: `Performance Bonus ${suffix}`,
    payslip_name: 'Performance Bonus',
    calc_type: 'fixed',
    calc_value: 0,
    based_on: 'fixed',
    is_taxable: true,
  });
  assert(!allowanceResult.error, 'setup: create pay element');
  const payElementId = allowanceResult.payElement.id;

  const createdIds = [];

  try {
    // ============ UC9.1: Create regular monthly inputs ============
    const createEntries = employeeIds.slice(0, Math.min(3, employeeIds.length)).map((employeeId) => ({
      employee_id: employeeId,
      pay_element_id: payElementId,
      amount: 15000,
      pay_date: '2026-07-28',
    }));

    const createResult = await monthlyInputService.create(authAdmin, {
      schedule_id: scheduleId,
      is_off_cycle: false,
      period_month: periodMonth,
      entries: createEntries,
    });
    assert(!createResult.error, `UC9.1 create regular inputs: ${createResult.error?.[1] || ''}`);
    assert(createResult.count === createEntries.length, `UC9.1 created ${createEntries.length} drafts`);
    assert(createResult.items.every((i) => i.status === 'draft'), 'UC9.1 all start as draft');
    assert(createResult.items.every((i) => i.is_off_cycle === false), 'UC9.1 is_off_cycle false');
    createdIds.push(...createResult.items.map((i) => i.id));

    // ============ UC9.2: Create off-cycle input ============
    const offCycleResult = await monthlyInputService.create(authAdmin, {
      schedule_id: scheduleId,
      is_off_cycle: true,
      period_month: periodMonth,
      entries: [
        {
          employee_id: primaryEmployeeId,
          pay_element_id: payElementId,
          amount: 50000,
          pay_date: '2026-07-15',
          pay_element_label: 'Signing Bonus',
        },
      ],
    });
    assert(!offCycleResult.error, `UC9.2 create off-cycle: ${offCycleResult.error?.[1] || ''}`);
    assert(offCycleResult.items[0].is_off_cycle === true, 'UC9.2 is_off_cycle true');
    assert(offCycleResult.items[0].status === 'draft', 'UC9.2 off-cycle starts draft');
    const offCycleId = offCycleResult.items[0].id;
    createdIds.push(offCycleId);

    //============ UC9.3: Status workflow + counts ============
    const draftCountBefore = await countByStatus(companyId, periodMonth, 'draft');
    assert(draftCountBefore >= createEntries.length, 'UC9.3 draft count before post');

    const postResult = await monthlyInputService.transition(
      authAdmin,
      createResult.items.map((i) => i.id),
      'post'
    );
    assert(!postResult.error, `UC9.3 post: ${postResult.error?.[1] || ''}`);
    assert(postResult.status === 'pending', 'UC9.3 post → pending');
    assert(
      (await countByStatus(companyId, periodMonth, 'pending')) >= createEntries.length,
      'UC9.3 pending count after post'
    );

    const approveResult = await monthlyInputService.transition(
      authAdmin,
      createResult.items.map((i) => i.id),
      'approve'
    );
    assert(!approveResult.error, `UC9.3 approve: ${approveResult.error?.[1] || ''}`);
    assert(approveResult.status === 'approved', 'UC9.3 approve → approved');

    const finalizeResult = await monthlyInputService.transition(
      authAdmin,
      createResult.items.map((i) => i.id),
      'finalize'
    );
    assert(!finalizeResult.error, `UC9.3 finalize: ${finalizeResult.error?.[1] || ''}`);
    assert(finalizeResult.status === 'finalized', 'UC9.3 finalize → finalized');
    assert(
      (await countByStatus(companyId, periodMonth, 'finalized')) >= createEntries.length,
      'UC9.3 finalized count'
    );

    // Return one from finalized back to draft
    const oneId = createResult.items[0].id;
    const returnResult = await monthlyInputService.transition(authAdmin, [oneId], 'return');
    assert(!returnResult.error, `UC9.3 return: ${returnResult.error?.[1] || ''}`);
    assert(returnResult.status === 'draft', 'UC9.3 return → draft');

    // Re-walk that one through the pipeline
    await monthlyInputService.transition(authAdmin, [oneId], 'post');
    await monthlyInputService.transition(authAdmin, [oneId], 'approve');
    await monthlyInputService.transition(authAdmin, [oneId], 'finalize');

    // ============ EC9.1: Invalid transition Draft → Approve ============
    const invalidJump = await monthlyInputService.transition(authAdmin, [offCycleId], 'approve');
    assert(!!invalidJump.error, 'EC9.1 invalid Draft→Approve rejected');
    assert(invalidJump.error[0] === 400, 'EC9.1 returns 400');
    assert(/Cannot move from draft/i.test(invalidJump.error[1]), 'EC9.1 message mentions draft');

    // ============ EC9.2: Edit non-draft ============
    const pendingId = (
      await monthlyInputService.transition(authAdmin, [offCycleId], 'post')
    ).items[0].id;
    const editPending = await monthlyInputService.update(authAdmin, pendingId, { amount: 999 });
    assert(!!editPending.error, 'EC9.2 edit non-draft rejected');
    assert(editPending.error[0] === 400, 'EC9.2 returns 400');
    assert(/Returned to Draft/i.test(editPending.error[1]), 'EC9.2 must return first');

    // Return off-cycle, then edit works
    await monthlyInputService.transition(authAdmin, [pendingId], 'return');
    const editDraft = await monthlyInputService.update(authAdmin, pendingId, { amount: 48000 });
    assert(!editDraft.error, `EC9.2 edit draft ok: ${editDraft.error?.[1] || ''}`);
    assert(editDraft.item.amount === 48000, 'EC9.2 amount updated on draft');

    // ============ EC9.3: Consumed cannot return ============
    await monthlyInputService.transition(authAdmin, [pendingId], 'post');
    await monthlyInputService.transition(authAdmin, [pendingId], 'approve');
    await monthlyInputService.transition(authAdmin, [pendingId], 'finalize');

    await pool.query(
      `UPDATE monthly_inputs SET consumed_by_run_id = 999999 WHERE id = $1`,
      [pendingId]
    );
    const returnConsumed = await monthlyInputService.transition(authAdmin, [pendingId], 'return');
    assert(!!returnConsumed.error, 'EC9.3 return consumed rejected');
    assert(returnConsumed.error[0] === 400, 'EC9.3 returns 400');
    assert(/consumed by a payroll run/i.test(returnConsumed.error[1]), 'EC9.3 message');

    // Clear consumed for cleanup
    await pool.query(`UPDATE monthly_inputs SET consumed_by_run_id = NULL WHERE id = $1`, [pendingId]);

    // ============ EC9.4: Negative amount allowed ============
    const deduction = await monthlyInputService.create(authAdmin, {
      schedule_id: scheduleId,
      period_month: periodMonth,
      entries: [
        {
          employee_id: primaryEmployeeId,
          pay_element_id: payElementId,
          amount: -3000,
          pay_date: '2026-07-28',
          pay_element_label: 'Overpayment Recovery',
        },
      ],
    });
    assert(!deduction.error, `EC9.4 negative amount: ${deduction.error?.[1] || ''}`);
    assert(deduction.items[0].amount === -3000, 'EC9.4 amount is -3000');
    createdIds.push(deduction.items[0].id);

    // ============ EC9.5: period_month mismatch → warn, allow ============
    const mismatch = await monthlyInputService.create(authAdmin, {
      schedule_id: scheduleId,
      period_month: periodMonth,
      entries: [
        {
          employee_id: primaryEmployeeId,
          pay_element_id: payElementId,
          amount: 1000,
          pay_date: '2026-08-05',
        },
      ],
    });
    assert(!mismatch.error, `EC9.5 mismatch allowed: ${mismatch.error?.[1] || ''}`);
    assert(!!mismatch.warning, 'EC9.5 warning present');
    createdIds.push(mismatch.items[0].id);

    // ============ EC9.6 / UC9.4: Bulk import atomic reject ============
    const beforeImportCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS total FROM monthly_inputs WHERE company_id = $1 AND period_month = $2`,
        [companyId, periodMonth]
      )
    ).rows[0].total;

    const badImport = await monthlyInputService.bulkCreate(authAdmin, {
      schedule_id: scheduleId,
      period_month: periodMonth,
      rows: [
        {
          employee_id: primaryEmployeeId,
          pay_element_id: payElementId,
          amount: 100,
          pay_date: '2026-07-28',
        },
        {
          employee_id: 999999999,
          pay_element_id: payElementId,
          amount: 200,
          pay_date: '2026-07-28',
        },
      ],
    });
    assert(!!badImport.error, 'EC9.6 bad import rejected');
    assert(badImport.error[0] === 400, 'EC9.6 returns 400');
    assert(Array.isArray(badImport.error[2]?.errors), 'EC9.6 errors array present');
    assert(badImport.error[2].errors.some((e) => e.row_index === 1), 'EC9.6 reports row_index 1');

    const afterImportCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS total FROM monthly_inputs WHERE company_id = $1 AND period_month = $2`,
        [companyId, periodMonth]
      )
    ).rows[0].total;
    assert(afterImportCount === beforeImportCount, 'EC9.6 no partial rows inserted');

    // Good import
    const goodImport = await monthlyInputService.bulkCreate(authAdmin, {
      schedule_id: scheduleId,
      period_month: periodMonth,
      is_off_cycle: false,
      rows: [
        {
          employee_id: primaryEmployeeId,
          pay_element_id: payElementId,
          amount: 2500,
          pay_date: '2026-07-28',
        },
      ],
    });
    assert(!goodImport.error, `UC9.4 good import: ${goodImport.error?.[1] || ''}`);
    assert(goodImport.count === 1, 'UC9.4 imported 1 row');
    createdIds.push(...goodImport.items.map((i) => i.id));

    // List by status
    const listFinalized = await monthlyInputService.list(authAdmin, {
      status: 'finalized',
      period_month: periodMonth,
      no_pagination: true,
    });
    assert(!listFinalized.error, 'list finalized ok');
    assert(listFinalized.items.every((i) => i.status === 'finalized'), 'list filters finalized');

    console.log('\nAll monthly inputs tests PASSED');
  } finally {
    if (createdIds.length) {
      await pool.query(`DELETE FROM monthly_inputs WHERE id = ANY($1::bigint[])`, [createdIds]);
    }
    await pool.query(`DELETE FROM pay_elements WHERE id = $1`, [payElementId]).catch(() => {});
    await pool.query(`DELETE FROM payroll_schedules WHERE id = $1`, [scheduleId]).catch(() => {});
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
