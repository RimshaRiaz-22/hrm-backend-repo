const nodemailer = require('nodemailer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const sharp = require('sharp');
const { fetchCompanyBranding } = require('../utils/companyBranding');
const { DEFAULT_LOGO_SVG } = require('../utils/companyLogoAsset');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
// Header logo CSS display size (aspect ratio preserved inside this box)
const EMAIL_LOGO_DISPLAY_MAX_W = 280;
const EMAIL_LOGO_DISPLAY_MAX_H = 100;
// Embed at 3x pixel density so logos stay sharp on retina / HiDPI screens
const EMAIL_LOGO_RETINA_SCALE = 3;
const EMAIL_LOGO_EMBED_MAX_W = EMAIL_LOGO_DISPLAY_MAX_W * EMAIL_LOGO_RETINA_SCALE;
const EMAIL_LOGO_EMBED_MAX_H = EMAIL_LOGO_DISPLAY_MAX_H * EMAIL_LOGO_RETINA_SCALE;



function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  };
}

function createTransporter() {
  const config = getSmtpConfig();
  if (!config) {
    return null;
  }
  return nodemailer.createTransport(config);
}

function getFrontendAppUrl(relativePath = '/') {
  const base = String(process.env.FRONTEND_URL || 'https://hrm.mtechub.org').replace(/\/$/, '');
  const path = String(relativePath || '/').startsWith('/') ? relativePath : `/${relativePath}`;
  return `${base}${path}`;
}

/** Raw SMTP mailbox (pm@mtechub.com) — never use a spoofed employee address as From. */
function getSmtpMailbox() {
  const raw = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  console.log('SMTP mailbox:', process.env.SMTP_FROM || process.env.SMTP_USER);
  if (!raw) return '';
  const angled = raw.match(/<([^>]+)>/);
  return angled ? angled[1].trim() : raw;
}

function formatMailboxAddress(displayName, emailAddress) {
  const mailbox = String(emailAddress || '').trim();
  if (!mailbox) return null;
  const name = String(displayName || '')
    .trim()
    // Remove quote characters from the name itself
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/["'`]/g, '')
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 78);
  if (!name) return mailbox;
  // NBSP forces MIME-encoded From name so inboxes show: Acme Corp (not "Acme Corp")
  const headerName = name.replace(/ /g, '\u00A0');
  return { name: headerName, address: mailbox };
}

/**
 * Always authenticate From as the SMTP mailbox (required for delivery).
 * Show fromName as the display name; put actor/HR email in Reply-To when different.
 * envelope.from stays on the SMTP mailbox so delivery failures bounce there — not to the employee sender.
 */
function buildMailSender({ fromName, fromEmail, replyToName, replyToEmail } = {}) {
  const smtpMailbox = getSmtpMailbox();
  if (!smtpMailbox) {
    return { from: undefined };
  }

  const from = formatMailboxAddress(fromName, smtpMailbox) || smtpMailbox;
  const replyEmail = String(replyToEmail || fromEmail || '').trim();
  const replyTo =
    replyEmail && replyEmail.toLowerCase() !== smtpMailbox.toLowerCase()
      ? formatMailboxAddress(replyToName || fromName, replyEmail) || replyEmail
      : undefined;

  return {
    from,
    ...(replyTo ? { replyTo } : {}),
  };
}

function collectMailRecipients(mailOptions = {}) {
  const recipients = [];
  const pushValue = (value) => {
    if (!value) return;
    const list = Array.isArray(value) ? value : [value];
    for (const entry of list) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed) recipients.push(trimmed);
        continue;
      }
      if (entry && typeof entry === 'object' && entry.address) {
        const trimmed = String(entry.address).trim();
        if (trimmed) recipients.push(trimmed);
      }
    }
  };

  pushValue(mailOptions.to);
  pushValue(mailOptions.cc);
  pushValue(mailOptions.bcc);
  return recipients;
}

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Domains that are placeholders / never deliverable in production. */
const NON_DELIVERABLE_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'invalid',
  'localhost',
  'test',
  'local',
]);

/**
 * Known undeliverable mailboxes (Gmail 550 / address not found).
 * Extend via EMAIL_SUPPRESSED_RECIPIENTS=addr1,addr2 in .env.
 */
const DEFAULT_SUPPRESSED_RECIPIENTS = ['fatimaadmin123@gmail.com'];

function normalizeRecipientEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getSuppressedRecipientEmails() {
  const fromEnv = String(process.env.EMAIL_SUPPRESSED_RECIPIENTS || '')
    .split(/[,;\s]+/)
    .map((value) => normalizeRecipientEmail(value))
    .filter(Boolean);
  return new Set([...DEFAULT_SUPPRESSED_RECIPIENTS, ...fromEnv]);
}

/**
 * Returns null when the address may be sent; otherwise a short skip reason.
 * Does not prove mailbox existence — only blocks format/placeholder/suppressed addresses.
 */
function getRecipientBlockReason(toEmail) {
  const email = normalizeRecipientEmail(toEmail);
  if (!email) return 'missing recipient';
  if (!EMAIL_FORMAT_REGEX.test(email)) return 'invalid email format';
  if (getSuppressedRecipientEmails().has(email)) {
    return 'recipient is suppressed (known undeliverable)';
  }
  const domain = email.split('@')[1] || '';
  if (NON_DELIVERABLE_EMAIL_DOMAINS.has(domain)) {
    return `non-deliverable domain (${domain})`;
  }
  return null;
}

/** Shared early-exit for every outbound email type. */
function blockedRecipientResult(toEmail, label = 'Email') {
  const reason = getRecipientBlockReason(toEmail);
  if (!reason) return null;
  console.error(`${label} skipped for ${normalizeRecipientEmail(toEmail) || '(empty)'}: ${reason}`);
  return { sent: false, reason };
}

function assertSendableRecipients(mailOptions = {}) {
  const blocked = [];
  for (const recipient of collectMailRecipients(mailOptions)) {
    const reason = getRecipientBlockReason(recipient);
    if (reason) blocked.push({ recipient: normalizeRecipientEmail(recipient), reason });
  }
  if (blocked.length === 0) return;
  const detail = blocked.map((row) => `${row.recipient}: ${row.reason}`).join('; ');
  const error = new Error(`Email not sent — blocked recipient(s): ${detail}`);
  error.code = 'EMAIL_RECIPIENT_BLOCKED';
  error.blocked = blocked;
  throw error;
}

/** Keep bounce/return-path on the authenticated SMTP mailbox, not the employee Reply-To. */
function applyDeliveryEnvelope(mailOptions = {}) {
  const smtpMailbox = getSmtpMailbox();
  const recipients = collectMailRecipients(mailOptions);
  if (!smtpMailbox || recipients.length === 0) {
    return mailOptions;
  }

  return {
    ...mailOptions,
    envelope: {
      from: smtpMailbox,
      to: recipients.join(', '),
    },
  };
}

async function sendSystemMail(transporter, mailOptions) {
  assertSendableRecipients(mailOptions);
  return transporter.sendMail(applyDeliveryEnvelope(mailOptions));
}

function isPlaceholderLogoUrl(logoUrl) {
  const value = String(logoUrl || '').trim().toLowerCase();
  if (!value) return true;
  return (
    value.includes('cdn.example.com') ||
    value.includes('example.com/') ||
    value.includes('placeholder') ||
    value === 'null' ||
    value === 'undefined'
  );
}

function extractUploadFilename(logoUrl) {
  const value = String(logoUrl || '').trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/\/uploads\/([^/?#]+)$/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    const match = value.match(/\/uploads\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function getPublicUploadBases() {
  const bases = [];
  const envKeys = [
    'PUBLIC_UPLOAD_BASE_URL',
    'PUBLIC_API_URL',
    'BACKEND_URL',
    'API_URL',
    'APP_URL',
  ];
  for (const key of envKeys) {
    const raw = String(process.env[key] || '').trim();
    if (!raw) continue;
    bases.push(raw.replace(/\/api\/?$/i, '').replace(/\/$/, ''));
  }
  bases.push('http://localhost:3002');
  bases.push('https://hrm.testing.mtechub.org');
  return [...new Set(bases)];
}

function buildCandidateLogoUrls(logoUrl) {
  const trimmed = String(logoUrl || '').trim();
  if (!trimmed) return [];

  const urls = [trimmed];
  const filename = extractUploadFilename(trimmed);
  if (filename) {
    for (const base of getPublicUploadBases()) {
      urls.push(`${base}/uploads/${filename}`);
    }
  }
  return [...new Set(urls)];
}

function guessMimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const mimeByExt = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  return mimeByExt[ext] || 'image/png';
}

function readLogoFromUploads(filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!fs.existsSync(filePath)) return null;
  return {
    filename: safeName,
    content: fs.readFileSync(filePath),
    contentType: guessMimeFromFilename(safeName),
  };
}

