const PDFDocument = require('pdfkit');
const { encryptPDF } = require('@pdfsmaller/pdf-encrypt');
const { resolveCompanyPdfLogoBuffer } = require('../../utils/companyLogoAsset');
const { formatMoney, formatPayDate, formatPeriodMonth, truncateToWidth } = require('./payslipFormat');
const { groupPayslipLines, sumLineAmounts } = require('./payslipLines');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const TABLE_BORDER = '#d4d4d8';
const TABLE_HEADER_BG = '#f4f4f5';
const CELL_PADDING = 6;

function getCompanyInitials(name) {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter((word) => /^[A-Za-z0-9]/.test(word));
  if (!words.length) return 'CO';
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

function drawDummyLogo(doc, x, y, size, companyName) {
  const initials = getCompanyInitials(companyName);
  doc.save();
  doc.roundedRect(x, y, size, size, 6).fillAndStroke('#4f46e5', '#4338ca');
  const fontSize = initials.length > 1 ? size * 0.38 : size * 0.46;
  doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#ffffff');
  const textHeight = doc.currentLineHeight();
  doc.text(initials, x, y + (size - textHeight) / 2 + 1, {
    width: size,
    align: 'center',
    lineBreak: false,
  });
  doc.restore();
}

function resolveLogoBuffer(company = {}) {
  if (company.logo_buffer && Buffer.isBuffer(company.logo_buffer)) {
    return company.logo_buffer;
  }
  return null;
}

async function encryptPdfBuffer(pdfBuffer, password) {
  if (!password) return pdfBuffer;
  const encrypted = await encryptPDF(new Uint8Array(pdfBuffer), String(password), {
    ownerPassword: String(password),
    algorithm: 'AES-256',
  });
  return Buffer.from(encrypted);
}

function measureTextHeight(doc, text, width, fontSize) {
  doc.fontSize(fontSize);
  return doc.heightOfString(String(text || ''), { width });
}

function drawCellText(doc, text, x, y, width, rowHeight, fontSize, options = {}) {
  const { bold = false, align = 'left', color = '#000000' } = options;
  const innerWidth = width - CELL_PADDING * 2;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(color);
  const textY = y + (rowHeight - doc.currentLineHeight()) / 2;
  doc.text(truncateToWidth(doc, text, innerWidth, fontSize), x + CELL_PADDING, textY, {
    width: innerWidth,
    align,
    lineBreak: false,
  });
}

function drawRowGrid(doc, x, y, columnWidths, rowHeight, fillColor = null) {
  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
  if (fillColor) {
    doc.rect(x, y, totalWidth, rowHeight).fill(fillColor);
  }
  doc.lineWidth(0.5).strokeColor(TABLE_BORDER);
  doc.rect(x, y, totalWidth, rowHeight).stroke();
  let colX = x;
  for (let i = 0; i < columnWidths.length - 1; i += 1) {
    colX += columnWidths[i];
    doc.moveTo(colX, y).lineTo(colX, y + rowHeight).stroke();
  }
}

function computeTableMetrics(maxRows, tableTop, hasContributions) {
  const bottomSection = 34 + 12 + 20 + (hasContributions ? 36 : 0) + 24;
  const availableHeight = PAGE_HEIGHT - MARGIN - bottomSection - tableTop - 36;
  const minRowHeight = 13;
  let tableFontSize = maxRows > 22 ? 8 : maxRows > 16 ? 9 : 10;
  let rowHeight = maxRows > 22 ? 12 : maxRows > 16 ? 13 : 14;

  if (maxRows > 0) {
    const requiredHeight = maxRows * rowHeight;
    if (requiredHeight > availableHeight) {
      rowHeight = Math.max(minRowHeight, Math.floor(availableHeight / maxRows));
      if (rowHeight <= 11) tableFontSize = 7;
      else if (rowHeight <= 12) tableFontSize = 8;
      else tableFontSize = 9;
    }
  }

  return { tableFontSize, rowHeight: Math.max(rowHeight, minRowHeight) };
}

function renderPayslipPdf(doc, payslipData) {
  const currency = payslipData.currency || 'PKR';
  const periodLabel = formatPeriodMonth(payslipData.run?.period_month);
  const { earnings, deductions, contributions } = groupPayslipLines(payslipData.lines);
  const maxRows = Math.max(earnings.length, deductions.length, 1);

  let y = MARGIN;

  const logoBuffer = resolveLogoBuffer(payslipData.company);
  let logoDrawn = false;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, MARGIN, y, { fit: [72, 36], align: 'left' });
      logoDrawn = true;
    } catch {
      // Missing or invalid logo — fall through to dummy logo.
    }
  }
  if (!logoDrawn) {
    drawDummyLogo(doc, MARGIN, y, 36, payslipData.company?.name);
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor('#000000')
    .text(payslipData.company?.name || 'Company', MARGIN, y, {
      width: CONTENT_WIDTH,
      align: 'right',
    });

  y += 18;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#444444')
    .text(payslipData.company?.address || '', MARGIN, y, {
      width: CONTENT_WIDTH,
      align: 'right',
    });

  y += 34;
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor('#000000')
    .text('Salary Slip', MARGIN, y, { width: CONTENT_WIDTH, align: 'center' });
  y += 20;
  doc
    .font('Helvetica')
    .fontSize(11)
    .text(periodLabel, MARGIN, y, { width: CONTENT_WIDTH, align: 'center' });

  y += 28;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text('Employee Information', MARGIN, y);
  y += 16;

  const infoPairs = [
    ['Employee Name', payslipData.employee?.name || '—'],
    ['Employee Code', payslipData.employee?.employee_code || '—'],
    ['Designation', payslipData.employee?.designation || '—'],
    ['Department', payslipData.employee?.department || '—'],
    ['Pay Date', formatPayDate(payslipData.run?.pay_date)],
    [
      'Present/Working Days',
      `${payslipData.attendance?.present_days ?? 0} / ${payslipData.attendance?.working_days ?? 0}`,
    ],
  ];

  const infoRowHeight = 18;
  const infoLabelWidth = Math.round(CONTENT_WIDTH * 0.19);
  const infoValueWidth = Math.round(CONTENT_WIDTH * 0.31);
  const infoColumns = [infoLabelWidth, infoValueWidth, infoLabelWidth, CONTENT_WIDTH - infoLabelWidth * 2 - infoValueWidth];

  for (let i = 0; i < infoPairs.length; i += 2) {
    drawRowGrid(doc, MARGIN, y, infoColumns, infoRowHeight);
    const left = infoPairs[i];
    const right = infoPairs[i + 1];
    drawCellText(doc, left[0], MARGIN, y, infoColumns[0], infoRowHeight, 8, { bold: true, color: '#444444' });
    drawCellText(doc, left[1], MARGIN + infoColumns[0], y, infoColumns[1], infoRowHeight, 9);
    if (right) {
      drawCellText(doc, right[0], MARGIN + infoColumns[0] + infoColumns[1], y, infoColumns[2], infoRowHeight, 8, { bold: true, color: '#444444' });
      drawCellText(doc, right[1], MARGIN + infoColumns[0] + infoColumns[1] + infoColumns[2], y, infoColumns[3], infoRowHeight, 9);
    }
    y += infoRowHeight;
  }

  y += 14;
  const tableTop = y;
  const { tableFontSize, rowHeight } = computeTableMetrics(
    maxRows,
    tableTop,
    contributions.length > 0
  );

  const amountColWidth = Math.max(96, Math.round(CONTENT_WIDTH * 0.19));
  const labelColWidth = CONTENT_WIDTH / 2 - amountColWidth;
  const tableColumns = [labelColWidth, amountColWidth, labelColWidth, amountColWidth];
  const headerRowHeight = Math.max(rowHeight + 4, 18);

  drawRowGrid(doc, MARGIN, tableTop, tableColumns, headerRowHeight, TABLE_HEADER_BG);
  drawCellText(doc, 'Earnings', MARGIN, tableTop, tableColumns[0], headerRowHeight, tableFontSize, { bold: true });
  drawCellText(doc, 'Amount', MARGIN + tableColumns[0], tableTop, tableColumns[1], headerRowHeight, tableFontSize, { bold: true, align: 'right' });
  drawCellText(doc, 'Deductions', MARGIN + tableColumns[0] + tableColumns[1], tableTop, tableColumns[2], headerRowHeight, tableFontSize, { bold: true });
  drawCellText(doc, 'Amount', MARGIN + tableColumns[0] + tableColumns[1] + tableColumns[2], tableTop, tableColumns[3], headerRowHeight, tableFontSize, { bold: true, align: 'right' });

  let rowY = tableTop + headerRowHeight;

  for (let index = 0; index < maxRows; index += 1) {
    const earning = earnings[index];
    const deduction = deductions[index];

    drawRowGrid(doc, MARGIN, rowY, tableColumns, rowHeight);

    if (earning) {
      drawCellText(doc, earning.label, MARGIN, rowY, tableColumns[0], rowHeight, tableFontSize);
      drawCellText(doc, formatMoney(earning.amount, currency), MARGIN + tableColumns[0], rowY, tableColumns[1], rowHeight, tableFontSize, { align: 'right' });
    }

    if (deduction) {
      drawCellText(doc, deduction.label, MARGIN + tableColumns[0] + tableColumns[1], rowY, tableColumns[2], rowHeight, tableFontSize);
      drawCellText(doc, formatMoney(deduction.amount, currency), MARGIN + tableColumns[0] + tableColumns[1] + tableColumns[2], rowY, tableColumns[3], rowHeight, tableFontSize, { align: 'right' });
    }

    rowY += rowHeight;
  }

  drawRowGrid(doc, MARGIN, rowY, tableColumns, headerRowHeight, TABLE_HEADER_BG);
  drawCellText(doc, 'Total Earnings', MARGIN, rowY, tableColumns[0], headerRowHeight, tableFontSize, { bold: true });
  drawCellText(doc, formatMoney(sumLineAmounts(earnings), currency), MARGIN + tableColumns[0], rowY, tableColumns[1], headerRowHeight, tableFontSize, { bold: true, align: 'right' });
  drawCellText(doc, 'Total Deductions', MARGIN + tableColumns[0] + tableColumns[1], rowY, tableColumns[2], headerRowHeight, tableFontSize, { bold: true });
  drawCellText(doc, formatMoney(sumLineAmounts(deductions), currency), MARGIN + tableColumns[0] + tableColumns[1] + tableColumns[2], rowY, tableColumns[3], headerRowHeight, tableFontSize, { bold: true, align: 'right' });

  rowY += headerRowHeight + 10;
  if (contributions.length > 0) {
    const contribText = `Employer contributions (informational only): ${formatMoney(
      sumLineAmounts(contributions),
      currency
    )} — not deducted from your take-home pay.`;
    doc.font('Helvetica').fontSize(9).fillColor('#444444');
    const contribHeight = measureTextHeight(doc, contribText, CONTENT_WIDTH, 9);
    doc.text(contribText, MARGIN, rowY, {
      width: CONTENT_WIDTH,
      lineGap: 1,
    });
    rowY += contribHeight + 10;
  }

  const netPay = Number(payslipData.totals?.net_pay ?? 0);
  const netBoxHeight = 36;
  const footerY = PAGE_HEIGHT - MARGIN - 10;
  const maxNetBoxY = footerY - netBoxHeight - 6;

  if (rowY > maxNetBoxY) {
    rowY = maxNetBoxY;
  }

  doc
    .rect(MARGIN, rowY, CONTENT_WIDTH, netBoxHeight)
    .fillAndStroke('#f4f4f5', '#d4d4d8');

  doc
    .fillColor('#000000')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text('Net Pay', MARGIN + 12, rowY + 11, { width: 120, lineBreak: false });
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(formatMoney(netPay, currency), MARGIN, rowY + 9, {
      width: CONTENT_WIDTH - 12,
      align: 'right',
      lineBreak: false,
    });

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text('This is a system-generated payslip.', MARGIN, footerY, {
      width: CONTENT_WIDTH,
      align: 'center',
      lineBreak: false,
    });
}

function buildPdfBuffer(payslipData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      autoFirstPage: true,
    });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderPayslipPdf(doc, payslipData);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function generatePayslipPdf(payslipData, options = {}) {
  if (!payslipData || typeof payslipData !== 'object') {
    throw new Error('payslipData is required.');
  }

  const logoBuffer = await resolveCompanyPdfLogoBuffer(payslipData.company);
  const brandedPayslipData = {
    ...payslipData,
    company: {
      ...(payslipData.company || {}),
      logo_buffer: logoBuffer,
    },
  };
  const pdfBuffer = await buildPdfBuffer(brandedPayslipData);
  const password = options.password ? String(options.password) : null;
  if (!password) return pdfBuffer;
  return await encryptPdfBuffer(pdfBuffer, password);
}

function buildPayslipFilename(payslipData) {
  const period = String(payslipData?.run?.period_month || 'payslip').replace(/[^\w-]/g, '');
  const code = String(payslipData?.employee?.employee_code || 'employee').replace(/[^\w-]/g, '');
  return `payslip-${period}-${code}.pdf`;
}

module.exports = {
  generatePayslipPdf,
  buildPayslipFilename,
};
