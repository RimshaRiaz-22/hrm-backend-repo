const {
  loadTemplatePayslipDataForTests,
} = require('../src/services/payslip/payslipPreviewEmployee');

async function loadPrimaryPayslipData() {
  const loaded = await loadTemplatePayslipDataForTests();
  console.log('Using assigned template data:');
  console.log(' - Employee ID:', loaded.employeeId);
  console.log(' - Employee:', loaded.payslipData.employee.name);
  console.log(' - Template:', loaded.templateName || '—');
  console.log(' - Pay elements:', loaded.elementCount);
  console.log(' - Basic salary:', loaded.payslipData.totals.basic_salary);
  console.log(' - Net pay:', loaded.payslipData.totals.net_pay);
  return loaded.payslipData;
}

module.exports = {
  loadPrimaryPayslipData,
};