function fetchRemoteImage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const request = lib.get(url, { timeout: 10000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchRemoteImage(response.headers.location).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch logo (${response.statusCode})`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          content: Buffer.concat(chunks),
          contentType: String(response.headers['content-type'] || 'image/png')
            .split(';')[0]
            .trim(),
        });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('Logo fetch timed out'));
    });
  });
}

function isSvgLogo(contentType, filename) {
  const mime = String(contentType || '').toLowerCase();
  return mime.includes('svg') || /\.svg$/i.test(String(filename || ''));
}

/**
 * Map embedded pixel size → CSS display size without stretching.
 * High-res (retina) embeds are shown at ~1/EMAIL_LOGO_RETINA_SCALE so they stay crisp.
 */
function computeLogoDisplayDimensions(embedW, embedH) {
  const width = Math.max(1, Number(embedW) || 1);
  const height = Math.max(1, Number(embedH) || 1);

  // Retina embeds are much larger than the CSS box — show them at 1/scale
  const useRetina =
    width >= EMAIL_LOGO_DISPLAY_MAX_W * 1.5 || height >= EMAIL_LOGO_DISPLAY_MAX_H * 1.5;

  let displayW = useRetina ? width / EMAIL_LOGO_RETINA_SCALE : width;
  let displayH = useRetina ? height / EMAIL_LOGO_RETINA_SCALE : height;

  const fit = Math.min(
    EMAIL_LOGO_DISPLAY_MAX_W / displayW,
    EMAIL_LOGO_DISPLAY_MAX_H / displayH,
    1
  );

  return {
    displayWidth: Math.max(1, Math.round(displayW * fit)),
    displayHeight: Math.max(1, Math.round(displayH * fit)),
  };
}

/**
 * Embed logo as base64 data URI directly in HTML (not as MIME attachment).
 * This prevents the logo from appearing in email clients' attachment strips.
 * Raster logos are never upscaled (avoids blur); SVG is rendered at high DPI.
 */
async function toInlineLogoAttachment({ content, contentType, filename }) {
  const mime = String(contentType || guessMimeFromFilename(filename) || 'image/png')
    .toLowerCase()
    .split(';')[0]
    .trim();
  const isSvg = isSvgLogo(mime, filename);

  // SVG density ~96 * retina scale so vectors render crisp at embed pixel size
  const sharpOpts = {
    density: isSvg ? Math.round(96 * EMAIL_LOGO_RETINA_SCALE) : 72,
    failOn: 'none',
  };

  let pipeline = sharp(content, sharpOpts).rotate();

  pipeline = pipeline.resize({
    width: EMAIL_LOGO_EMBED_MAX_W,
    height: EMAIL_LOGO_EMBED_MAX_H,
    fit: 'inside',
    // Never upscale PNG/JPG (blurry). SVG can safely render larger.
    withoutEnlargement: !isSvg,
    background: { r: 255, g: 255, b: 255, alpha: 0 },
    kernel: sharp.kernel.lanczos3,
  });

  // Mild sharpen after downscale — keeps edges crisp without looking over-processed
  pipeline = pipeline.sharpen({ sigma: 0.6, m1: 0.5, m2: 0.3 });

  const buffer = await pipeline
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  const outMeta = await sharp(buffer).metadata();
  const embedW = outMeta.width || EMAIL_LOGO_EMBED_MAX_W;
  const embedH = outMeta.height || EMAIL_LOGO_EMBED_MAX_H;
  const { displayWidth: displayW, displayHeight: displayH } = computeLogoDisplayDimensions(
    embedW,
    embedH
  );

  const base64 = buffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64}`;

  return {
    dataUri,
    displayWidth: displayW,
    displayHeight: displayH,
  };
}

function getDefaultEmailLogo() {
  return {
    filename: 'default-hrm-logo.svg',
    content: Buffer.from(DEFAULT_LOGO_SVG),
    contentType: 'image/svg+xml',
  };
}

async function resolveDefaultEmailLogoAssets() {
  const { dataUri, displayWidth, displayHeight } = await toInlineLogoAttachment(
    getDefaultEmailLogo()
  );
  return {
    logoSrc: dataUri,
    attachments: [],
    logoWidth: displayWidth,
    logoHeight: displayHeight,
  };
}

/**
 * Always prefer the registered company's current name + logo_url from DB when companyId is set.
 */
async function resolveCompanyEmailBranding({
  companyId,
  companyName,
  companyLogoUrl,
} = {}) {
  let name = companyName;
  let logoUrl = companyLogoUrl;
  let companyEmail = null;

  if (companyId != null && companyId !== '') {
    try {
      const branding = await fetchCompanyBranding(companyId);
      if (branding.companyName) name = branding.companyName;
      if (branding.companyLogoUrl) logoUrl = branding.companyLogoUrl;
      if (branding.companyEmail) companyEmail = branding.companyEmail;
    } catch (error) {
      console.error(`Failed to load company branding for id=${companyId}:`, error.message);
    }
  }

  const displayName = String(name || 'HRM')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    || 'HRM';
  const { logoSrc, attachments, logoWidth, logoHeight } = await resolveEmailLogoAssets(logoUrl);
  return {
    displayName,
    logoSrc,
    attachments,
    logoWidth: logoWidth || 0,
    logoHeight: logoHeight || 0,
    companyName: displayName,
    companyLogoUrl: logoUrl || null,
    companyEmail,
  };
}

/**
 * Resolve and embed logo as base64 data URI directly in HTML.
 * This ensures logo shows in email body WITHOUT appearing as an attachment.
 */
async function resolveEmailLogoAssets(companyLogoUrl) {
  const trimmed = String(companyLogoUrl || '').trim();
  if (!trimmed || isPlaceholderLogoUrl(trimmed)) {
    return resolveDefaultEmailLogoAssets();
  }

  const uploadFilename = extractUploadFilename(trimmed);
  const tryEmbed = async (logo) => {
    const { dataUri, displayWidth, displayHeight } = await toInlineLogoAttachment(logo);
    return {
      logoSrc: dataUri,  // base64 data URI - no MIME attachment
      attachments: [],  // Empty - logo is NOT an attachment
      logoWidth: displayWidth,
      logoHeight: displayHeight,
    };
  };

  if (uploadFilename) {
    const localLogo = readLogoFromUploads(uploadFilename);
    if (localLogo) {
      try {
        return await tryEmbed(localLogo);
      } catch (error) {
        console.error(`Email logo convert failed for local "${uploadFilename}":`, error.message);
      }
    }
  }

  const candidates = buildCandidateLogoUrls(trimmed);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const remoteLogo = await fetchRemoteImage(candidate);
      const filename =
        uploadFilename || path.basename(new URL(candidate).pathname) || 'company-logo.png';
      return await tryEmbed({
        filename,
        content: remoteLogo.content,
        contentType: remoteLogo.contentType || guessMimeFromFilename(filename),
      });
    } catch (error) {
      lastError = error;
    }
  }

  console.error(
    `Email logo embed failed for "${trimmed}":`,
    lastError?.message || 'no candidate URLs worked'
  );
  return resolveDefaultEmailLogoAssets();
}

function buildBrandedEmailHeaderHtml({
  logoSrc,
  displayName,
  logoWidth,
  logoHeight,
  title,
  subtitle,
}) {
  const safeName = escapeHtml(displayName);
  const safeTitle = escapeHtml(title);
  const companyLine = escapeHtml(subtitle || displayName || 'HRM');
  // Note: logoSrc (data URI) should NOT be escaped - it would break the base64
  const hasLogoSize = Number(logoWidth) > 0 && Number(logoHeight) > 0;
  const imgW = hasLogoSize ? Number(logoWidth) : EMAIL_LOGO_DISPLAY_MAX_W;
  const imgH = hasLogoSize ? Number(logoHeight) : EMAIL_LOGO_DISPLAY_MAX_H;
  const logoBlock = logoSrc
    ? `
                <table role="presentation" align="center" cellspacing="0" cellpadding="0" style="margin:0 auto 20px;">
                  <tr>
                    <td align="center" style="padding:0;line-height:0;max-width:${EMAIL_LOGO_DISPLAY_MAX_W}px;">
                      <img
                        src="${logoSrc}"
                        alt="${safeName}"
                        width="${imgW}"
                        height="${imgH}"
                        style="display:block;margin:0 auto;width:${imgW}px;max-width:${EMAIL_LOGO_DISPLAY_MAX_W}px;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;"
                      />
                    </td>
                  </tr>
                </table>`
    : '';
  return `
            <tr>
              <td style="background:#ffffff;padding:32px 28px 24px;border-bottom:1px solid #e6edf5;text-align:center;">
                ${logoBlock}
                <h1 style="margin:0;font-size:22px;line-height:1.35;font-weight:700;color:#172033;">${safeTitle}</h1>
                <p style="margin:8px 0 0;font-size:14px;line-height:1.4;color:#6b7280;">${companyLine}</p>
              </td>
            </tr>`;
}

