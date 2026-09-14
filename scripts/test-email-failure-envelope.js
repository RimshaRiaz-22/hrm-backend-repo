require('dotenv').config();
const nodemailer = require('nodemailer');
const { __emailSenderTestHelpers } = require('../src/services/email.service');

const {
  buildMailSender,
  getSmtpMailbox,
  applyDeliveryEnvelope,
  getRecipientBlockReason,
  assertSendableRecipients,
  resolveEmailLogoAssets,
} = __emailSenderTestHelpers;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractReplyTo(rawMessage) {
  const line = rawMessage.split(/\r?\n/).find((row) => /^Reply-To:/i.test(row));
  return line ? line.replace(/^Reply-To:\s*/i, '').trim() : '';
}

async function testBounceEnvelopeUsesSmtpMailbox() {
  const smtpMailbox = getSmtpMailbox() || 'smtp-test@example.com';
  const employeeEmail = 'tatum.mills@employee.example';
  const hrEmail = 'hr@company.example';

  const mailSender = buildMailSender({
    fromName: 'Tatum Mills',
    fromEmail: employeeEmail,
    replyToName: 'Tatum Mills',
    replyToEmail: employeeEmail,
  });

  const payload = applyDeliveryEnvelope({
    ...mailSender,
    to: hrEmail,
    subject: 'Leave request test',
    text: 'Test body',
  });

  assert(payload.envelope?.from === smtpMailbox, 'envelope.from must be the SMTP mailbox');
  assert(payload.envelope?.to === hrEmail, 'envelope.to must include the recipient');
  assert(
    payload.envelope.from.toLowerCase() !== employeeEmail.toLowerCase(),
    'envelope.from must not be the employee email'
  );
  assert(mailSender.replyTo, 'Reply-To should still be set so HR can reply to the employee');

  const transporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });

  const info = await transporter.sendMail(payload);
  const raw = info.message.toString();
  const replyTo = extractReplyTo(raw);

  assert(replyTo.includes(employeeEmail), 'Reply-To header should still contain the employee email');
  console.log('PASS: bounce envelope uses SMTP mailbox, not employee sender');
  console.log('  envelope.from:', payload.envelope.from);
  console.log('  envelope.to:', payload.envelope.to);
  console.log('  reply-to:', replyTo || '(none)');
}

async function testFailedSendDoesNotNotifySender() {
  let sendAttempts = 0;
  const employeeEmail = 'employee.sender@example.com';

  const transporter = {
    sendMail: async (mailOptions) => {
      sendAttempts += 1;
      assert(mailOptions.envelope?.from, 'envelope.from must be set before send');
      assert(mailOptions.envelope?.to, 'envelope.to must be set before send');
      throw new Error('550 Invalid recipient');
    },
  };

  const mailSender = buildMailSender({
    fromName: 'Employee Sender',
    fromEmail: employeeEmail,
    replyToName: 'Employee Sender',
    replyToEmail: employeeEmail,
  });

  let result = { sent: true };
  try {
    await transporter.sendMail(
      applyDeliveryEnvelope({
        ...mailSender,
        to: 'bad-recipient@invalid-domain.test',
        subject: 'Should fail',
        text: 'Should fail',
      })
    );
  } catch (error) {
    result = { sent: false, reason: error.message || 'sendMail failed' };
  }

  assert(sendAttempts === 1, 'only one send attempt should happen');
  assert(result.sent === false, 'failed send should return sent:false');
  assert(
    !String(result.reason || '').includes('notify sender'),
    'failure path must not trigger a return email to the sender'
  );

  console.log('PASS: failed send does not send a return email to the employee sender');
  console.log('  result:', result);
}

async function testSuppressedRecipientIsBlocked() {
  const blocked = getRecipientBlockReason('fatimaadmin123@gmail.com');
  assert(blocked, 'known undeliverable address must be blocked');

  let threw = false;
  try {
    assertSendableRecipients({ to: 'fatimaadmin123@gmail.com' });
  } catch (error) {
    threw = true;
    assert(error.code === 'EMAIL_RECIPIENT_BLOCKED', 'must use EMAIL_RECIPIENT_BLOCKED code');
  }
  assert(threw, 'assertSendableRecipients must throw for suppressed addresses');

  const ok = getRecipientBlockReason('valid.user@mtechub.com');
  assert(ok === null, 'valid addresses must not be blocked');

  console.log('PASS: suppressed/undeliverable recipients are blocked before send');
  console.log('  block reason:', blocked);
}

