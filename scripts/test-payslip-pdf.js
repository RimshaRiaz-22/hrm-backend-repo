require('dotenv').config();
const fs = require('fs');
const path = require('path');
const payslipService = require('../src/services/payslip.service');
const { groupPayslipLines } = require('../src/services/payslip/payslipLines');
const { formatMoney } = require('../src/services/payslip/payslipFormat');
const {
  buildLinesFromProfile,
  buildTotalsFromLines,
  computeElementAmount,
} = require('../src/services/payslip/buildPayslipFromEmployee');
const { loadPrimaryPayslipData } = require('./payslip-test-helpers');

const OUTPUT_DIR = path.join(__dirname, 'output', 'payslips');
const PREVIEW_PASSWORD = process.env.PAYSLIP_TEST_PASSWORD || 'test1234';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
  console.log('PASS:', message);
}

async function writePdf(filename, buffer) {
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, filename);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

function assertPdfBuffer(buffer, label) {
  assert(Buffer.isBuffer(buffer) && buffer.length > 1000, `${label} PDF buffer generated`);
  assert(buffer.slice(0, 5).toString() === '%PDF-', `${label} PDF has valid header`);
}

async function main() {
  console.log('\nLoading payslip data from assigned salary template...');
  const standardData = await loadPrimaryPayslipData();
  const heavyData = payslipService.getMockPayslipData('heavy');
  const minimalData = payslipService.getMockPayslipData('minimal');
  const zeroData = payslipService.getMockPayslipData('zero');

  assert(standardData.lines.length > 0, 'template payslip has line items');
  assert(standardData.totals.basic_salary > 0, 'template payslip uses employee basic salary');

  const standardPdf = await payslipService.generatePayslipPdf(standardData);
  const lockedPdf = await payslipService.generatePayslipPdf(standardData, {
    password: PREVIEW_PASSWORD,
  });
  const heavyPdf = await payslipService.generatePayslipPdf(heavyData);
  const minimalPdf = await payslipService.generatePayslipPdf(minimalData);
  const zeroPdf = await payslipService.generatePayslipPdf(zeroData);

  assertPdfBuffer(standardPdf, 'standard');
  assertPdfBuffer(lockedPdf, 'password');
  assert(lockedPdf.compare(standardPdf) !== 0, 'password PDF differs from standard PDF');

  const heavyGrouped = groupPayslipLines(heavyData.lines);
  const heavyTableRows = Math.max(heavyGrouped.earnings.length, heavyGrouped.deductions.length);
  assert(heavyTableRows >= 25, 'heavy sample has 25+ table rows');
  assert(
    heavyGrouped.deductions.some((line) => line.label.includes('Disciplinary Penalty')),
    'negative monthly_input appears on deductions side'
  );
  assert(
    heavyGrouped.deductions.find((line) => line.label.includes('Disciplinary Penalty'))?.amount > 0,
    'negative monthly_input is shown as a positive deduction amount'
  );
  assert(
    !heavyGrouped.deductions.some((line) => line.line_kind === 'contribution'),
    'employer contributions are not listed under deductions'
  );
  assert(heavyGrouped.contributions.length > 0, 'employer contributions are listed separately');

  const mockStandardData = payslipService.getMockPayslipData('standard');
  const standardGrouped = groupPayslipLines(mockStandardData.lines);
  assert(
    standardGrouped.contributions.length > 0 &&
      !standardGrouped.deductions.some((line) => line.line_kind === 'contribution'),
    'contributions stay separate from deductions'
  );

  assert(formatMoney(136500.5, 'PKR') === 'PKR 136,500.50', 'amounts use PKR with commas and 2 decimals');

  assert(computeElementAmount({ calc_type: 'fixed', calc_value: 5000 }, 100000) === 5000, 'fixed pay element amount');
  assert(
    computeElementAmount({ calc_type: 'percent_of_basic', calc_value: 10 }, 100000) === 10000,
    'percent_of_basic pay element amount'
  );

  const templateLines = buildLinesFromProfile({
    basicSalary: 100000,
    elements: [
      { id: 1, kind: 'allowance', name: 'Medical Allowance', payslip_name: 'Medical', calc_type: 'fixed', calc_value: 5000 },
      { id: 2, kind: 'deduction', name: 'Income Tax', payslip_name: 'Tax', calc_type: 'percent_of_basic', calc_value: 5 },
      { id: 3, kind: 'contribution', name: 'Employer PF', payslip_name: 'Employer PF', calc_type: 'percent_of_basic', calc_value: 10 },
    ],
  });
  const templateTotals = buildTotalsFromLines(templateLines);
  assert(templateLines.length === 4, 'template lines include basic plus assigned elements');
  assert(templateTotals.basic_salary === 100000, 'template totals use employee basic salary');
  assert(templateTotals.total_allowances === 5000, 'template totals sum allowances');
  assert(templateTotals.total_deductions === 5000, 'template totals sum deductions from template');
  assert(templateTotals.total_contributions === 10000, 'template totals sum contributions separately');
  assert(templateTotals.net_pay === 100000, 'net pay excludes employer contributions');

  assertPdfBuffer(heavyPdf, 'heavy');
  assertPdfBuffer(minimalPdf, 'minimal');
  assertPdfBuffer(zeroPdf, 'zero net pay');

  const brokenLogoData = payslipService.getMockPayslipData('standard');
  brokenLogoData.company.logo_buffer = Buffer.from('not-an-image');
  const brokenLogoPdf = await payslipService.generatePayslipPdf(brokenLogoData);
  assertPdfBuffer(brokenLogoPdf, 'invalid logo skipped');

  const standardPath = await writePdf('payslip-from-template.pdf', standardPdf);
  const lockedPath = await writePdf('payslip-from-template-password.pdf', lockedPdf);
  await writePdf('payslip-heavy-lines.pdf', heavyPdf);
  await writePdf('payslip-minimal.pdf', minimalPdf);
  await writePdf('payslip-zero-net.pdf', zeroPdf);

  const emailOpen = payslipService.buildPayslipEmailContent(standardData, {
    passwordProtected: false,
  });
  const emailLocked = payslipService.buildPayslipEmailContent(standardData, {
    passwordProtected: true,
    passwordHint: 'Use the last 4 digits of your CNIC as the PDF password.',
  });

  assert(emailOpen.subject.includes(standardData.company.name), 'email subject includes company');
  assert(
    emailOpen.text.includes(`Dear ${standardData.employee.name}`),
    'email greets employee by name'
  );
  assert(emailOpen.text.toLowerCase().includes('attached'), 'email body mentions attached slip');
  assert(!emailOpen.text.toLowerCase().includes('net pay'), 'open email body does not mention net pay');
  assert(
    !emailOpen.text.includes(String(standardData.totals.net_pay)),
    'open email does not leak net pay amount'
  );
  assert(
    emailLocked.text.toLowerCase().includes('password protected'),
    'locked email includes password note'
  );
  assert(
    emailLocked.text.includes('CNIC'),
    'locked email includes password opening instructions'
  );
  assert(
    !emailLocked.text.includes(String(standardData.totals.net_pay)),
    'locked email does not leak net pay amount'
  );

  console.log('\nGenerated files:');
  console.log(' -', standardPath);
  console.log(' -', lockedPath);
  console.log(`Password for locked sample: ${PREVIEW_PASSWORD}`);
  console.log('\nEmail preview (standard) — TEXT ONLY, no PDF sent:');
  console.log('Subject:', emailOpen.subject);
  console.log(emailOpen.text);
  console.log('\nTo send a real email with PDF attached, run: npm run test:payslip-email');
  console.log('\nAll payslip tests passed.');
}

main().catch((error) => {
  console.error('Payslip test failed:', error);
  process.exit(1);
});
