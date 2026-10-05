require('dotenv').config();
const pool = require('../src/db');
const payrollScheduleService = require('../src/services/payrollSchedule.service');
const payElementService = require('../src/services/payElement.service');
const salaryTemplateService = require('../src/services/salaryTemplate.service');
const payrollAssignmentService = require('../src/services/payrollAssignment.service');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
  console.log('PASS:', message);
}

async function getTestAdmin() {
  const match = await pool.query(`
    SELECT au.id AS admin_id, au.email AS admin_email, au.company_id
    FROM users au
    WHERE au.role = 'company_admin' AND au.is_active = TRUE AND au.company_id IS NOT NULL
    LIMIT 1
  `);
  if (match.rowCount === 0) return null;
  const admin = match.rows[0];
  return {
    authAdmin: { userId: admin.admin_id, email: admin.admin_email },
    companyId: Number(admin.company_id),
  };
}

async function getTestEmployee(companyId) {
  const result = await pool.query(
    `SELECT id FROM employees
     WHERE company_id = $1 AND employment_status != 'exited'
     ORDER BY id ASC LIMIT 1`,
    [companyId]
  );
  return result.rowCount > 0 ? Number(result.rows[0].id) : null;
}

async function main() {
  const ctx = await getTestAdmin();
  if (!ctx) {
    console.log('SKIP: need an active company_admin user');
    await pool.end();
    return;
  }

  const { authAdmin, companyId } = ctx;
  const employeeId = await getTestEmployee(companyId);
  if (!employeeId) {
    console.log('SKIP: need at least one active employee');
    await pool.end();
    return;
  }

  const suffix = Date.now();

  const schedule = await payrollScheduleService.create(authAdmin, {
    name: `Monthly Salary Test ${suffix}`,
    pay_period: 'monthly',
    start_day: 1,
    end_day: 31,
    payment_day: 5,
  });
  assert(!schedule.error, 'setup schedule created');
  const scheduleId = schedule.schedule.id;

  const houseRent = await payElementService.createAllowance(authAdmin, {
    name: `Assign House Rent ${suffix}`,
    payslip_name: 'House Rent',
    calc_type: 'percent_of_basic',
    calc_value: 45,
  });
  assert(!houseRent.error, 'setup house rent allowance');
  const houseRentId = houseRent.payElement.id;

  const medical = await payElementService.createAllowance(authAdmin, {
    name: `Assign Medical ${suffix}`,
    payslip_name: 'Medical',
    calc_type: 'fixed',
    calc_value: 5000,
  });
  assert(!medical.error, 'setup medical allowance');
  const medicalId = medical.payElement.id;

  const fuel = await payElementService.createAllowance(authAdmin, {
    name: `Assign Fuel ${suffix}`,
    payslip_name: 'Fuel Allowance',
    calc_type: 'fixed',
    calc_value: 8000,
  });
  assert(!fuel.error, 'setup fuel allowance');
  const fuelId = fuel.payElement.id;

  const template = await salaryTemplateService.create(authAdmin, {
    name: `Senior Staff Assign ${suffix}`,
    pay_element_ids: [houseRentId, medicalId],
  });
  assert(!template.error, 'setup salary template');
  const templateId = template.template.id;

  // UC6.1: assign schedule + template to employee
  const updated = await payrollAssignmentService.updateProfile(authAdmin, employeeId, {
    payroll_schedule_id: scheduleId,
    salary_template_id: templateId,
  });
  assert(!updated.error, 'UC6.1 assign schedule and template');
  assert(updated.has_schedule, 'UC6.1 employee has schedule');
  assert(updated.payroll_schedule.id === scheduleId, 'UC6.1 schedule linked');
  assert(updated.salary_template.id === templateId, 'UC6.1 template linked');
  assert(updated.all_elements.length === 2, 'UC6.1 inherits 2 template elements');

  // UC6.3: override house rent to 55%
  const overridden = await payrollAssignmentService.updateElement(
    authAdmin,
    employeeId,
    houseRentId,
    { calc_type: 'percent_of_basic', calc_value: 55 }
  );
  assert(!overridden.error, 'UC6.3 override house rent to 55%');
  const houseRentItem = overridden.all_elements.find((item) => item.id === houseRentId);
  assert(houseRentItem?.source === 'override', 'UC6.3 marked as override');
  assert(houseRentItem?.calc_value === 55, 'UC6.3 override value saved');

  // UC6.4: add manual fuel allowance
  const withFuel = await payrollAssignmentService.addElement(authAdmin, employeeId, {
    pay_element_id: fuelId,
    calc_type: 'fixed',
    calc_value: 10000,
  });
  assert(!withFuel.error, 'UC6.4 add manual fuel allowance');
  const fuelItem = withFuel.all_elements.find((item) => item.id === fuelId);
  assert(fuelItem?.source === 'manual', 'UC6.4 fuel is manual');
  assert(fuelItem?.calc_value === 10000, 'UC6.4 fuel value saved');
  assert(withFuel.all_elements.length === 3, 'UC6.4 now has 3 elements total');

  // UC6.5: reassign template, override and manual survive
  const juniorTemplate = await salaryTemplateService.create(authAdmin, {
    name: `Junior Staff Assign ${suffix}`,
    pay_element_ids: [medicalId],
  });
  assert(!juniorTemplate.error, 'setup junior template');
  const juniorTemplateId = juniorTemplate.template.id;

  const reassigned = await payrollAssignmentService.updateProfile(authAdmin, employeeId, {
    salary_template_id: juniorTemplateId,
  });
  assert(!reassigned.error, 'UC6.5 reassign template');
  const hrAfter = reassigned.all_elements.find((item) => item.id === houseRentId);
  const fuelAfter = reassigned.all_elements.find((item) => item.id === fuelId);
  assert(hrAfter?.source === 'override' && hrAfter?.calc_value === 55, 'UC6.5 house rent override survives');
  assert(fuelAfter?.source === 'manual', 'UC6.5 manual fuel survives');
  assert(
    reassigned.all_elements.some((item) => item.id === medicalId && item.source === 'template'),
    'UC6.5 new template medical included'
  );

  // UC6.7: reject inactive element
  const inactive = await payElementService.createAllowance(authAdmin, {
    name: `Inactive COVID ${suffix}`,
    payslip_name: 'COVID Allowance',
    calc_type: 'fixed',
    calc_value: 1000,
  });
  assert(!inactive.error, 'setup inactive element');
  await payElementService.updateAllowance(authAdmin, inactive.payElement.id, { is_active: false });

  const rejected = await payrollAssignmentService.addElement(authAdmin, employeeId, {
    pay_element_id: inactive.payElement.id,
    calc_type: 'fixed',
    calc_value: 1000,
  });
  assert(rejected.error, 'UC6.7 rejects inactive element');
  assert(
    rejected.error[1].includes('inactive'),
    'UC6.7 inactive error message'
  );

  // UC6.6: bulk assign schedule to department/all scope
  const bulk = await payrollAssignmentService.bulkAssign(authAdmin, {
    assignment_scope: 'selected',
    employee_ids: [employeeId],
    payroll_schedule_id: scheduleId,
    salary_template_id: juniorTemplateId,
  });
  assert(!bulk.error, 'UC6.6 bulk assign');
  assert(bulk.assigned_count === 1, 'UC6.6 one employee assigned');

  const missing = await payrollAssignmentService.getEmployeesWithoutSchedule(companyId);
  assert(Array.isArray(missing), 'missing schedule list returns array');

  console.log('\nAll payroll assignment tests passed.');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