function wrapBrandedEmailHtml({
  logoSrc,
  displayName,
  title,
  subtitle,
  bodyHtml,
  logoWidth,
  logoHeight,
}) {
  const safeName = escapeHtml(displayName);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,0.08);">
            ${buildBrandedEmailHeaderHtml({
              logoSrc,
              displayName,
              logoWidth,
              logoHeight,
              title,
              subtitle,
            })}
            <tr>
              <td style="padding:28px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.5;color:#6b7a90;">
                This is an automated message from ${safeName}. Please do not reply to this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendOtpEmail(toEmail, otpCode, { companyId, companyName, companyLogoUrl } = {}) {
  const blocked = blockedRecipientResult(toEmail, 'OTP email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Your ${displayName} OTP Code`,
    text: `Your OTP code is ${otpCode}. It will expire in 15 minutes.`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Verification Code',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#405169;">
                  Use this one-time password to verify your ${escapeHtml(displayName)} account. It expires in 15 minutes.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 8px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
                  <tr>
                    <td style="padding:20px;text-align:center;">
                      <div style="font-size:14px;color:#555;margin-bottom:8px;">OTP Code</div>
                      <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#2563eb;">${escapeHtml(otpCode)}</div>
                    </td>
                  </tr>
                </table>
                <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#6b7a90;">
                  If you did not request this code, you can ignore this email.
                </p>`,
    }),
    attachments,
  });

  return { sent: true };
}

async function sendCompanyAdminInviteEmail(
  toEmail,
  inviteUrl,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Company admin invite email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `You are invited as Company Admin — verify your account`,
    text: `You have been invited as a Company Admin for ${displayName}. Open this link to verify your account: ${inviteUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Company Admin Invite',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  You have been invited as a <strong>Company Admin</strong> for ${escapeHtml(displayName)}.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${inviteUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Verify account
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7a90;">
                  If the button does not work, copy and paste this URL into your browser:<br/>${escapeHtml(inviteUrl)}
                </p>`,
    }),
    attachments,
  });

  return { sent: true };
}

async function sendEmployeePasswordSetEmail(
  toEmail,
  setPasswordUrl,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee password-set email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Set your ${displayName} employee password`,
    text: `Your account has been verified. Open this link to set your password: ${setPasswordUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Set Your Password',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  Your employee account for <strong>${escapeHtml(displayName)}</strong> has been verified. Set your password to continue.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${setPasswordUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Set password
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7a90;">
                  If the button does not work, copy and paste this URL into your browser:<br/>${escapeHtml(setPasswordUrl)}
                </p>`,
    }),
    attachments,
  });

  return { sent: true };
}

async function sendEmployeeInviteEmail(
  toEmail,
  inviteUrl,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee invite email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `You are invited as Employee — verify your account`,
    text: `You have been invited as an Employee for ${displayName}. Open this link to verify your account: ${inviteUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Employee Invitation',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  You have been invited as an <strong>Employee</strong> for <strong>${escapeHtml(displayName)}</strong>.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${inviteUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Verify account
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7a90;">
                  If the button does not work, copy and paste this URL into your browser:<br/>${escapeHtml(inviteUrl)}
                </p>`,
    }),
    attachments,
  });

  return { sent: true };
}


// email template for employee temporary credentials email
async function sendEmployeeTemporaryCredentialsEmail(
  toEmail,
  temporaryPassword,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee temporary credentials email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const loginUrl = `${process.env.FRONTEND_URL || 'https://hrm.mtechub.org'}/login`;
  const credentialLabelStyle =
    'padding:15px 16px;font-size:14px;font-weight:600;color:#6b7a90;';
  const credentialValueStyle =
    'padding:15px 16px;font-size:14px;font-weight:600;color:#172033;text-align:right;word-break:break-all;';

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Welcome to ${displayName} - Your employee login details`,
    text:
      `Welcome to ${displayName}!\n\n` +
      `Your employee account has been created and verified.\n\n` +
      `Login email: ${toEmail}\n` +
      `Password: ${temporaryPassword}\n\n` +
      `Log in here: ${loginUrl}`,
    html: `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,0.08);">
            ${buildBrandedEmailHeaderHtml({
              logoSrc,
              displayName,
              logoWidth,
              logoHeight,
              title: `Welcome to ${displayName}`,
              subtitle: displayName,
            })}
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  Your employee account has been created and verified. Use these credentials to sign in to your ${displayName} workspace.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px;border:1px solid #dbe5ef;border-radius:10px;background:#f8fbff;">
                  <tr>
                    <td style="${credentialLabelStyle}border-bottom:1px solid #dbe5ef;">Login email</td>
                    <td style="${credentialValueStyle}border-bottom:1px solid #dbe5ef;">${toEmail}</td>
                  </tr>
                  <tr>
                    <td style="${credentialLabelStyle}">Password</td>
                    <td style="${credentialValueStyle}">${temporaryPassword}</td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px;background:#edf8ff;border:1px solid #bfe8ff;border-radius:10px;">
                  <tr>
                    <td style="padding:14px 16px;font-size:13px;line-height:1.6;color:#24546f;">
                      Your account is already verified and active. You can log in right away.
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${loginUrl}" style="display:block;width:100%;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;line-height:1.2;text-align:center;box-sizing:border-box;">Log in</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.5;color:#6b7a90;">
                This is an automated message from ${displayName}. Please do not reply to this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    attachments,
  });

  return { sent: true };
}

// email template for the "Invite Employee" onboarding flow (Company Admin → new hire)
async function sendEmployeeOnboardingInviteEmail(
  toEmail,
  onboardingUrl,
  { companyId, companyName, companyLogoUrl, employeeName } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee onboarding invite email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'SMTP is not configured' };
  }

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  const greetingName = employeeName ? escapeHtml(employeeName) : 'there';

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Welcome to ${displayName} — complete your onboarding`,
    text:
      `Hi ${employeeName || ''},\n\n` +
      `Welcome to ${displayName}! Please complete your onboarding by filling in your details and uploading your documents.\n\n` +
      `Open this link to get started: ${onboardingUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Complete Your Onboarding',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hi ${greetingName},</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  Welcome to <strong>${escapeHtml(displayName)}</strong>! Before your joining date, please complete your onboarding —
                  fill in your details and upload the required documents.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${onboardingUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Start onboarding
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7a90;">
                  If the button does not work, copy and paste this URL into your browser:<br/>${escapeHtml(onboardingUrl)}
                </p>`,
    }),
    attachments,
  });

  return { sent: true };
}

// email template notifying HR/admin that a new hire finished their onboarding submission
async function sendEmployeeOnboardingSubmittedEmail(
  toEmail,
  { companyId, companyName, companyLogoUrl, employeeName } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee onboarding submitted email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'SMTP is not configured' };
  }

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  const reviewUrl = getFrontendAppUrl('/employees');
  const safeEmployeeName = escapeHtml(employeeName || 'A new hire');

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `${employeeName || 'A new hire'} completed their onboarding application`,
    text:
      `${employeeName || 'A new hire'} has submitted their onboarding application for review.\n\n` +
      `Review it here: ${reviewUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Onboarding Application Submitted',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  <strong>${safeEmployeeName}</strong> has completed and submitted their onboarding application. Review their
                  details and documents to activate their account.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${reviewUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Review application
                      </a>
                    </td>
                  </tr>
                </table>`,
    }),
    attachments,
  });

  return { sent: true };
}

// email template telling a new hire one of their onboarding documents was rejected
async function sendEmployeeOnboardingDocumentRejectedEmail(
  toEmail,
  { companyId, companyName, companyLogoUrl, employeeName, documentLabel, reason, onboardingUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee onboarding document rejected email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'SMTP is not configured' };
  }

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  const safeDocLabel = escapeHtml(documentLabel || 'A document');
  const safeReason = escapeHtml(reason || '');
  const portalUrl = onboardingUrl || getFrontendAppUrl('/onboarding');

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Action needed: ${documentLabel || 'a document'} needs to be resubmitted`,
    text:
      `Hi ${employeeName || ''},\n\n` +
      `Your "${documentLabel || 'document'}" was not accepted and needs to be resubmitted.\n\n` +
      `Reason: ${reason || ''}\n\n` +
      `Open your onboarding portal to upload it again: ${portalUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'Document Needs Resubmission',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hi ${escapeHtml(employeeName || 'there')},</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#405169;">
                  Your <strong>${safeDocLabel}</strong> was not accepted and needs to be resubmitted.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;">
                  <tr>
                    <td style="padding:14px 16px;font-size:13px;line-height:1.6;color:#7f1d1d;">
                      <strong>Reason:</strong> ${safeReason}
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${portalUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Resubmit document
                      </a>
                    </td>
                  </tr>
                </table>`,
    }),
    attachments,
  });

  return { sent: true };
}

// email template notifying HR/admin that an invited employee's link expired and they've requested a new one
async function sendEmployeeOnboardingResendRequestedEmail(
  toEmail,
  { companyId, companyName, companyLogoUrl, employeeName, employeeId } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee onboarding resend requested email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'SMTP is not configured' };
  }

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  // Deep-links to the employee's own page with a flag the frontend picks up to fire
  // POST /employee-onboarding/:employeeId/resend itself (using the admin's own logged-in
  // session) as soon as it loads — one click actually resends, instead of just landing on
  // the employee list and making the admin find and click Resend Invite themselves.
  const reviewUrl = employeeId
    ? getFrontendAppUrl(`/employees/${employeeId}?resend_invite=1`)
    : getFrontendAppUrl('/employees');
  const safeEmployeeName = escapeHtml(employeeName || 'An invited employee');

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `${employeeName || 'An invited employee'} requested a new onboarding invite link`,
    text:
      `${employeeName || 'An invited employee'}'s onboarding invite link expired and they've requested a new one.\n\n` +
      `Resend it here (you'll need to be logged in): ${reviewUrl}`,
    html: wrapBrandedEmailHtml({
      logoSrc,
      displayName,
      logoWidth,
      logoHeight,
      title: 'New Invite Link Requested',
      subtitle: displayName,
      bodyHtml: `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">Hello,</p>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#405169;">
                  <strong>${safeEmployeeName}</strong>'s onboarding invite link has expired and they've requested a new one.
                  Click below to resend their invite (you'll need to be logged in as a company admin).
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${reviewUrl}" style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Resend invite
                      </a>
                    </td>
                  </tr>
                </table>`,
    }),
    attachments,
  });

  return { sent: true };
}


