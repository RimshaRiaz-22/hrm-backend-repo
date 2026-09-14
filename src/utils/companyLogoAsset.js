const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const sharp = require('sharp');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
const DEFAULT_LOGO_SVG = `
<svg width="420" height="120" viewBox="0 0 420 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="420" height="120" rx="20" fill="#ffffff"/>
  <rect x="14" y="14" width="92" height="92" rx="22" fill="#2563eb"/>
  <path d="M38 40v40M82 40v40M38 60h44" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>
  <text x="126" y="77" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700" fill="#172033">HRM</text>
  <text x="128" y="99" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#6b7a90">Human Resource Management</text>
</svg>`;

let defaultLogoPromise;

function isPlaceholderLogoUrl(logoUrl) {
  const value = String(logoUrl || '').trim().toLowerCase();
  return (
    !value ||
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
    return decodeURIComponent(new URL(value).pathname.match(/\/uploads\/([^/?#]+)$/i)?.[1] || '') || null;
  } catch {
    return decodeURIComponent(value.match(/\/uploads\/([^/?#]+)/i)?.[1] || '') || null;
  }
}

function fetchRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 10000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchRemoteBuffer(new URL(response.headers.location, url).toString()).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to fetch logo (${response.statusCode})`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Logo fetch timed out')));
  });
}

async function toPdfPngBuffer(input) {
  return sharp(input, { density: 288, failOn: 'none' })
    .rotate()
    .resize({ width: 840, height: 240, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
}

function getDefaultCompanyLogoBuffer() {
  if (!defaultLogoPromise) {
    defaultLogoPromise = toPdfPngBuffer(Buffer.from(DEFAULT_LOGO_SVG));
  }
  return defaultLogoPromise;
}

async function loadConfiguredLogo({ logoBuffer, logoPath, logoUrl } = {}) {
  if (Buffer.isBuffer(logoBuffer) && logoBuffer.length > 0) return logoBuffer;

  if (logoPath && fs.existsSync(logoPath)) {
    return fs.promises.readFile(logoPath);
  }

  if (isPlaceholderLogoUrl(logoUrl)) return null;
  const uploadFilename = extractUploadFilename(logoUrl);
  if (uploadFilename) {
    const localPath = path.join(UPLOAD_DIR, path.basename(uploadFilename));
    if (fs.existsSync(localPath)) return fs.promises.readFile(localPath);
  }

  if (/^https?:\/\//i.test(String(logoUrl || ''))) {
    return fetchRemoteBuffer(String(logoUrl).trim());
  }
  return null;
}

async function resolveCompanyPdfLogoBuffer(company = {}) {
  try {
    const configured = await loadConfiguredLogo({
      logoBuffer: company.logo_buffer || company.logoBuffer,
      logoPath: company.logo_path || company.logoPath,
      logoUrl: company.logo_url || company.logoUrl,
    });
    if (configured) return await toPdfPngBuffer(configured);
  } catch (error) {
    console.error('Company PDF logo load failed; using default HRM logo:', error.message);
  }
  return getDefaultCompanyLogoBuffer();
}

module.exports = {
  DEFAULT_LOGO_SVG,
  getDefaultCompanyLogoBuffer,
  resolveCompanyPdfLogoBuffer,
};
