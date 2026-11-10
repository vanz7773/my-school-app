const campaigns = require('../services/examFees/campaigns');
const payments = require('../services/examFees/payments');
const remittances = require('../services/examFees/remittances');
const reports = require('../services/examFees/reports');
const receipts = require('../services/examFees/receipts');
const wrap = fn => async (req, res) => {
  try { const data = await fn(req, res); if (!res.headersSent) res.json({ success: true, ...data }); }
  catch (error) {
    console.error('Exam fees request failed:', error.message);
    if (res.headersSent) return res.end();
    const status = error.status || (error.code === 11000 ? 409 : error.name === 'ValidationError' ? 400 : 500);
    res.status(status).json({ success: false, message: error.status ? error.message : status === 409 ? 'Duplicate financial request. Retry with the original request ID.' : status === 400 ? 'Invalid examination fee data.' : 'Unable to process the examination fee request.' });
  }
};
exports.getSettings = wrap(req => campaigns.getSettings(req.user));
exports.updateSettings = wrap(req => campaigns.updateSettings(req.user, req.body));
exports.createCampaign = wrap(async req => ({ campaign: await campaigns.saveDraft(req.user, req.body) }));
exports.editCampaign = wrap(async req => ({ campaign: await campaigns.saveDraft(req.user, req.body, req.params.campaignId) }));
exports.activate = wrap(req => campaigns.activate(req.user, req.params.campaignId));
exports.close = wrap(async req => ({ campaign: await campaigns.close(req.user, req.params.campaignId) }));
exports.campaigns = wrap(req => campaigns.list(req.user, req.query));
exports.assign = wrap(async req => ({ assignment: await campaigns.assign(req.user, req.params.campaignId, req.body) }));
exports.revoke = wrap(async req => ({ assignment: await campaigns.revoke(req.user, req.params.assignmentId) }));
exports.assignments = wrap(req => campaigns.assignments(req.user, req.query));
exports.charges = wrap(req => payments.charges(req.user, req.query));
exports.adjust = wrap(async req => ({ charge: await payments.adjust(req.user, req.params.chargeId, req.body) }));
exports.recordPayment = wrap(req => payments.record(req.user, req.body));
exports.history = wrap(req => payments.history(req.user, req.query));
exports.reverse = wrap(async req => ({ payment: await payments.reverse(req.user, req.params.paymentId, req.body) }));
exports.receipt = wrap(async (req, res) => {
  const { buffer, receiptNumber } = await receipts.download(req.user, req.params.paymentId);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${receiptNumber}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.send(buffer);
});
exports.submitRemittance = wrap(async req => ({ remittance: await remittances.submit(req.user, req.body) }));
exports.confirmRemittance = wrap(async req => ({ remittance: await remittances.resolve(req.user, req.params.remittanceId, req.body || {}, true) }));
exports.rejectRemittance = wrap(async req => ({ remittance: await remittances.resolve(req.user, req.params.remittanceId, req.body, false) }));
exports.remittances = wrap(req => remittances.list(req.user, req.query));
exports.collectorSummary = wrap(req => reports.collectorSummary(req.user, req.query));
exports.report = wrap(req => reports.adminReport(req.user, req.query));
exports.audit = wrap(req => reports.auditTrail(req.user, req.query));

exports.deleteCampaign = wrap(req => campaigns.remove(req.user, req.params.campaignId, req.body || {}));
