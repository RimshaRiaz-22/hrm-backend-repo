require('dotenv').config();
const pool = require('../src/db');
const payrollScheduleService = require('../src/services/payrollSchedule.service');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

async function main() {
  const match = await pool.query(`
    SELECT au.id AS admin_id, au.email AS admin_email, au.company_id
    FROM users au
    WHERE au.role = 'company_admin' AND au.is_active = TRUE AND au.company_id IS NOT NULL
    LIMIT 1
  `);

  if (match.rowCount === 0) {
    await pool.end();
    return;
  }

  const admin = match.rows[0];
  const authAdmin = { userId: admin.admin_id, email: admin.admin_email };
  const suffix = Date.now();

  // UC1.1: create Monthly Salary schedule (period 1–31, pay day 28)
  const createResult = await payrollScheduleService.create(authAdmin, {
    name: `Monthly Salary ${suffix}`,
    pay_period: 'monthly',
    start_day: 1,
    end_day: 31,
    payment_day: 28,
    holiday_payment_rule: 'before',
    is_default: false,
    is_hourly: false,
  });
  assert(!createResult.error, 'UC1.1 create monthly schedule');
  assert(createResult.schedule.payment_day === 28, 'UC1.1 payment_day is 28');
  const scheduleId = createResult.schedule.id;

  // UC1.2: mark one schedule as default
  const defaultResult = await payrollScheduleService.update(authAdmin, scheduleId, {
    is_default: true,
  });
  assert(!defaultResult.error, 'UC1.2 set default schedule');
  assert(defaultResult.schedule.is_default === true, 'UC1.2 schedule is default');

  // EC1.3: second default unsets first
  const secondCreate = await payrollScheduleService.create(authAdmin, {
    name: `Bi-Weekly ${suffix}`,
    pay_period: 'bi_weekly',
    start_day: 1,
    end_day: 14,
    payment_day: 15,
    is_default: true,
  });
  assert(!secondCreate.error, 'EC1.3 create second default schedule');
  const secondId = secondCreate.schedule.id;

  const firstAfter = await pool.query(
    `SELECT is_default FROM payroll_schedules WHERE id = $1`,
    [scheduleId]
  );
  assert(firstAfter.rows[0].is_default === false, 'EC1.3 first default was unset');

  const secondAfter = await pool.query(
    `SELECT is_default FROM payroll_schedules WHERE id = $1`,
    [secondId]
  );
  assert(secondAfter.rows[0].is_default === true, 'EC1.3 second schedule is default');

  // EC1.1: duplicate name → 409
  const duplicate = await payrollScheduleService.create(authAdmin, {
    name: `Bi-Weekly ${suffix}`,
    pay_period: 'monthly',
    start_day: 1,
    end_day: 31,
    payment_day: 28,
  });
  assert(duplicate.error && duplicate.error[0] === 409, 'EC1.1 duplicate name returns 409');

  // EC1.2: payment_day outside 1–31 → 400
  const badPaymentDay = await payrollScheduleService.create(authAdmin, {
    name: `Bad Payment Day ${suffix}`,
    pay_period: 'monthly',
    start_day: 1,
    end_day: 31,
    payment_day: 32,
  });
  assert(badPaymentDay.error && badPaymentDay.error[0] === 400, 'EC1.2 invalid payment_day returns 400');

  // EC1.5 monthly: end_day < start_day → 400
  const badMonthlyRange = await payrollScheduleService.create(authAdmin, {
    name: `Bad Monthly Range ${suffix}`,
    pay_period: 'monthly',
    start_day: 20,
    end_day: 10,
    payment_day: 28,
  });
  assert(
    badMonthlyRange.error && badMonthlyRange.error[0] === 400,
    'EC1.5 monthly end_day < start_day returns 400'
  );

  // bi_weekly wrap allowed
  const biWeeklyWrap = await payrollScheduleService.create(authAdmin, {
    name: `Bi-Weekly Wrap ${suffix}`,
    pay_period: 'bi_weekly',
    start_day: 20,
    end_day: 10,
    payment_day: 15,
  });
  assert(!biWeeklyWrap.error, 'EC1.5 bi_weekly end_day < start_day is allowed');

  // UC1.3: edit schedule
  const editResult = await payrollScheduleService.update(authAdmin, scheduleId, {
    name: `Monthly Salary Updated ${suffix}`,
    payment_day: 25,
  });
  assert(!editResult.error, 'UC1.3 edit schedule');
  assert(editResult.schedule.payment_day === 25, 'UC1.3 payment_day updated');

  // UC1.3: deactivate schedule (via update, not delete)
  const deactivateResult = await payrollScheduleService.update(authAdmin, biWeeklyWrap.schedule.id, {
    is_active: false,
  });
  assert(!deactivateResult.error, 'UC1.3 deactivate schedule');
  assert(deactivateResult.schedule.is_active === false, 'UC1.3 schedule is inactive');

  // permanent delete
  const deleteTarget = await payrollScheduleService.create(authAdmin, {
    name: `Delete Me ${suffix}`,
    pay_period: 'monthly',
    start_day: 1,
    end_day: 31,
    payment_day: 28,
  });
  assert(!deleteTarget.error, 'create schedule for delete test');
  const deleteId = deleteTarget.schedule.id;
  const deleteResult = await payrollScheduleService.remove(authAdmin, deleteId);
  assert(!deleteResult.error, 'permanent delete schedule');
  const afterDelete = await pool.query(`SELECT id FROM payroll_schedules WHERE id = $1`, [deleteId]);
  assert(afterDelete.rowCount === 0, 'deleted schedule no longer exists in database');

  // UC1.4: list schedules
  const listResult = await payrollScheduleService.list(authAdmin, { no_pagination: true });
  assert(!listResult.error, 'UC1.4 list schedules');
  assert(Array.isArray(listResult.schedules), 'UC1.4 schedules array returned');
  assert(
    listResult.schedules.some((item) => item.id === scheduleId),
    'UC1.4 list contains created schedule'
  );

  console.log('ALL PAYROLL SCHEDULE TESTS PASSED');
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