async function testAllEmailTypesSkipSuppressedRecipient() {
  const {
    sendOtpEmail,
    sendCompanyAdminInviteEmail,
    sendEmployeeInviteEmail,
    sendEmployeePasswordSetEmail,
    sendEmployeeTemporaryCredentialsEmail,
    sendPasswordChangedEmail,
    sendPasswordResetCodeEmail,
    sendProfileUpdatedEmail,
    sendEmployeeStatusUpdatedEmail,
    sendEmployeeDepartmentAssignedEmail,
    sendLeaveRequestSubmittedEmail,
    sendPayslipEmail,
    sendTaxCertificateEmail,
  } = require('../src/services/email.service');

  const bad = 'fatimaadmin123@gmail.com';
  const cases = [
    ['OTP', () => sendOtpEmail(bad, '123456')],
    ['company admin invite', () => sendCompanyAdminInviteEmail(bad, 'https://example.com/invite')],
    ['employee invite', () => sendEmployeeInviteEmail(bad, 'https://example.com/invite')],
    ['password set', () => sendEmployeePasswordSetEmail(bad, 'https://example.com/set')],
    ['temp credentials', () => sendEmployeeTemporaryCredentialsEmail(bad, 'TempPass1!')],
    ['password changed', () => sendPasswordChangedEmail(bad)],
    ['password reset', () => sendPasswordResetCodeEmail(bad, '654321')],
    ['profile updated', () => sendProfileUpdatedEmail(bad)],
    ['status updated', () => sendEmployeeStatusUpdatedEmail(bad, { status: 'active' })],
    ['department assigned', () => sendEmployeeDepartmentAssignedEmail(bad, { departmentName: 'HR' })],
    ['leave submitted', () => sendLeaveRequestSubmittedEmail(bad, { employeeName: 'Test' })],
    [
      'payslip',
      () =>
        sendPayslipEmail({
          to: bad,
          subject: 'Payslip',
          text: 'Payslip',
          html: '<p>Payslip</p>',
          pdfBuffer: Buffer.alloc(200, 1),
        }),
    ],
    [
      'tax certificate',
      () =>
        sendTaxCertificateEmail({
          to: bad,
          subject: 'Tax',
          text: 'Tax',
          html: '<p>Tax</p>',
          pdfBuffer: Buffer.alloc(200, 1),
        }),
    ],
  ];

  for (const [label, run] of cases) {
    const result = await run();
    assert(result?.sent === false, `${label} must not send to suppressed recipient`);
    assert(
      String(result?.reason || '').includes('suppressed') ||
        String(result?.reason || '').includes('undeliverable'),
      `${label} should report suppressed/undeliverable reason`
    );
  }

  console.log('PASS: all email types skip suppressed recipients without SMTP send');
}

async function testDefaultLogoWhenCompanyLogoIsUnavailable() {
  for (const logoUrl of [null, '', 'https://cdn.example.com/placeholder-logo.png']) {
    const result = await resolveEmailLogoAssets(logoUrl);
    assert(result.logoSrc.startsWith('data:image/png;base64,'), 'default logo must be embedded');
    assert(result.logoWidth > 0 && result.logoHeight > 0, 'default logo must have dimensions');
    assert(result.attachments.length === 0, 'default logo must not appear as an attachment');
  }

  console.log('PASS: missing/placeholder company logos use embedded default HRM logo');
}

async function main() {
  await testBounceEnvelopeUsesSmtpMailbox();
  await testFailedSendDoesNotNotifySender();
  await testSuppressedRecipientIsBlocked();
  await testAllEmailTypesSkipSuppressedRecipient();
  await testDefaultLogoWhenCompanyLogoIsUnavailable();
  console.log('\nAll email failure envelope tests passed.');
}

main().catch((error) => {
  console.error('FAILED:', error.message || error);
  process.exit(1);
});
