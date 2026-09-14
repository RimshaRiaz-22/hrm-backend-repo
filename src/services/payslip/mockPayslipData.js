

const BASE_COMPANY = {
  name: 'Acme Technologies (Pvt) Ltd',
  address: '12 Business Avenue, Clifton, Karachi 75600',
  logo_buffer: null,
  logo_url: null,
};

const BASE_RUN = {
  period_month: '2026-07',
  pay_date: '2026-07-28',
  is_off_cycle: false,
};

const BASE_EMPLOYEE = {
  id: 42,
  name: 'Fatima Hassan',
  employee_code: 'EMP-0042',
  designation: 'Senior Software Engineer',
  department: 'Engineering',
  email: 'fatima.hassan@example.com',
};

const BASE_ATTENDANCE = {
  present_days: 24,
  absent_days: 2,
  working_days: 26,
};

/** @type {PayslipData} */
const standardPayslipData = {
  payroll_run_id: 1001,
  payroll_run_employee_id: 5001,
  company: { ...BASE_COMPANY },
  run: { ...BASE_RUN },
  employee: { ...BASE_EMPLOYEE },
  attendance: { ...BASE_ATTENDANCE },
  totals: {
    basic_salary: 150000,
    total_allowances: 18500,
    total_deductions: 32000,
    total_contributions: 12500,
    gross_pay: 168500,
    net_pay: 136500,
  },
  lines: [
    { id: 1, line_kind: 'basic', label: 'Basic Salary', amount: 150000, source_ref: null },
    { id: 2, line_kind: 'allowance', label: 'Medical Allowance', amount: 5500, source_ref: 'pe:12' },
    { id: 3, line_kind: 'allowance', label: 'Conveyance Allowance', amount: 8000, source_ref: 'pe:13' },
    { id: 4, line_kind: 'allowance', label: 'Housing Allowance', amount: 5000, source_ref: 'pe:14' },
    { id: 5, line_kind: 'expense', label: 'Expense Reimbursement', amount: 3500, source_ref: 'expense:88' },
    { id: 6, line_kind: 'monthly_input', label: 'Performance Bonus', amount: 2500, source_ref: 'mi:21' },
    { id: 7, line_kind: 'deduction', label: 'Income Tax', amount: 18000, source_ref: 'pe:30' },
    { id: 8, line_kind: 'deduction', label: 'Employee PF Contribution', amount: 7500, source_ref: 'pe:31' },
    { id: 9, line_kind: 'loan', label: 'Personal Loan EMI', amount: 4500, source_ref: 'loan:5' },
    { id: 10, line_kind: 'absence', label: 'Absence Deduction (2 days)', amount: 2000, source_ref: 'att:2d' },
    { id: 11, line_kind: 'contribution', label: 'Employer PF Contribution', amount: 12500, source_ref: 'pe:41' },
  ],
  currency: 'PKR',
};

/** @type {PayslipData} */
const minimalPayslipData = {
  payroll_run_id: 1002,
  payroll_run_employee_id: 5002,
  company: { ...BASE_COMPANY },
  run: { ...BASE_RUN },
  employee: {
    ...BASE_EMPLOYEE,
    name: 'Ali Raza',
    employee_code: 'EMP-0010',
    designation: 'Junior Accountant',
    department: 'Finance',
  },
  attendance: {
    present_days: 26,
    absent_days: 0,
    working_days: 26,
  },
  totals: {
    basic_salary: 85000,
    total_allowances: 0,
    total_deductions: 0,
    total_contributions: 0,
    gross_pay: 85000,
    net_pay: 85000,
  },
  lines: [{ id: 1, line_kind: 'basic', label: 'Basic Salary', amount: 85000, source_ref: null }],
  currency: 'PKR',
};

/** @type {PayslipData} */
const zeroNetPayPayslipData = {
  ...standardPayslipData,
  payroll_run_employee_id: 5003,
  employee: {
    ...BASE_EMPLOYEE,
    name: 'Sara Ahmed',
    employee_code: 'EMP-0099',
  },
  totals: {
    basic_salary: 50000,
    total_allowances: 0,
    total_deductions: 50000,
    total_contributions: 0,
    gross_pay: 50000,
    net_pay: 0,
  },
  lines: [
    { id: 1, line_kind: 'basic', label: 'Basic Salary', amount: 50000, source_ref: null },
    { id: 2, line_kind: 'deduction', label: 'Advance Recovery', amount: 50000, source_ref: 'loan:9' },
  ],
};

