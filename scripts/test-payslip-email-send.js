require('dotenv').config();
const payslipService = require('../src/services/payslip.service');
const { loadPrimaryPayslipData } = require('./payslip-test-helpers');

const TO_EMAIL = process.env.PAYSLIP_TEST_EMAIL_TO || process.env.SMTP_USER;

async function main() {
  if (!TO_EMAIL) {
    console.error('Set PAYSLIP_TEST_EMAIL_TO or SMTP_USER in .env');
    process.exit(1);
  }

  console.log('\nLoading payslip data from assigned salary template...');
  const payslipData = await loadPrimaryPayslipData();

  console.log('Sending real payslip email with PDF attachment to:', TO_EMAIL);
  const result = await payslipService.sendPayslipEmail(payslipData, { to: TO_EMAIL });

  if (!result.sent) {
    console.error('FAILED:', result.reason || 'Unknown error');
    process.exit(1);
  }

  console.log('SUCCESS');
  console.log(' - To:', result.to);
  console.log(' - Subject:', result.subject);
  console.log(' - Attachment:', result.filename, `(${result.attachment_bytes} bytes)`);
  console.log(' - Message ID:', result.message_id || 'n/a');
  console.log('\nOpen your inbox and look for a paperclip / PDF attachment.');
  console.log('Note: npm run test:payslip only prints email TEXT — it does not send email.');
}

main().catch((error) => {
  console.error('Payslip email send test failed:', error);
  process.exit(1);
});
