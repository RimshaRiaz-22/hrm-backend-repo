require('dotenv').config();
const pool = require('../src/db');
const payElementService = require('../src/services/payElement.service');
const salaryTemplateService = require('../src/services/salaryTemplate.service');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
  console.log('PASS:', message);
}

async function main() {
  const match = await pool.query(`
    SELECT au.id AS admin_id, au.email AS admin_email, au.company_id
    FROM users au
    WHERE au.role = 'company_admin' AND au.is_active = TRUE AND au.company_id IS NOT NULL
    LIMIT 1
  `);

  if (match.rowCount === 0) {
    console.log('SKIP: need an active company_admin user');
    await pool.end();
    return;
  }

  const admin = match.rows[0];
  const authAdmin = { userId: admin.admin_id, email: admin.admin_email };
  const companyId = Number(admin.company_id);
  const suffix = Date.now();

  const allowance = await payElementService.createAllowance(authAdmin, {
    name: `Template House Rent ${suffix}`,
    payslip_name: 'House Rent',
    calc_type: 'percent_of_basic',
    calc_value: 45,
    based_on: 'fixed',
  });
  assert(!allowance.error, 'setup allowance created');
  const allowanceId = allowance.payElement.id;

  const medical = await payElementService.createAllowance(authAdmin, {
    name: `Template Medical ${suffix}`,
    payslip_name: 'Medical',
    calc_type: 'fixed',
    calc_value: 5000,
    based_on: 'fixed',
  });
  assert(!medical.error, 'setup medical allowance created');
  const medicalId = medical.payElement.id;

  const deduction = await payElementService.createDeduction(authAdmin, {
    name: `Template Employee PF ${suffix}`,
    payslip_name: 'Employee PF',
    calc_type: 'percent_of_basic',
    calc_value: 8.33,
  });
  assert(!deduction.error, 'setup deduction created');
  const deductionId = deduction.payElement.id;

  const contribution = await payElementService.createContribution(authAdmin, {
    name: `Template Employer PF ${suffix}`,
    payslip_name: 'Employer PF',
    calc_type: 'percent_of_basic',
    calc_value: 8.33,
  });
  assert(!contribution.error, 'setup contribution created');
  const contributionId = contribution.payElement.id;

  // UC5.1: create Senior Staff Package
  const created = await salaryTemplateService.create(authAdmin, {
    name: `Senior Staff Package ${suffix}`,
    pay_element_ids: [allowanceId, medicalId, deductionId, contributionId],
  });
  assert(!created.error, 'UC5.1 create template with items');
  assert(created.template.name.includes('Senior Staff Package'), 'UC5.1 template name saved');
  assert(created.items.allowances.length === 2, 'UC5.1 has 2 allowances');
  assert(created.items.deductions.length === 1, 'UC5.1 has 1 deduction');
  assert(created.items.contributions.length === 1, 'UC5.1 has 1 contribution');
  const templateId = created.template.id;

  // EC5.4: empty shell template allowed
  const emptyShell = await salaryTemplateService.create(authAdmin, {
    name: `Empty Shell ${suffix}`,
    pay_element_ids: [],
  });
  assert(!emptyShell.error, 'EC5.4 empty template allowed');
  assert(emptyShell.template.total_items === 0, 'EC5.4 has zero items');
  const emptyTemplateId = emptyShell.template.id;

  // EC5.2: duplicate ids ignored
  const withDupes = await salaryTemplateService.create(authAdmin, {
    name: `Dup Test ${suffix}`,
    pay_element_ids: [allowanceId, allowanceId, medicalId, medicalId],
  });
  assert(!withDupes.error, 'EC5.2 duplicate ids accepted');
  assert(withDupes.template.total_items === 2, 'EC5.2 duplicates collapsed to 2 items');

  // EC5.1: cross-company pay element rejected
  const otherCompanyElement = await pool.query(
    `SELECT pe.id
     FROM pay_elements pe
     WHERE pe.company_id <> $1
     LIMIT 1`,
    [companyId]
  );
  if (otherCompanyElement.rowCount > 0) {
    const foreignId = otherCompanyElement.rows[0].id;
    const crossCompany = await salaryTemplateService.create(authAdmin, {
      name: `Cross Company ${suffix}`,
      pay_element_ids: [allowanceId, foreignId],
    });
    assert(crossCompany.error && crossCompany.error[0] === 400, 'EC5.1 cross-company element returns 400');
  } else {
    const crossCompany = await salaryTemplateService.create(authAdmin, {
      name: `Cross Company ${suffix}`,
      pay_element_ids: [999999999],
    });
    assert(crossCompany.error && crossCompany.error[0] === 400, 'EC5.1 invalid element returns 400');
  }

  // UC5.3: list with item counts
  const listed = await salaryTemplateService.list(authAdmin, { search: `Senior Staff Package ${suffix}` });
  assert(!listed.error, 'UC5.3 list templates');
  assert(Array.isArray(listed.templates), 'UC5.3 returns templates array');
  const listedTemplate = listed.templates.find((t) => t.id === templateId);
  assert(listedTemplate, 'UC5.3 template found in list');
  assert(listedTemplate.allowance_count === 2, 'UC5.3 allowance_count is 2');
  assert(listedTemplate.deduction_count === 1, 'UC5.3 deduction_count is 1');
  assert(listedTemplate.contribution_count === 1, 'UC5.3 contribution_count is 1');

  // get returns grouped items
  const detail = await salaryTemplateService.get(authAdmin, templateId);
  assert(!detail.error, 'get template by id');
  assert(detail.items.allowances.length === 2, 'get grouped allowances');
  assert(detail.items.deductions.length === 1, 'get grouped deductions');
  assert(detail.items.contributions.length === 1, 'get grouped contributions');

  // UC5.2: edit template items (remove medical, keep others)
  const updated = await salaryTemplateService.update(authAdmin, templateId, {
    pay_element_ids: [allowanceId, deductionId, contributionId],
  });
  assert(!updated.error, 'UC5.2 update template items');
  assert(updated.items.allowances.length === 1, 'UC5.2 allowance removed');
  assert(updated.template.total_items === 3, 'UC5.2 total_items is 3');

  const renamed = await salaryTemplateService.update(authAdmin, templateId, {
    name: `Senior Staff Package Updated ${suffix}`,
  });
  assert(!renamed.error, 'UC5.2 rename template');
  assert(renamed.template.name.includes('Updated'), 'UC5.2 name updated');

  const employeeMatch = await pool.query(
    `SELECT e.id
     FROM employees e
     WHERE e.company_id = $1 AND e.employment_status != 'exited'
     LIMIT 1`,
    [companyId]
  );

  if (employeeMatch.rowCount > 0) {
    const employeeId = Number(employeeMatch.rows[0].id);
    const assigned = await salaryTemplateService.assignEmployees(authAdmin, templateId, {
      assignment_scope: 'selected',
      employee_ids: [employeeId],
    });
    assert(!assigned.error, 'assign template to selected employee');
    assert(assigned.assigned_count === 1, 'assigned_count is 1');

    const detailAfterAssign = await salaryTemplateService.get(authAdmin, templateId);
    assert(detailAfterAssign.assigned_employee_count === 1, 'get shows assigned employee count');
    assert(Array.isArray(detailAfterAssign.assigned_employees), 'get returns assigned_employees');
    assert(detailAfterAssign.assigned_employees[0].id === employeeId, 'assigned employee id matches');

    const jobDetails = await pool.query(
      `SELECT salary_template_id
       FROM employee_job_details
       WHERE employee_id = $1 AND company_id = $2`,
      [employeeId, companyId]
    );
    assert(Number(jobDetails.rows[0]?.salary_template_id) === templateId, 'employee-level storage updated');
  } else {
    console.log('SKIP: assign employee tests (no active employees)');
  }

  const invalidAssign = await salaryTemplateService.assignEmployees(authAdmin, templateId, {
    assignment_scope: 'selected',
    employee_ids: [999999999],
  });
  assert(invalidAssign.error && invalidAssign.error[0] === 400, 'invalid employee assignment returns 400');

  // delete templates
  await salaryTemplateService.remove(authAdmin, templateId);
  await salaryTemplateService.remove(authAdmin, emptyTemplateId);
  await salaryTemplateService.remove(authAdmin, withDupes.template.id);

  const missing = await salaryTemplateService.get(authAdmin, templateId);
  assert(missing.error && missing.error[0] === 404, 'deleted template returns 404 on get');

  console.log('ALL SALARY TEMPLATE TESTS PASSED');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