//  password changed email
async function sendPasswordChangedEmail(
  toEmail,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Password changed email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: "SMTP is not configured",
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const loginUrl = `${process.env.FRONTEND_URL || "https://hrm.mtechub.org"}/login`;

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Your ${displayName} password has been changed`,
    text:
      `Hello,\n\n` +
      `This email confirms that your ${displayName} account password was successfully changed.\n\n` +
      `If you made this change, no further action is required.\n\n` +
      `If you did not change your password, please reset it immediately or contact your administrator.\n\n` +
      `Log in here:\n${loginUrl}`,

    html: `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,0.08);">

            ${buildBrandedEmailHeaderHtml({
              logoSrc,
              displayName,
              logoWidth,
              logoHeight,
              title: 'Password Changed',
              subtitle: displayName,
            })}

            <tr>
              <td style="padding:28px;">

                <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#172033;">
                  Hello,
                </p>

                <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#405169;">
                  This email confirms that the password for your
                  <strong>${displayName}</strong> account has been successfully changed.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                  style="margin:0 0 22px;background:#edf8ff;border:1px solid #bfe8ff;border-radius:10px;">
                  <tr>
                    <td style="padding:16px;font-size:14px;line-height:1.7;color:#24546f;">
                      ✅ Your password has been updated successfully.
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a
                        href="${loginUrl}"
                        style="display:block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">
                        Log in to ${displayName}
                      </a>
                    </td>
                  </tr>
                </table>

              </td>
            </tr>

            <tr>
              <td style="padding:16px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.5;color:#6b7a90;">
                This is an automated message from ${displayName}. Please do not reply to this email.
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    attachments,
  });

  return { sent: true };
}
// forget password email template
async function sendPasswordResetCodeEmail(
  toEmail,
  resetCode,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Password reset email');
  if (blocked) return blocked;

  const transporter = createTransporter();

  if (!transporter) {
    return {
      sent: false,
      reason: "SMTP is not configured",
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const loginUrl = `${
    process.env.FRONTEND_URL || "https://hrm.mtechub.org"
  }/login`;

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Forgot your ${displayName} password?`,

    text:
      `Hello,\n\n` +
      `We received a request to reset the password for your ${displayName} account.\n\n` +
      `Your verification code is:\n\n` +
      `${resetCode}\n\n` +
      `This code will expire shortly.\n\n` +
      `Login: ${loginUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email.`,

    html: `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:32px 12px;">
<tr>
<td align="center">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0"
style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,.08);">

${buildBrandedEmailHeaderHtml({
  logoSrc,
  displayName,
  logoWidth,
  logoHeight,
  title: 'Forgot Password',
  subtitle: displayName,
})}

<tr>
<td style="padding:30px;">

<p style="margin:0 0 16px;font-size:15px;">
Hello,
</p>

<p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#405169;">
We received a request to reset the password for your
<strong>${displayName}</strong> account.
Use the verification code below to continue.
</p>

<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:24px;background:#edf8ff;border:1px solid #bfe8ff;border-radius:10px;">
<tr>
<td style="padding:18px;text-align:center;">

<div style="font-size:13px;color:#24546f;margin-bottom:10px;">
Your Password Reset Code
</div>

<div style="
font-size:36px;
font-weight:bold;
letter-spacing:10px;
color:#2563eb;
font-family:monospace;">
${resetCode}
</div>

</td>
</tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:22px;background:#fff8e8;border:1px solid #f6d68a;border-radius:10px;">
<tr>
<td style="padding:16px;font-size:14px;line-height:1.8;color:#8a5b00;">

<strong>Security Notice</strong><br><br>

• This password reset code will expire shortly.<br>
• Never share this code with anyone.<br>
• ${displayName} will never ask you for this code.<br>
• If you didn't request a password reset, you can safely ignore this email.

</td>
</tr>
</table>

<!-- LOGIN BUTTON -->
<!-- FULL WIDTH LOGIN BUTTON -->
<table
  role="presentation"
  width="100%"
  cellpadding="0"
  cellspacing="0"
  style="margin-top:24px;margin-bottom:24px;"
>
  <tr>
    <td
      align="center"
      bgcolor="#2563eb"
      style="border-radius:8px;"
    >
      <a
        href="${loginUrl}"
        style="
          display:block;
          width:100%;
          box-sizing:border-box;
          padding:16px 24px;
          background:#2563eb;
          color:#ffffff;
          text-decoration:none;
          border-radius:8px;
          font-size:16px;
          font-weight:700;
          text-align:center;
        "
      >
        Login
      </a>
    </td>
  </tr>
</table>

</td>
</tr>

<tr>
<td style="padding:18px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.6;color:#6b7a90;">
This is an automated message from <strong>${displayName}</strong>.
Please do not reply to this email.
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
`,
    attachments,
  });

  return { sent: true };
}

// update profile email template
async function sendProfileUpdatedEmail(
  toEmail,
  { companyId, companyName, companyLogoUrl } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Profile updated email');
  if (blocked) return blocked;

  const transporter = createTransporter();

  if (!transporter) {
    return {
      sent: false,
      reason: "SMTP is not configured",
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const actionUrl = getFrontendAppUrl('/employee/dashboard');

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,

    subject: `Your ${displayName} profile has been updated`,

    text:
      `Hello,\n\n` +
      `This email confirms that your ${displayName} profile information has been successfully updated.\n\n` +
      `If you made these changes, no further action is required.\n\n` +
      `If you did not update your profile, please log in immediately and contact your administrator.\n\n` +
      `Open: ${actionUrl}`,

    html: `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0"
style="background:#f3f7fb;padding:32px 12px;">

<tr>
<td align="center">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0"
style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,.08);">

<!-- HEADER -->
${buildBrandedEmailHeaderHtml({
  logoSrc,
  displayName,
  logoWidth,
  logoHeight,
  title: 'Profile Updated',
  subtitle: displayName,
})}

<!-- BODY -->
<tr>
<td style="padding:30px;">

<p style="margin:0 0 16px;font-size:15px;color:#172033;">
Hello,
</p>

<p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#405169;">
Your <strong>${displayName}</strong> profile information has been
successfully updated.
</p>

<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:24px;background:#edf8ff;border:1px solid #bfe8ff;border-radius:10px;">

<tr>

<td style="padding:18px;font-size:15px;color:#24546f;line-height:1.8;">

✅ Your profile has been updated successfully.

</td>

</tr>

</table>

<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:24px;background:#fff8e8;border:1px solid #f6d68a;border-radius:10px;">

<tr>

<td style="padding:16px;font-size:14px;line-height:1.8;color:#8a5b00;">

<strong>Security Notice</strong><br><br>

• If you updated your profile, no further action is required.<br>
• If you didn't make these changes, please log in immediately.<br>
• Contact your administrator if you notice any unauthorized changes.

</td>

</tr>

</table>

<!-- LOGIN BUTTON -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">

<tr>

<td bgcolor="#2563eb"
style="border-radius:8px;">

<a
href="${actionUrl}"
style="
display:block;
width:100%;
padding:15px 0;
background:#2563eb;
color:#ffffff;
text-decoration:none;
font-size:16px;
font-weight:700;
text-align:center;
border-radius:8px;
box-sizing:border-box;">
Login 
</a>

</td>

</tr>

</table>

</td>
</tr>

<!-- FOOTER -->
<tr>

<td style="padding:18px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.6;color:#6b7a90;">

This is an automated message from <strong>${displayName}</strong>.
Please do not reply to this email.

</td>

</tr>

</table>

</td>
</tr>

</table>

</body>
</html>
`,
    attachments,
  });

  return {
    sent: true,
  };
}

// Employee status updated email
async function sendEmployeeStatusUpdatedEmail(
  toEmail,
  { employeeName, companyId, companyName, companyLogoUrl, status } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Employee status email');
  if (blocked) return blocked;

  const transporter = createTransporter();

  if (!transporter) {
    return {
      sent: false,
      reason: "SMTP is not configured",
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const loginUrl = getFrontendAppUrl('/login');
  const dashboardUrl = getFrontendAppUrl('/employee/dashboard');

  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });

  const isActive = String(status).toLowerCase() === "active";
  const actionUrl = isActive ? dashboardUrl : loginUrl;

  const statusColor = isActive ? "#16a34a" : "#dc2626";
  const statusBg = isActive ? "#ecfdf5" : "#fef2f2";
  const statusBorder = isActive ? "#bbf7d0" : "#fecaca";
  const statusText = isActive ? "Active" : "Inactive";
  const statusMessage = isActive
    ? "Your employee account has been activated. You can now log in and access the system."
    : "Your employee account has been deactivated. You will not be able to log in until your account is activated again.";

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `Your ${displayName} account status has been updated`,

    text:
      `Hello ${employeeName || ""},\n\n` +
      `Your ${displayName} account status has been updated.\n\n` +
      `Current Status: ${statusText}\n\n` +
      `${statusMessage}\n\n` +
      `Open: ${actionUrl}`,

    html: `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f7fb;padding:32px 12px;">
<tr>
<td align="center">

<table width="100%" cellpadding="0" cellspacing="0"
style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,.08);">

${buildBrandedEmailHeaderHtml({
  logoSrc,
  displayName,
  logoWidth,
  logoHeight,
  title: 'Employee Status Updated',
  subtitle: displayName,
})}

<tr>
<td style="padding:30px;">

<p style="margin:0 0 16px;font-size:15px;">
Hello ${employeeName || "Employee"},
</p>

<p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#405169;">
Your account status has been updated by your administrator.
</p>

<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:24px;background:${statusBg};border:1px solid ${statusBorder};border-radius:10px;">
<tr>
<td style="padding:20px;text-align:center;">

<div style="font-size:14px;color:#555;margin-bottom:8px;">
Current Account Status
</div>

<div style="
font-size:30px;
font-weight:bold;
color:${statusColor};">
${statusText}
</div>

</td>
</tr>
</table>

<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#405169;">
${statusMessage}
</p>

${
  isActive
    ? `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 0 0;">
  <tr>
    <td>
      <a
        href="${actionUrl}"
        style="
          display:block;
          width:100%;
          box-sizing:border-box;
          background:#2563eb;
          color:#ffffff;
          text-decoration:none;
          text-align:center;
          padding:16px;
          border-radius:8px;
          font-size:16px;
          font-weight:700;
        ">
        Login to Your Account
      </a>
    </td>
  </tr>
</table>
`
    : ""
}

</td>
</tr>

<tr>
<td style="padding:18px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.6;color:#6b7a90;">
This is an automated message from <strong>${displayName}</strong>.
Please do not reply to this email.
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
`,
    attachments,
  });

  return { sent: true };
}

async function sendEmployeeDepartmentAssignedEmail(
  toEmail,
  { employeeName, companyId, companyName, companyLogoUrl, departmentName } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Department assigned email');
  if (blocked) return blocked;

  const transporter = createTransporter();

  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const actionUrl = getFrontendAppUrl('/employee/dashboard');
  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  const departmentLabel = String(departmentName || '').trim() || 'your department';
  const assignmentMessage =
    'You have been assigned to a new department. Please review your updated assignment details in the system.';

  await sendSystemMail(transporter, {
    ...buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined }),
    to: toEmail,
    subject: `You have been assigned to ${departmentLabel} - ${displayName}`,
    text:
      `Hello ${employeeName || ''},\n\n` +
      `You have been assigned to a department at ${displayName}.\n\n` +
      `Department: ${departmentLabel}\n\n` +
      `${assignmentMessage}\n\n` +
      `Open: ${actionUrl}`,
    html: `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f7fb;padding:32px 12px;">
<tr>
<td align="center">

<table width="100%" cellpadding="0" cellspacing="0"
style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,.08);">