function buildHeavyLineItemsPayslipData() {
  const allowanceLines = Array.from({ length: 22 }, (_, index) => ({
    id: 100 + index,
    line_kind: 'allowance',
    label: `Allowance Component ${index + 1} — Extended Label For Wrapping Test`,
    amount: 1500 + index * 125,
    source_ref: `pe:${200 + index}`,
  }));

  const deductionLines = Array.from({ length: 14 }, (_, index) => ({
    id: 200 + index,
    line_kind: index % 3 === 0 ? 'loan' : index % 3 === 1 ? 'absence' : 'deduction',
    label:
      index === 5
        ? 'One-Time Penalty Adjustment Via Monthly Input With Very Long Description'
        : `Deduction Item ${index + 1}`,
    amount: 800 + index * 90,
    source_ref: `ded:${index + 1}`,
  }));

  const contributionLines = [
    {
      id: 301,
      line_kind: 'contribution',
      label: 'Employer PF Contribution',
      amount: 12500,
      source_ref: 'pe:41',
    },
    {
      id: 302,
      line_kind: 'contribution',
      label: 'Employer EOBI Contribution',
      amount: 2200,
      source_ref: 'pe:42',
    },
  ];

  const lines = [
    { id: 1, line_kind: 'basic', label: 'Basic Salary', amount: 175000, source_ref: null },
    ...allowanceLines,
    { id: 50, line_kind: 'expense', label: 'Travel Expense Reimbursement', amount: 4200, source_ref: 'expense:120' },
    { id: 51, line_kind: 'monthly_input', label: 'Spot Bonus', amount: 3000, source_ref: 'mi:55' },
    {
      id: 52,
      line_kind: 'monthly_input',
      label: 'Disciplinary Penalty',
      amount: -2500,
      source_ref: 'mi:56',
    },
    ...deductionLines,
    ...contributionLines,
  ];

  const totalAllowances = allowanceLines.reduce((sum, line) => sum + line.amount, 0) + 3000 + 4200;
  const totalDeductions =
    deductionLines.reduce((sum, line) => sum + line.amount, 0) + 2500;
  const totalContributions = contributionLines.reduce((sum, line) => sum + line.amount, 0);
  const gross = 175000 + totalAllowances;
  const net = gross - totalDeductions;

  return {
    payroll_run_id: 1003,
    payroll_run_employee_id: 5004,
    company: { ...BASE_COMPANY },
    run: { ...BASE_RUN },
    employee: {
      ...BASE_EMPLOYEE,
      name: 'Muhammad Usman Khan With An Exceptionally Long Employee Name For Layout Testing',
      employee_code: 'EMP-0200',
      designation: 'Lead Full Stack Engineer — Platform Reliability',
      department: 'Engineering & Product Operations',
    },
    attendance: {
      present_days: 23.5,
      absent_days: 2.5,
      working_days: 26,
    },
    totals: {
      basic_salary: 175000,
      total_allowances: totalAllowances,
      total_deductions: totalDeductions,
      total_contributions: totalContributions,
      gross_pay: gross,
      net_pay: net,
    },
    lines,
    currency: 'PKR',
  };
}

const heavyLineItemsPayslipData = buildHeavyLineItemsPayslipData();

const MOCK_VARIANTS = {
  standard: standardPayslipData,
  minimal: minimalPayslipData,
  zero: zeroNetPayPayslipData,
  heavy: heavyLineItemsPayslipData,
};

function getMockPayslipData(variant = 'standard') {
  const key = String(variant || 'standard').trim().toLowerCase();
  return JSON.parse(JSON.stringify(MOCK_VARIANTS[key] || standardPayslipData));
}

function overlayEmployeeOnPayslipData(payslipData, employeeOverlay = {}) {
  const next = JSON.parse(JSON.stringify(payslipData));
  next.employee = {
    ...next.employee,
    ...employeeOverlay,
  };
  return next;
}

function overlayCompanyOnPayslipData(payslipData, companyOverlay = {}) {
  const next = JSON.parse(JSON.stringify(payslipData));
  next.company = {
    ...next.company,
    ...companyOverlay,
  };
  if (companyOverlay.currency) {
    next.currency = companyOverlay.currency;
  }
  return next;
}

module.exports = {
  standardPayslipData,
  minimalPayslipData,
  zeroNetPayPayslipData,
  heavyLineItemsPayslipData,
  getMockPayslipData,
  overlayEmployeeOnPayslipData,
  overlayCompanyOnPayslipData,
};
