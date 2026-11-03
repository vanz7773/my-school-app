const PDFDocument = require('pdfkit');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const School = require('../../models/School');
const SchoolInfo = require('../../models/SchoolInfo');
const { receiptData } = require('./payments');
const { scope } = require('./core');
const currency = value => `GHS ${(value / 100).toFixed(2)}`;
async function logoBuffer(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    if (/^https:\/\//i.test(value)) {
      const url = new URL(value);
      if (!['storage.googleapis.com', 'firebasestorage.googleapis.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
      const response = await axios.get(url.href, { responseType: 'arraybuffer', timeout: 3000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024 });
      return Buffer.from(response.data);
    }
    const root = path.resolve(__dirname, '../../uploads');
    const file = path.resolve(root, value.replace(/^\/?uploads\//, ''));
    if (!file.startsWith(root + path.sep)) return null;
    const actual = await fs.realpath(file);
    if (!actual.startsWith(root + path.sep) || (await fs.stat(actual)).size > 2 * 1024 * 1024) return null;
    return await fs.readFile(actual);
  } catch { return null; }
}
async function renderReceipt({ payment, charge, campaign, schoolName, logo }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Exam fee receipt ${payment.receiptNumber}` } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  if (logo) { try { doc.image(logo, 48, 42, { fit: [50, 50] }); } catch { /* Unsupported branding does not invalidate the receipt. */ } }
  doc.fillColor('#183b56').font('Helvetica-Bold').fontSize(18).text(String(schoolName).slice(0, 180), logo ? 112 : 48, 48, { width: logo ? 430 : 500 });
  const headingY = Math.max(110, doc.y + 24);
  doc.fontSize(14).text('EXAMINATION FEE RECEIPT', 48, headingY);
  if (payment.status === 'reversed') doc.fillColor('#b91c1c').text('REVERSED — NOT A VALID PAYMENT', 48, headingY + 26);
  doc.fillColor('#1f2937');
  let y = headingY + 62;
  const rows = [
    ['Receipt number', payment.receiptNumber], ['Student', charge.studentName], ['Admission number', charge.admissionNumber || '—'],
    ['Class', charge.className], ['Examination', campaign.name], ['Academic year / term', `${campaign.academicYear} / ${campaign.termName}`],
    ['Amount received', currency(payment.amountPesewas)], ['Total paid after this payment', currency(payment.totalPaidAfterPesewas)],
    ['Balance after this payment', currency(payment.balanceAfterPesewas)], ['Recorded method', payment.method.replace(/_/g, ' ')],
    ['Collection date', new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Accra', dateStyle: 'long', timeStyle: 'short' }).format(new Date(payment.recordedAt))],
    ['Collected by', payment.collectorName]
  ];
  for (const [label, raw] of rows) {
    const value = String(raw);
    doc.font('Helvetica').fontSize(10);
    const height = Math.max(doc.heightOfString(label, { width: 185 }), doc.heightOfString(value, { width: 290 })) + 16;
    if (y + height > 720) { doc.addPage(); y = 48; }
    doc.fillColor('#64748b').text(label, 48, y, { width: 185 });
    doc.fillColor('#111827').font('Helvetica-Bold').text(value, 245, y, { width: 290 });
    y += height;
    doc.strokeColor('#e2e8f0').moveTo(48, y - 7).lineTo(547, y - 7).stroke();
  }
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Amounts reflect the time this payment was recorded. A recorded payment method is not independent confirmation of settlement by a bank or mobile-money provider.', 48, y + 16, { width: 499 });
  if (payment.status === 'reversed') doc.fillColor('#b91c1c').text(`Reversal reason: ${payment.reversalReason}`, { width: 499 });
  doc.end();
  return complete;
}
exports.download = async (user, paymentId) => {
  const data = await receiptData(user, paymentId);
  const school = await School.findOne({ _id: user.school }).select('name').lean();
  const info = await SchoolInfo.findOne(scope(user)).select('logo').lean();
  return { buffer: await renderReceipt({ ...data, schoolName: school?.name || 'School', logo: await logoBuffer(info?.logo) }), receiptNumber: data.payment.receiptNumber };
};
exports.renderReceipt = renderReceipt;
