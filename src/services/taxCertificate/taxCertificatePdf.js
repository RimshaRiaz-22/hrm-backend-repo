const PDFDocument = require('pdfkit');
const { resolveCompanyPdfLogoBuffer } = require('../../utils/companyLogoAsset');

function formatMoney(amount, currency = 'PKR') {
  const value = Number(amount);
  const safe = Number.isFinite(value) ? value : 0;
  return `${currency} ${safe.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildTaxCertificateFilename({ employee_code, tax_year }) {
  const code = String(employee_code || 'employee').replace(/[^\w.-]/g, '_');
  return `tax-certificate-${code}-${tax_year}.pdf`;
}

async function generateTaxCertificatePdf(data) {
  const {
    company_name,
    employee_name,
    employee_code,
    tax_year,
    total_income,
    total_tax,
    currency = 'PKR',
  } = data;
  const logoBuffer = await resolveCompanyPdfLogoBuffer({
    logo_buffer: data.company_logo_buffer,
    logo_path: data.company_logo_path,
    logo_url: data.company_logo_url,
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const logoWidth = 150;
    const logoHeight = 43;
    const logoX = (doc.page.width - logoWidth) / 2;
    doc.image(logoBuffer, logoX, 45, {
      fit: [logoWidth, logoHeight],
      align: 'center',
      valign: 'center',
    });

    doc.y = 105;
    doc.fontSize(20).text('Tax Certificate', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(String(company_name || 'Company'), { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(11);
    doc.text(`Tax Year: ${tax_year}`);
    doc.text(`Employee Name: ${employee_name || 'Employee'}`);
    doc.text(`Employee Code: ${employee_code || '—'}`);
    doc.moveDown();

    doc.text(`Total Taxable Income: ${formatMoney(total_income, currency)}`);
    doc.text(`Total Tax Deducted: ${formatMoney(total_tax, currency)}`);
    doc.moveDown(2);

    doc.fontSize(10).fillColor('#444444').text(
      'This certificate is generated from closed payroll runs for the stated tax year.',
      { align: 'left' }
    );

    doc.end();
  });
}

module.exports = {
  generateTaxCertificatePdf,
  buildTaxCertificateFilename,
  formatMoney,
};
