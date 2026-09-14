require('dotenv').config();
const pool = require('../src/db');
const payElementService = require('../src/services/payElement.service');

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
  const suffix = Date.now();

  // ============ UC2.1: Fixed Allowance ============
  const medicalAllowance = await payElementService.createAllowance(authAdmin, {
    name: `Medical ${suffix}`,
    payslip_name: 'Medical Allowance',
    calc_type: 'fixed',
    calc_value: 5000,
    based_on: 'fixed',
    is_taxable: false,
  });
  assert(!medicalAllowance.error, 'UC2.1 create fixed allowance');
  assert(medicalAllowance.payElement.calc_value === 5000, 'UC2.1 calc_value is 5000');
  assert(medicalAllowance.payElement.kind === 'allowance', 'UC2.1 kind is allowance');
  const allowanceId = medicalAllowance.payElement.id;

  // ============ UC2.2: Percent Allowance ============
  const houseRentAllowance = await payElementService.createAllowance(authAdmin, {
    name: `House Rent ${suffix}`,
    payslip_name: 'House Rent Allowance',
    calc_type: 'percent_of_basic',
    calc_value: 45,
    based_on: 'fixed',
    is_taxable: true,
  });
  assert(!houseRentAllowance.error, 'UC2.2 create percent allowance');
  assert(houseRentAllowance.payElement.calc_value === 45, 'UC2.2 calc_value is 45');

  // ============ UC2.3: Present Days Based Allowance ============
  const transportAllowance = await payElementService.createAllowance(authAdmin, {
    name: `Transport ${suffix}`,
    payslip_name: 'Transport Allowance',
    calc_type: 'fixed',
    calc_value: 500,
    based_on: 'present_days',
    is_taxable: true,
  });
  assert(!transportAllowance.error, 'UC2.3 create present_days allowance');
  assert(transportAllowance.payElement.based_on === 'present_days', 'UC2.3 based_on is present_days');

  // ============ UC3.1: Deduction ============
  const employeePfDeduction = await payElementService.createDeduction(authAdmin, {
    name: `Employee PF ${suffix}`,
    payslip_name: 'Employee PF',
    calc_type: 'percent_of_basic',
    calc_value: 8.33,
    based_on: 'fixed',
    is_taxable: false,
  });
  assert(!employeePfDeduction.error, 'UC3.1 create deduction');
  assert(employeePfDeduction.payElement.kind === 'deduction', 'UC3.1 kind is deduction');
  const deductionId = employeePfDeduction.payElement.id;

  // ============ UC4.1: Contribution ============
  const employerPfContribution = await payElementService.createContribution(authAdmin, {
    name: `Employer PF ${suffix}`,
    payslip_name: 'Employer PF Contribution',
    calc_type: 'percent_of_basic',
    calc_value: 8.33,
    based_on: 'fixed',
    is_taxable: false,
  });
  assert(!employerPfContribution.error, 'UC4.1 create contribution');
  assert(employerPfContribution.payElement.kind === 'contribution', 'UC4.1 kind is contribution');

  // ============ EC2.1: Percent > 100 (warn but allow) ============
  const overHundred = await payElementService.createAllowance(authAdmin, {
    name: `Over Basic ${suffix}`,
    payslip_name: 'Over Basic Allowance',
    calc_type: 'percent_of_basic',
    calc_value: 150,
    based_on: 'fixed',
  });
  assert(!overHundred.error, 'EC2.1 percent > 100 is allowed');
  assert(overHundred.warning && overHundred.warning.includes('Warning'), 'EC2.1 warning returned');

  // ============ EC2.2: Negative calc_value ============
  const negativeValue = await payElementService.createAllowance(authAdmin, {
    name: `Negative Test ${suffix}`,
    payslip_name: 'Negative Test',
    calc_type: 'fixed',
    calc_value: -100,
    based_on: 'fixed',
  });
  assert(negativeValue.error && negativeValue.error[0] === 400, 'EC2.2 negative calc_value returns 400');
  assert(negativeValue.error[1].includes('negative'), 'EC2.2 error message mentions negative');

  // ============ EC2.3: Duplicate (company, kind, name) ============
  const duplicate = await payElementService.createAllowance(authAdmin, {
    name: `Medical ${suffix}`,
    payslip_name: 'Duplicate Medical',
    calc_type: 'fixed',
    calc_value: 1000,
    based_on: 'fixed',
  });
  assert(duplicate.error && duplicate.error[0] === 409, 'EC2.3 duplicate name returns 409');

  // ============ EC*.4: present_days on Deduction (not allowed) ============
  const invalidBasedOnDeduction = await payElementService.createDeduction(authAdmin, {
    name: `Invalid BasedOn Deduction ${suffix}`,
    payslip_name: 'Invalid BasedOn Deduction',
    calc_type: 'fixed',
    calc_value: 500,
    based_on: 'present_days',
  });
  assert(invalidBasedOnDeduction.error && invalidBasedOnDeduction.error[0] === 400, 'EC*.4 present_days on deduction returns 400');
  assert(invalidBasedOnDeduction.error[1].includes('present_days') || invalidBasedOnDeduction.error[1].includes('allowances'), 'EC*.4 error mentions allowances only');

  // ============ EC*.4: present_days on Contribution (not allowed) ============
  const invalidBasedOnContribution = await payElementService.createContribution(authAdmin, {
    name: `Invalid BasedOn Contribution ${suffix}`,
    payslip_name: 'Invalid BasedOn Contribution',
    calc_type: 'fixed',
    calc_value: 500,
    based_on: 'present_days',
  });
  assert(invalidBasedOnContribution.error && invalidBasedOnContribution.error[0] === 400, 'EC*.4 present_days on contribution returns 400');

  // ============ List Tests ============
  const allowanceList = await payElementService.listAllowances(authAdmin, { no_pagination: true });
  assert(!allowanceList.error, 'List allowances works');
  assert(Array.isArray(allowanceList.payElements), 'List returns payElements array');
  assert(allowanceList.payElements.some((e) => e.id === allowanceId), 'Medical allowance in list');

  const deductionList = await payElementService.listDeductions(authAdmin, { no_pagination: true });
  assert(!deductionList.error, 'List deductions works');
  assert(deductionList.payElements.some((e) => e.id === deductionId), 'Employee PF in list');

  const contributionList = await payElementService.listContributions(authAdmin, { no_pagination: true });
  assert(!contributionList.error, 'List contributions works');

  // ============ Update Tests ============
  const updateAllowance = await payElementService.updateAllowance(authAdmin, allowanceId, {
    name: `Medical Updated ${suffix}`,
    calc_value: 6000,
  });
  assert(!updateAllowance.error, 'Update allowance works');
  assert(updateAllowance.payElement.calc_value === 6000, 'Update changed calc_value');

  // Update with percent > 100 (warning)
  const updateOverHundred = await payElementService.updateAllowance(authAdmin, allowanceId, {
    calc_value: 120,
    calc_type: 'percent_of_basic',
  });
  assert(!updateOverHundred.error, 'Update percent > 100 is allowed');
  assert(updateOverHundred.warning && updateOverHundred.warning.includes('Warning'), 'Update percent > 100 returns warning');

  // Update present_days on deduction should fail
  const updateInvalidBasedOn = await payElementService.updateDeduction(authAdmin, deductionId, {
    based_on: 'present_days',
  });
  assert(updateInvalidBasedOn.error && updateInvalidBasedOn.error[0] === 400, 'EC*.4 update based_on on deduction returns 400');

  // ============ Delete Tests ============
  // Create a temp element to delete
  const toDelete = await payElementService.createAllowance(authAdmin, {
    name: `To Delete ${suffix}`,
    payslip_name: 'To Delete',
    calc_type: 'fixed',
    calc_value: 100,
    based_on: 'fixed',
  });
  const deleteId = toDelete.payElement.id;

  const deleteResult = await payElementService.deleteAllowance(authAdmin, deleteId);
  assert(!deleteResult.error, 'Delete allowance works');

  // Verify deleted
  const afterDelete = await pool.query(`SELECT id FROM pay_elements WHERE id = $1`, [deleteId]);
  assert(afterDelete.rowCount === 0, 'Deleted element no longer exists');

  // Delete non-existent
  const deleteNonExistent = await payElementService.deleteAllowance(authAdmin, 999999);
  assert(deleteNonExistent.error && deleteNonExistent.error[0] === 404, 'Delete non-existent returns 404');

  // ============ Cleanup ============
  // Clean up test data
  await pool.query(`DELETE FROM pay_elements WHERE company_id = $1 AND name LIKE $2`, [admin.company_id, `%${suffix}%`]);

  console.log('ALL PAY ELEMENT TESTS PASSED');
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