${buildBrandedEmailHeaderHtml({
  logoSrc,
  displayName,
  logoWidth,
  logoHeight,
  title: 'Department Assignment',
  subtitle: displayName,
})}

<tr>
<td style="padding:30px;">

<p style="margin:0 0 16px;font-size:15px;">
Hello ${employeeName || 'Employee'},
</p>

<p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#405169;">
You have been assigned to a department by your administrator.
</p>

<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:24px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
<tr>
<td style="padding:20px;text-align:center;">

<div style="font-size:14px;color:#555;margin-bottom:8px;">
Assigned Department
</div>

<div style="font-size:30px;font-weight:bold;color:#2563eb;">
${departmentLabel}
</div>

</td>
</tr>
</table>

<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#405169;">
${assignmentMessage}
</p>

<table width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 0 0;">
  <tr>
    <td>
      <a
        href="${actionUrl}"
        style="
          display:block;
          width:100%;
          box-sizing:border-box;
          background:#2563eb;
          color:#ffffff;
          text-decoration:none;
          text-align:center;
          padding:16px;
          border-radius:8px;
          font-size:16px;
          font-weight:700;
        ">
        View Your Account
      </a>
    </td>
  </tr>
</table>

</td>
</tr>

<tr>
<td style="padding:18px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.6;color:#6b7a90;">
This is an automated message from <strong>${displayName}</strong>.
Please do not reply to this email.
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
`,
    attachments,
  });

  return { sent: true };
}

async function sendBirthdayReminderEmail(
  toEmail,
  { employeeName, daysUntil, eventDateDisplay, companyId, companyName, companyLogoUrl } = {}
) {
  const isToday = Number(daysUntil) === 0;
  const dayLabel = isToday ? 'today' : `in ${daysUntil} day${Number(daysUntil) === 1 ? '' : 's'}`;
  const name = employeeName || 'A team member';

  return sendLeaveManagementEmail(toEmail, {
    companyId,
    companyName,
    companyLogoUrl,
    recipientName: 'Team',
    subject: isToday
      ? `Today is ${name}'s birthday - ${companyName || 'HRM'}`
      : `${name}'s birthday is coming up - ${companyName || 'HRM'}`,
    title: 'Birthday Reminder',
    intro: isToday
      ? `Just a friendly reminder that today is ${name}'s birthday. Take a moment to wish them well!`
      : `Just a friendly heads-up that ${name}'s birthday is coming up ${dayLabel}, on ${eventDateDisplay}. This gives you time to plan something nice.`,
    highlightLabel: 'Birthday',
    highlightValue: eventDateDisplay,
    highlightColor: '#db2777',
    highlightBg: '#fdf2f8',
    highlightBorder: '#fbcfe8',
    ctaLabel: 'View Upcoming Birthdays',
    ctaUrl: getFrontendAppUrl('/dashboard'),
  });
}

async function sendHappyBirthdayEmail(
  toEmail,
  { employeeName, companyId, companyName, companyLogoUrl } = {}
) {
  const name = employeeName || 'there';

  return sendLeaveManagementEmail(toEmail, {
    companyId,
    companyName,
    companyLogoUrl,
    recipientName: name,
    subject: `Happy Birthday, ${name}!`,
    title: 'Happy Birthday!',
    intro: `Wishing you a fantastic birthday, ${name}! Thank you for being part of the ${companyName || 'team'}. Have a wonderful day.`,
    highlightLabel: 'Wishing you',
    highlightValue: 'A Very Happy Birthday',
    highlightColor: '#db2777',
    highlightBg: '#fdf2f8',
    highlightBorder: '#fbcfe8',
    ctaLabel: 'Go to Dashboard',
    ctaUrl: getFrontendAppUrl('/employee/dashboard'),
  });
}

async function sendAnniversaryReminderEmail(
  toEmail,
  { employeeName, daysUntil, eventDateDisplay, yearsLabel, companyId, companyName, companyLogoUrl } = {}
) {
  const isToday = Number(daysUntil) === 0;
  const dayLabel = isToday ? 'today' : `in ${daysUntil} day${Number(daysUntil) === 1 ? '' : 's'}`;
  const name = employeeName || 'A team member';
  const yearsSuffix = yearsLabel ? ` ${yearsLabel}` : '';

  return sendLeaveManagementEmail(toEmail, {
    companyId,
    companyName,
    companyLogoUrl,
    recipientName: 'Team',
    subject: isToday
      ? `Today is ${name}'s work anniversary - ${companyName || 'HRM'}`
      : `${name}'s work anniversary is coming up - ${companyName || 'HRM'}`,
    title: 'Work Anniversary Reminder',
    intro: isToday
      ? `Just a friendly reminder that today is ${name}'s${yearsSuffix} work anniversary. Take a moment to congratulate them!`
      : `Just a friendly heads-up that ${name}'s${yearsSuffix} work anniversary is coming up ${dayLabel}, on ${eventDateDisplay}.`,
    highlightLabel: 'Work Anniversary',
    highlightValue: eventDateDisplay,
    highlightColor: '#7c3aed',
    highlightBg: '#f5f3ff',
    highlightBorder: '#ddd6fe',
    ctaLabel: 'View Team Anniversaries',
    ctaUrl: getFrontendAppUrl('/dashboard'),
  });
}

