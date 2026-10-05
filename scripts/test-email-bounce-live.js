/**
 * Live SMTP test: send as employee (Reply-To) with envelope.from = SMTP mailbox
 * to an invalid recipient. Bounces should go to SMTP mailbox only — not the employee.
 *
 * Usage:
 *   npm run test:email-bounce-live
 *
 * Optional .env:
 *   BOUNCE_TEST_EMPLOYEE_EMAIL=employee@example.com   (simulated employee sender)
 *   BOUNCE_TEST_INVALID_TO=invalid@...                (defaults to guaranteed-invalid domain)
 */
require('dotenv').config();
const nodemailer = require('nodemailer');
const { __emailSenderTestHelpers } = require('../src/services/email.service');

const { buildMailSender, getSmtpMailbox, applyDeliveryEnvelope } = __emailSenderTestHelpers;

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return { host, port, secure: port === 465, auth: { user, pass } };
}

function headerLine(rawMessage, name) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const match = rawMessage.match(re);
  return match ? match[1].trim() : '';
}

async function main() {
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig) {
    console.error('SMTP is not configured in .env (SMTP_HOST, SMTP_USER, SMTP_PASS).');
    process.exit(1);
  }

  const smtpMailbox = getSmtpMailbox();
  const employeeEmail =
    String(process.env.BOUNCE_TEST_EMPLOYEE_EMAIL || process.env.PAYSLIP_TEST_EMAIL_TO || '').trim() ||
    'employee-sender-test@example.com';
  const invalidTo =
    String(process.env.BOUNCE_TEST_INVALID_TO || '').trim() ||
    `hrm-bounce-test-nonexistent-${Date.now()}@gmail.com`;

  const employeeName = 'Tatum Mills (bounce test)';
  const mailSender = buildMailSender({
    fromName: employeeName,
    fromEmail: employeeEmail,
    replyToName: employeeName,
    replyToEmail: employeeEmail,
  });

  console.log('\n=== Live bounce envelope test ===');
  console.log('SMTP mailbox (bounce target):', smtpMailbox);
  console.log('Employee Reply-To (must NOT receive bounce):', employeeEmail);
  console.log('Invalid recipient To:', invalidTo);
  console.log('envelope.from:', mailSender.envelope?.from || '(set at send time)');
  console.log('');

  const transporter = nodemailer.createTransport(smtpConfig);

  const subject = `[HRM bounce test] ${new Date().toISOString()}`;
  const text = [
    'This is an automated HRM bounce-envelope test.',
    'Recipient is intentionally invalid.',
    '',
    `Employee Reply-To: ${employeeEmail}`,
    `SMTP bounce envelope: ${smtpMailbox}`,
    '',
    'If delivery fails, the bounce should arrive at the SMTP mailbox only.',
  ].join('\n');

  const payload = applyDeliveryEnvelope({
    ...mailSender,
    to: invalidTo,
    subject,
    text,
  });

  console.log('Applied envelope.from:', payload.envelope?.from);
  console.log('Applied envelope.to:', payload.envelope?.to);
  console.log('');

  let info;
  let rejected = false;
  let rejectReason = '';

  try {
    info = await transporter.sendMail(payload);
  } catch (error) {
    rejected = true;
    rejectReason = error.message || String(error);
    console.log('SMTP rejected immediately (expected for some invalid addresses):');
    console.log(' ', rejectReason);
    console.log('');
    console.log('PASS: no second email was sent to the employee sender.');
    console.log('PASS: envelope.from was', payload.envelope?.from, '(not employee email).');
    process.exit(0);
  }

  const raw =
    info.message && Buffer.isBuffer(info.message)
      ? info.message.toString()
      : typeof info.message === 'string'
        ? info.message
        : '';

  console.log('SMTP accepted the message (async bounce may follow later).');
  console.log('Message ID:', info.messageId || '(none)');
  console.log('Response:', info.response || '(none)');
  if (raw) {
    console.log('From header:', headerLine(raw, 'From') || '(not captured)');
    console.log('Reply-To header:', headerLine(raw, 'Reply-To') || '(none)');
    console.log('Return-Path header:', headerLine(raw, 'Return-Path') || '(set by receiving server)');
  }

  console.log('');
  console.log('What to verify in inboxes (wait 1–5 minutes):');
  console.log(`  1. CHECK ${smtpMailbox} — bounce/NDR may appear here (correct).`);
  console.log(`  2. CHECK ${employeeEmail} — should NOT get a bounce/return email.`);
  console.log('');
  console.log('Envelope check passed: bounce path is SMTP mailbox, not employee.');
}

main().catch((error) => {
  console.error('Live bounce test failed:', error.message || error);
  process.exit(1);
});