async function sendWorkAnniversaryEmail(
  toEmail,
  { employeeName, yearsLabel, companyId, companyName, companyLogoUrl } = {}
) {
  const name = employeeName || 'there';
  const yearsSuffix = yearsLabel ? ` on ${yearsLabel}` : '';

  return sendLeaveManagementEmail(toEmail, {
    companyId,
    companyName,
    companyLogoUrl,
    recipientName: name,
    subject: `Happy Work Anniversary, ${name}!`,
    intro: `Congratulations${yearsSuffix} with ${companyName || 'the team'}, ${name}! Thank you for your continued dedication and hard work.`,
    title: 'Happy Work Anniversary!',
    highlightLabel: 'Celebrating',
    highlightValue: yearsLabel ? `${yearsLabel} With The Team` : 'Your Work Anniversary',
    highlightColor: '#7c3aed',
    highlightBg: '#f5f3ff',
    highlightBorder: '#ddd6fe',
    ctaLabel: 'Go to Dashboard',
    ctaUrl: getFrontendAppUrl('/employee/dashboard'),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatLeaveDisplayDate(dateValue) {
  const raw = String(dateValue || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDisplayDateTime(dateValue) {
  const raw = String(dateValue || '').trim();
  if (!raw) return '-';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function formatAttendanceTimeChange(originalValue, correctedValue) {
  if (!originalValue && !correctedValue) return null;
  return `${formatDisplayDateTime(originalValue)} → ${formatDisplayDateTime(correctedValue)}`;
}

function buildLeaveDetailsText({
  employeeName,
  leavePolicyName,
  fromDate,
  toDate,
  totalDays,
  reason,
  hrComment,
  balanceSummary,
  correctionDate,
  originalCheckIn,
  originalCheckOut,
  correctedCheckIn,
  correctedCheckOut,
  summaryLines,
}) {
  const lines = [];
  if (employeeName) lines.push(`Employee: ${employeeName}`);
  if (correctionDate) {
    lines.push(`Correction date: ${formatLeaveDisplayDate(correctionDate)}`);
    const checkInChange = formatAttendanceTimeChange(originalCheckIn, correctedCheckIn);
    const checkOutChange = formatAttendanceTimeChange(originalCheckOut, correctedCheckOut);
    if (checkInChange) lines.push(`Check-in: ${checkInChange}`);
    if (checkOutChange) lines.push(`Check-out: ${checkOutChange}`);
  }
  if (leavePolicyName) lines.push(`Leave type: ${leavePolicyName}`);
  if (fromDate && toDate) {
    lines.push(`Dates: ${formatLeaveDisplayDate(fromDate)} to ${formatLeaveDisplayDate(toDate)}`);
  }
  if (totalDays != null && totalDays !== '') lines.push(`Days: ${totalDays}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (hrComment) lines.push(`Comment: ${hrComment}`);
  if (balanceSummary) lines.push(balanceSummary);
  if (Array.isArray(summaryLines)) {
    for (const item of summaryLines) {
      if (!item?.label || item.value == null || item.value === '') continue;
      lines.push(`${item.label}: ${item.value}`);
    }
  }
  return lines.join('\n');
}

function buildLeaveDetailsHtml({
  employeeName,
  leavePolicyName,
  fromDate,
  toDate,
  totalDays,
  reason,
  hrComment,
  balanceSummary,
  correctionDate,
  originalCheckIn,
  originalCheckOut,
  correctedCheckIn,
  correctedCheckOut,
  summaryLines,
}) {
  const rows = [];
  if (employeeName) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;width:130px;">Employee</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(employeeName)}</td></tr>`
    );
  }
  if (correctionDate) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;">Correction date</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(formatLeaveDisplayDate(correctionDate))}</td></tr>`
    );
    const checkInChange = formatAttendanceTimeChange(originalCheckIn, correctedCheckIn);
    const checkOutChange = formatAttendanceTimeChange(originalCheckOut, correctedCheckOut);
    if (checkInChange) {
      rows.push(
        `<tr><td style="padding:8px 0;color:#6b7280;">Check-in</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(checkInChange)}</td></tr>`
      );
    }
    if (checkOutChange) {
      rows.push(
        `<tr><td style="padding:8px 0;color:#6b7280;">Check-out</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(checkOutChange)}</td></tr>`
      );
    }
  }
  if (leavePolicyName) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;">Leave type</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(leavePolicyName)}</td></tr>`
    );
  }
  if (fromDate && toDate) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;">Dates</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(formatLeaveDisplayDate(fromDate))} – ${escapeHtml(formatLeaveDisplayDate(toDate))}</td></tr>`
    );
  }
  if (totalDays != null && totalDays !== '') {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;">Days</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(totalDays)}</td></tr>`
    );
  }
  if (reason) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;vertical-align:top;">Reason</td><td style="padding:8px 0;color:#172033;">${escapeHtml(reason)}</td></tr>`
    );
  }
  if (hrComment) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;vertical-align:top;">Comment</td><td style="padding:8px 0;color:#172033;">${escapeHtml(hrComment)}</td></tr>`
    );
  }
  if (balanceSummary) {
    rows.push(
      `<tr><td style="padding:8px 0;color:#6b7280;">Balance</td><td style="padding:8px 0;color:#172033;font-weight:600;">${escapeHtml(balanceSummary)}</td></tr>`
    );
  }
  if (Array.isArray(summaryLines)) {
    for (const item of summaryLines) {
      if (!item?.label || item.value == null || item.value === '') continue;
      rows.push(
        `<tr><td style="padding:8px 0;color:#6b7280;vertical-align:top;">${escapeHtml(item.label)}</td><td style="padding:8px 0;color:#172033;">${escapeHtml(String(item.value))}</td></tr>`
      );
    }
  }

  if (rows.length === 0) return '-';

  return `
<table width="100%" cellpadding="0" cellspacing="0"
style="margin:0 0 24px;background:#f8fbff;border:1px solid #dbe5ef;border-radius:10px;">
<tr>
<td style="padding:20px;">
<table width="100%" cellpadding="0" cellspacing="0">
${rows.join('')}
</table>
</td>
</tr>
</table>`;
}

async function sendLeaveManagementEmail(
  toEmail,
  {
    companyId,
    companyName,
    companyLogoUrl,
    senderName,
    senderEmail,
    fromEmail: fromEmailOverride,
    subject,
    title,
    recipientName,
    intro,
    highlightLabel,
    highlightValue,
    highlightColor = '#2563eb',
    highlightBg = '#eff6ff',
    highlightBorder = '#bfdbfe',
    details = {},
    footerNote,
    ctaLabel = 'Open HRM',
    ctaUrl,
  } = {}
) {
  const blocked = blockedRecipientResult(toEmail, 'Leave/attendance email');
  if (blocked) return blocked;

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'SMTP is not configured' };
  }

  const actionUrl = ctaUrl || getFrontendAppUrl('/login');
  const branding = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  const { displayName, logoSrc, attachments, logoWidth, logoHeight, companyEmail } = branding;
  const actorName = String(senderName || '').trim();
  const actorEmail = String(senderEmail || '').trim();
  const statusFromEmail =
    String(fromEmailOverride || '').trim() || companyEmail || undefined;

  // Employee → HR: show employee name + employee email
  // HR / status → employee: show company name + company admin/HR (or reviewer) email
  const mailSender = actorName
    ? buildMailSender({
        fromName: actorName,
        fromEmail: actorEmail || undefined,
        replyToName: actorName,
        replyToEmail: actorEmail || undefined,
      })
    : buildMailSender({
        fromName: displayName,
        fromEmail: statusFromEmail,
        replyToName: displayName,
        replyToEmail: statusFromEmail,
      });
  const greetingName = String(recipientName || '').trim() || 'there';
  const detailsText = buildLeaveDetailsText(details);
  const detailsHtml = buildLeaveDetailsHtml(details);
  const highlightBlock =
    highlightLabel && highlightValue
      ? `
<table width="100%" cellpadding="0" cellspacing="0"
style="margin-bottom:24px;background:${highlightBg};border:1px solid ${highlightBorder};border-radius:10px;">
<tr>
<td style="padding:20px;text-align:center;">
<div style="font-size:14px;color:#555;margin-bottom:8px;">${escapeHtml(highlightLabel)}</div>
<div style="font-size:28px;font-weight:bold;color:${highlightColor};">${escapeHtml(highlightValue)}</div>
</td>
</tr>
</table>`
      : '';

  const visibleFromName = actorName || displayName;
  const visibleFromEmail = actorName ? actorEmail || '' : statusFromEmail || '';
  const fromLineHtml = visibleFromEmail
    ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#6b7280;">From: <strong>${escapeHtml(visibleFromName)}</strong> &lt;${escapeHtml(visibleFromEmail)}&gt;</p>`
    : '';

  const textBody = [
    `Hello ${greetingName},`,
    '',
    intro,
    '',
    visibleFromEmail ? `From: ${visibleFromName} <${visibleFromEmail}>` : null,
    visibleFromEmail ? '' : null,
    detailsText,
    detailsText ? '' : null,
    highlightLabel && highlightValue ? `${highlightLabel}: ${highlightValue}` : null,
    highlightLabel && highlightValue ? '' : null,
    footerNote || null,
    footerNote ? '' : null,
    `Open: ${actionUrl}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  try {
    await sendSystemMail(transporter, {
      ...mailSender,
      to: toEmail,
      subject,
      text: textBody,
      html: `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f7fb;padding:32px 12px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0"
style="max-width:600px;background:#ffffff;border:1px solid #dbe5ef;border-radius:12px;overflow:hidden;box-shadow:0 12px 32px rgba(23,32,51,.08);">
${buildBrandedEmailHeaderHtml({
  logoSrc,
  displayName,
  logoWidth,
  logoHeight,
  title,
  subtitle: displayName,
})}
<tr>
<td style="padding:30px;">
<p style="margin:0 0 16px;font-size:15px;">Hello ${escapeHtml(greetingName)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#405169;">${escapeHtml(intro)}</p>
${fromLineHtml}
${highlightBlock}
${detailsHtml}
${footerNote ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#405169;">${escapeHtml(footerNote)}</p>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 0 0;">
<tr><td>
<a href="${actionUrl}" style="display:block;width:100%;box-sizing:border-box;background:#2563eb;color:#ffffff;text-decoration:none;text-align:center;padding:16px;border-radius:8px;font-size:16px;font-weight:700;">${escapeHtml(ctaLabel)}</a>
</td></tr>
</table>
</td>
</tr>
<tr>
<td style="padding:18px 28px;background:#f8fbff;border-top:1px solid #e6edf5;font-size:12px;line-height:1.6;color:#6b7a90;">
This is an automated message from <strong>${escapeHtml(displayName)}</strong>. Please do not reply to this email.
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`,
      attachments,
    });
  } catch (error) {
    console.error('Leave/attendance email sendMail failed:', error.message || error);
    return { sent: false, reason: error.message || 'sendMail failed' };
  }

  return { sent: true };
}

function buildLeaveEmailPayload({
  companyId,
  companyName,
  companyLogoUrl,
  senderName,
  senderEmail,
  fromEmail,
  recipientName,
  employeeName,
  leavePolicyName,
  fromDate,
  toDate,
  totalDays,
  reason,
  hrComment,
  balanceSummary,
}) {
  return {
    companyId,
    companyName,
    companyLogoUrl,
    senderName,
    senderEmail,
    fromEmail,
    recipientName,
    details: {
      employeeName,
      leavePolicyName,
      fromDate,
      toDate,
      totalDays,
      reason,
      hrComment,
      balanceSummary,
    },
  };
}

async function sendLeaveRequestSubmittedEmail(toEmail, payload = {}) {
  const base = buildLeaveEmailPayload({
    ...payload,
    senderName: payload.senderName || payload.employeeName,
    senderEmail: payload.senderEmail,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `New leave request from ${payload.employeeName || 'an employee'} - ${payload.companyName || 'HRM'}`,
    title: 'Leave Request Submitted',
    intro: 'A new leave request has been submitted and is awaiting your review.',
    highlightLabel: 'Status',
    highlightValue: 'Pending Review',
    highlightColor: '#2563eb',
    highlightBg: '#eff6ff',
    highlightBorder: '#bfdbfe',
    ctaLabel: 'Review Leave Request',
    ctaUrl: getFrontendAppUrl('/leave-requests'),
  });
}

async function sendLeaveRequestReceivedEmail(toEmail, payload = {}) {
  const base = buildLeaveEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your leave request has been received - ${payload.companyName || 'HRM'}`,
    title: 'Leave Request Received',
    intro: 'Your leave request has been submitted successfully. You will be notified once it has been reviewed.',
    highlightLabel: 'Status',
    highlightValue: 'Pending',
    highlightColor: '#2563eb',
    highlightBg: '#eff6ff',
    highlightBorder: '#bfdbfe',
    ctaLabel: 'View My Leave Requests',
    ctaUrl: getFrontendAppUrl('/employee-leave-requests'),
  });
}

async function sendLeaveApprovedEmail(toEmail, payload = {}) {
  const base = buildLeaveEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your leave request has been approved - ${payload.companyName || 'HRM'}`,
    title: 'Leave Approved',
    intro: 'Your leave request has been approved.',
    highlightLabel: 'Status',
    highlightValue: 'Approved',
    highlightColor: '#16a34a',
    highlightBg: '#ecfdf5',
    highlightBorder: '#bbf7d0',
    ctaLabel: 'View Leave Details',
    ctaUrl: getFrontendAppUrl('/employee-leave-requests'),
  });
}

async function sendLeaveRejectedEmail(toEmail, payload = {}) {
  const base = buildLeaveEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your leave request has been rejected - ${payload.companyName || 'HRM'}`,
    title: 'Leave Rejected',
    intro: 'Your leave request has been rejected.',
    highlightLabel: 'Status',
    highlightValue: 'Rejected',
    highlightColor: '#dc2626',
    highlightBg: '#fef2f2',
    highlightBorder: '#fecaca',
    footerNote: payload.hrComment
      ? 'Please see the comment above for more details.'
      : 'Please contact your administrator if you have questions.',
    ctaLabel: 'View Leave Details',
    ctaUrl: getFrontendAppUrl('/employee-leave-requests'),
  });
}

async function sendLeaveCancelledEmail(toEmail, payload = {}) {
  const base = buildLeaveEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Leave request cancelled - ${payload.companyName || 'HRM'}`,
    title: 'Leave Cancelled',
    intro: 'Your leave request has been cancelled.',
    highlightLabel: 'Status',
    highlightValue: 'Cancelled',
    highlightColor: '#6b7280',
    highlightBg: '#f3f4f6',
    highlightBorder: '#d1d5db',
    ctaLabel: 'View My Leave Requests',
    ctaUrl: getFrontendAppUrl('/employee-leave-requests'),
  });
}

async function sendLeaveBalanceUpdatedEmail(toEmail, payload = {}) {
  const base = buildLeaveEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  const balancePath =
    payload.audience === 'admin' ? '/leave-balance' : '/employee-leave-balance';
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your leave balance has been updated - ${payload.companyName || 'HRM'}`,
    title: 'Leave Balance Updated',
    intro: 'Your leave balance has been updated.',
    highlightLabel: 'Available Days',
    highlightValue: String(payload.availableDays ?? ''),
    highlightColor: '#7c3aed',
    highlightBg: '#f5f3ff',
    highlightBorder: '#ddd6fe',
    footerNote: payload.balanceChangeNote || null,
    ctaLabel: 'View Leave Balance',
    ctaUrl: getFrontendAppUrl(balancePath),
  });
}

function buildAttendanceCorrectionEmailPayload(payload = {}) {
  const details = payload.details || {};
  return {
    companyId: payload.companyId,
    companyName: payload.companyName,
    companyLogoUrl: payload.companyLogoUrl,
    senderName: payload.senderName,
    senderEmail: payload.senderEmail,
    fromEmail: payload.fromEmail || null,
    recipientName: payload.recipientName,
    details: {
      employeeName: payload.employeeName,
      correctionDate: details.correction_date ?? null,
      originalCheckIn: details.original_check_in ?? null,
      originalCheckOut: details.original_check_out ?? null,
      correctedCheckIn: details.corrected_check_in ?? null,
      correctedCheckOut: details.corrected_check_out ?? null,
      reason: details.reason ?? null,
      hrComment: payload.hrComment ?? null,
    },
  };
}

async function sendAttendanceCorrectionSubmittedEmail(toEmail, payload = {}) {
  const base = buildAttendanceCorrectionEmailPayload({
    ...payload,
    senderName: payload.senderName || payload.employeeName,
    senderEmail: payload.senderEmail,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `New attendance correction request from ${payload.employeeName || 'an employee'} - ${payload.companyName || 'HRM'}`,
    title: 'Attendance Correction Requested',
    intro: 'A new attendance correction request has been submitted and is awaiting your review.',
    highlightLabel: 'Status',
    highlightValue: 'Pending Review',
    highlightColor: '#2563eb',
    highlightBg: '#eff6ff',
    highlightBorder: '#bfdbfe',
    ctaLabel: 'Review Request',
    ctaUrl: getFrontendAppUrl('/requests'),
  });
}

async function sendAttendanceCorrectionApprovedEmail(toEmail, payload = {}) {
  // HR → employee: never present the employee as the sender
  const base = buildAttendanceCorrectionEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your attendance correction has been approved ${payload.companyName || 'HRM'}`,
    title: 'Attendance Correction Approved',
    intro: 'Your attendance correction request has been approved.',
    highlightLabel: 'Status',
    highlightValue: 'Approved',
    highlightColor: '#16a34a',
    highlightBg: '#ecfdf5',
    highlightBorder: '#bbf7d0',
    ctaLabel: 'View My Requests',
    ctaUrl: getFrontendAppUrl('/employee/requests'),
  });
}

async function sendAttendanceCorrectionRejectedEmail(toEmail, payload = {}) {
  // HR → employee: never present the employee as the sender
  const base = buildAttendanceCorrectionEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your attendance correction has been rejected - ${payload.companyName || 'HRM'}`,
    title: 'Attendance Correction Rejected',
    intro: 'Your attendance correction request has been rejected.',
    highlightLabel: 'Status',
    highlightValue: 'Rejected',
    highlightColor: '#dc2626',
    highlightBg: '#fef2f2',
    highlightBorder: '#fecaca',
    footerNote: payload.hrComment
      ? 'Please see the comment above for more details.'
      : 'Please contact your administrator if you have questions.',
    ctaLabel: 'View My Requests',
    ctaUrl: getFrontendAppUrl('/employee/requests'),
  });
}

function buildHrRequestEmailPayload(payload = {}) {
  return {
    companyId: payload.companyId,
    companyName: payload.companyName,
    companyLogoUrl: payload.companyLogoUrl,
    senderName: payload.senderName,
    senderEmail: payload.senderEmail,
    fromEmail: payload.fromEmail || null,
    recipientName: payload.recipientName,
    requestTypeLabel: payload.requestTypeLabel || 'Request',
    details: payload.details || {},
  };
}

async function sendHrRequestSubmittedEmail(toEmail, payload = {}) {
  const typeLabel = payload.requestTypeLabel || 'Request';
  const base = buildHrRequestEmailPayload({
    ...payload,
    senderName: payload.senderName || payload.employeeName,
    senderEmail: payload.senderEmail,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `New ${typeLabel.toLowerCase()} request from ${payload.employeeName || 'an employee'} - ${payload.companyName || 'HRM'}`,
    title: `${typeLabel} Requested`,
    intro: `A new ${typeLabel.toLowerCase()} request has been submitted and is awaiting your review.`,
    highlightLabel: 'Status',
    highlightValue: payload.highlightValue || 'Pending Review',
    highlightColor: '#2563eb',
    highlightBg: '#eff6ff',
    highlightBorder: '#bfdbfe',
    ctaLabel: 'Review Request',
    ctaUrl: getFrontendAppUrl('/requests'),
  });
}

async function sendHrRequestManagerApprovedEmail(toEmail, payload = {}) {
  const typeLabel = payload.requestTypeLabel || 'Request';
  const base = buildHrRequestEmailPayload(payload);
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `${typeLabel} request awaiting final approval - ${payload.companyName || 'HRM'}`,
    title: `${typeLabel} Awaiting Final Approval`,
    intro: `A ${typeLabel.toLowerCase()} request was approved by the line manager and is awaiting final approval.`,
    highlightLabel: 'Status',
    highlightValue: 'Manager Approved',
    highlightColor: '#2563eb',
    highlightBg: '#eff6ff',
    highlightBorder: '#bfdbfe',
    ctaLabel: 'Review Request',
    ctaUrl: getFrontendAppUrl('/requests'),
  });
}

async function sendHrRequestApprovedEmail(toEmail, payload = {}) {
  const typeLabel = payload.requestTypeLabel || 'Request';
  const base = buildHrRequestEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your ${typeLabel.toLowerCase()} request has been approved - ${payload.companyName || 'HRM'}`,
    title: `${typeLabel} Approved`,
    intro: `Your ${typeLabel.toLowerCase()} request has been approved.`,
    highlightLabel: 'Status',
    highlightValue: 'Approved',
    highlightColor: '#16a34a',
    highlightBg: '#ecfdf5',
    highlightBorder: '#bbf7d0',
    ctaLabel: 'View My Requests',
    ctaUrl: getFrontendAppUrl('/employee/requests'),
  });
}

async function sendHrRequestRejectedEmail(toEmail, payload = {}) {
  const typeLabel = payload.requestTypeLabel || 'Request';
  const base = buildHrRequestEmailPayload({
    ...payload,
    senderName: null,
    senderEmail: null,
  });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Your ${typeLabel.toLowerCase()} request has been rejected - ${payload.companyName || 'HRM'}`,
    title: `${typeLabel} Rejected`,
    intro: `Your ${typeLabel.toLowerCase()} request has been rejected.`,
    highlightLabel: 'Status',
    highlightValue: 'Rejected',
    highlightColor: '#dc2626',
    highlightBg: '#fef2f2',
    highlightBorder: '#fecaca',
    footerNote: payload.hrComment
      ? 'Please see the comment above for more details.'
      : 'Please contact your administrator if you have questions.',
    ctaLabel: 'View My Requests',
    ctaUrl: getFrontendAppUrl('/employee/requests'),
  });
}

async function sendDocumentRequirementRequestedEmail(toEmail, payload = {}) {
  const base = buildHrRequestEmailPayload({ ...payload, senderName: null, senderEmail: null });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `Document requested - ${payload.companyName || 'HRM'}`,
    title: 'Document Requested',
    intro: 'HR has requested a document from you. Please upload it at your earliest convenience.',
    highlightLabel: 'Status',
    highlightValue: 'Action Needed',
    highlightColor: '#d97706',
    highlightBg: '#fffbeb',
    highlightBorder: '#fde68a',
    ctaLabel: 'Upload Document',
    ctaUrl: getFrontendAppUrl('/employee/documents'),
  });
}

async function sendCompanyDocumentUploadedEmail(toEmail, payload = {}) {
  const base = buildHrRequestEmailPayload({ ...payload, senderName: null, senderEmail: null });
  return sendLeaveManagementEmail(toEmail, {
    ...base,
    subject: `New document uploaded for you - ${payload.companyName || 'HRM'}`,
    title: 'New Document Available',
    intro: 'A new document has been uploaded for you.',
    highlightLabel: 'Status',
    highlightValue: 'New Document',
    highlightColor: '#2563eb',
    highlightBg: '#eff6ff',
    highlightBorder: '#bfdbfe',
    ctaLabel: 'View Document',
    ctaUrl: getFrontendAppUrl('/employee/documents'),
  });
}

async function sendPayslipEmail({
  to,
  subject,
  text,
  html,
  pdfBuffer,
  attachmentFilename,
  companyId,
  companyName,
  companyLogoUrl,
}) {
  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }

  const recipient = String(to || '').trim();
  if (!recipient) {
    return {
      sent: false,
      reason: 'Recipient email is required',
    };
  }

  const blocked = blockedRecipientResult(recipient, 'Payslip email');
  if (blocked) return blocked;

  const attachmentBuffer = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer
    : Buffer.from(pdfBuffer || []);
  if (attachmentBuffer.length < 100) {
    return {
      sent: false,
      reason: 'Payslip PDF attachment is empty or invalid.',
    };
  }

  const safeFilename = String(attachmentFilename || 'payslip.pdf').replace(/[^\w.\-]/g, '_');
  const tmpPath = path.join(os.tmpdir(), `payslip-${Date.now()}-${safeFilename}`);
  const { displayName, logoSrc, attachments: logoAttachments, logoWidth, logoHeight, companyEmail } = await resolveCompanyEmailBranding({
    companyId,
    companyName,
    companyLogoUrl,
  });
  const mailSender = buildMailSender({ fromName: displayName, fromEmail: companyEmail || undefined });

  const brandedHtml =
    html && String(html).includes('<!doctype html>')
      ? html
      : wrapBrandedEmailHtml({
          logoSrc,
          displayName,
          logoWidth,
          logoHeight,
          title: 'Salary Slip',
          subtitle: displayName,
          bodyHtml: html || `<p style="margin:0;font-size:15px;line-height:1.7;color:#405169;">Please find your salary slip attached.</p>`,
        });

  try {
    fs.writeFileSync(tmpPath, attachmentBuffer);

    const info = await sendSystemMail(transporter, {
      ...mailSender,
      to: recipient,
      subject,
      text,
      html: brandedHtml,
      attachments: [
        ...logoAttachments,
        {
          filename: safeFilename,
          path: tmpPath,
          contentType: 'application/pdf',
          contentDisposition: 'attachment',
        },
      ],
    });

   

    return {
      sent: true,
      to: recipient,
      attachment_bytes: attachmentBuffer.length,
      filename: safeFilename,
      message_id: info.messageId || null,
    };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup errors
    }
  }
}

async function sendTaxCertificateEmail({ to, subject, text, html, pdfBuffer, attachmentFilename }) {
  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'SMTP is not configured',
    };
  }

  const recipient = String(to || '').trim();
  if (!recipient) {
    return {
      sent: false,
      reason: 'Recipient email is required',
    };
  }

  const blocked = blockedRecipientResult(recipient, 'Tax certificate email');
  if (blocked) return blocked;

  const attachmentBuffer = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer
    : Buffer.from(pdfBuffer || []);
  if (attachmentBuffer.length < 100) {
    return {
      sent: false,
      reason: 'Tax certificate PDF attachment is empty or invalid.',
    };
  }

  const safeFilename = String(attachmentFilename || 'tax-certificate.pdf').replace(/[^\w.\-]/g, '_');
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const tmpPath = path.join(os.tmpdir(), `tax-cert-${Date.now()}-${safeFilename}`);

  try {
    fs.writeFileSync(tmpPath, attachmentBuffer);

    const info = await sendSystemMail(transporter, {
      from,
      to: recipient,
      subject,
      text,
      html,
      attachments: [
        {
          filename: safeFilename,
          path: tmpPath,
          contentType: 'application/pdf',
          contentDisposition: 'attachment',
        },
      ],
    });

    return {
      sent: true,
      to: recipient,
      attachment_bytes: attachmentBuffer.length,
      filename: safeFilename,
      message_id: info.messageId || null,
    };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup errors
    }
  }
}

module.exports = {
  sendOtpEmail,
  sendPasswordResetCodeEmail,
  sendCompanyAdminInviteEmail,
  sendEmployeeInviteEmail,
  sendEmployeePasswordSetEmail,
  sendEmployeeTemporaryCredentialsEmail,
  sendEmployeeOnboardingInviteEmail,
  sendEmployeeOnboardingSubmittedEmail,
  sendEmployeeOnboardingDocumentRejectedEmail,
  sendEmployeeOnboardingResendRequestedEmail,
  sendPasswordChangedEmail,
  sendResetPasswordEmail: sendPasswordChangedEmail,
  sendProfileUpdatedEmail,
  sendEmployeeStatusUpdatedEmail,
  sendEmployeeDepartmentAssignedEmail,
  sendLeaveRequestSubmittedEmail,
  sendLeaveRequestReceivedEmail,
  sendLeaveApprovedEmail,
  sendLeaveRejectedEmail,
  sendLeaveCancelledEmail,
  sendLeaveBalanceUpdatedEmail,
  sendAttendanceCorrectionSubmittedEmail,
  sendAttendanceCorrectionApprovedEmail,
  sendAttendanceCorrectionRejectedEmail,
  sendHrRequestSubmittedEmail,
  sendHrRequestManagerApprovedEmail,
  sendHrRequestApprovedEmail,
  sendHrRequestRejectedEmail,
  sendDocumentRequirementRequestedEmail,
  sendCompanyDocumentUploadedEmail,
  sendPayslipEmail,
  getFrontendAppUrl,
  sendTaxCertificateEmail,
  sendBirthdayReminderEmail,
  sendHappyBirthdayEmail,
  sendAnniversaryReminderEmail,
  sendWorkAnniversaryEmail,
  getRecipientBlockReason,
  __emailSenderTestHelpers: {
    buildMailSender,
    getSmtpMailbox,
    applyDeliveryEnvelope,
    getRecipientBlockReason,
    assertSendableRecipients,
    resolveEmailLogoAssets,
  },
};

 


