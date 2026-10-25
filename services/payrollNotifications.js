const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const PayrollStaff = require('../models/PayrollStaff');
const User = require('../models/User');
const Notification = require('../models/Notification');
const smsService = require('./smsService');

const notifyPaidPayroll = async (payroll, { sms = true, push = true, inApp = true } = {}) => {
  if (payroll.status !== 'Paid') throw new Error('Mark payroll as paid before sending payment notifications');
  const result = { sms: { sent: 0, skipped: 0, failed: 0 }, push: { sent: 0, skipped: 0, failed: 0 }, inApp: { sent: 0, skipped: 0, failed: 0 } };
  result.details = [];
  const recordOutcome = (slip, channel, outcome, reason) => {
    result[channel][outcome]++;
    result.details.push({ payslipId: String(slip._id), employeeName: slip.teacherName || 'Employee', channel, outcome, reason });
  };
  const [year, month] = payroll.month.split('-').map(Number);
  const period = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).toUpperCase();

  for (const slip of payroll.payslips) {
    const isStaff = slip.employeeModel === 'PayrollStaff';
    // Preserve successful payment SMS from the earlier manual-send flow, but not approval messages.
    if (!slip.salaryPaidSmsSentAt && slip.salarySmsSentAt && payroll.paidAt &&
        new Date(slip.salarySmsSentAt) >= new Date(payroll.paidAt)) {
      slip.salaryPaidSmsSentAt = slip.salarySmsSentAt;
    }
    const smsPending = sms && !slip.salaryPaidSmsSentAt;
    const pushPending = push && !isStaff && !slip.salaryPushSentAt;
    const inAppPending = inApp && !isStaff && !slip.salaryInAppSentAt;
    if (!smsPending && !pushPending && !inAppPending) {
      if (sms) recordOutcome(slip, 'sms', 'skipped', 'already_sent');
      if (push) recordOutcome(slip, 'push', 'skipped', isStaff ? 'not_applicable' : 'already_sent');
      if (inApp) recordOutcome(slip, 'inApp', 'skipped', isStaff ? 'not_applicable' : 'already_sent');
      continue;
    }
    let employee, user;
    try {
      employee = await (isStaff ? PayrollStaff : Teacher).findOne({ _id: slip.teacher, school: payroll.school });
      if (employee?.user) user = await User.findOne({ _id: employee.user, school: payroll.school }).select('phone');
    } catch (error) {
      console.error('Salary recipient lookup failed:', error.message);
      for (const [channel, enabled, pending] of [['sms', sms, smsPending], ['push', push, pushPending], ['inApp', inApp, inAppPending]]) {
        if (enabled) recordOutcome(slip, channel, pending ? 'failed' : 'skipped', pending ? 'recipient_lookup_failed' : isStaff && channel !== 'sms' ? 'not_applicable' : 'already_sent');
      }
      continue;
    }
    const message = `${slip.teacherName}, your salary for ${period} is paid. Gross: GHS ${Number(slip.grossSalary || 0).toFixed(2)}. Deductions: GHS ${Number(slip.totalDeductions || 0).toFixed(2)}. Net pay: GHS ${Number(slip.netSalary || 0).toFixed(2)}. Ref: ${slip.referenceNumber}.${!isStaff ? ' Open the mobile app to view your payslip.' : ''}`;

    const deliver = async (channel, prefix, send) => {
      const sentKey = `${prefix}SentAt`, sendingKey = `${prefix}Sending`, claimedKey = `${prefix}ClaimedAt`;
      if (slip[sentKey]) { recordOutcome(slip, channel, 'skipped', 'already_sent'); return; }
      let claimed = false;
      try {
        const claim = await Payroll.updateOne({ _id: payroll._id, school: payroll.school, payslips: { $elemMatch: {
          _id: slip._id, [sentKey]: null,
          // A valid active claim always has a timestamp; older orphaned flags can be retried.
          $or: [{ [sendingKey]: { $ne: true } }, { [claimedKey]: null }, { [claimedKey]: { $lt: new Date(Date.now() - 10 * 60 * 1000) } }],
        } } }, { $set: { [`payslips.$.${sendingKey}`]: true, [`payslips.$.${claimedKey}`]: new Date() } });
        if (!(claim.modifiedCount ?? claim.nModified)) {
          // A failed match does not prove delivery. Inspect the stored status instead of silently skipping.
          const stored = await Payroll.findOne({ _id: payroll._id, school: payroll.school }, { payslips: { $elemMatch: { _id: slip._id } } });
          const latest = stored?.payslips?.find(item => String(item._id) === String(slip._id));
          if (latest?.[sentKey]) recordOutcome(slip, channel, 'skipped', 'already_sent');
          else if (latest?.[sendingKey] && latest[claimedKey] && new Date(latest[claimedKey]).getTime() >= Date.now() - 10 * 60 * 1000) {
            recordOutcome(slip, channel, 'skipped', 'in_progress');
          } else recordOutcome(slip, channel, 'failed', latest ? 'claim_not_acquired' : 'payslip_not_found');
          return;
        }
        claimed = true;
        await send();
        await Payroll.updateOne({ _id: payroll._id, school: payroll.school, 'payslips._id': slip._id }, {
          $set: { [`payslips.$.${sentKey}`]: new Date(), [`payslips.$.${sendingKey}`]: false },
        });
        recordOutcome(slip, channel, 'sent', 'delivered');
      } catch (error) {
        recordOutcome(slip, channel, 'failed', error.code || 'delivery_failed');
        console.error(`Salary ${channel} notification failed:`, error.message);
        if (claimed) {
          await Payroll.updateOne({ _id: payroll._id, school: payroll.school, 'payslips._id': slip._id }, {
            $set: { [`payslips.$.${sendingKey}`]: false },
          }).catch(error => console.error('Could not release payroll notification claim:', error.message));
        }
      }
    };
    if (sms) await deliver('sms', 'salaryPaidSms', async () => {
      const phone = slip.contactPhone || employee?.phone || user?.phone;
      if (!phone) throw Object.assign(new Error('No salary SMS phone number'), { code: 'missing_phone' });
      await smsService.sendSms({ schoolId: payroll.school, recipients: [phone], message, messageType: 'custom' });
    });
    if (inApp) {
      if (isStaff) recordOutcome(slip, 'inApp', 'skipped', 'not_applicable');
      else await deliver('inApp', 'salaryInApp', async () => {
        if (!user) throw Object.assign(new Error('No teacher app account'), { code: 'missing_app_account' });
        // Persist separately from push so it remains available even without a registered device.
        await Notification.findOneAndUpdate({ _id: slip._id, school: payroll.school }, { $set: {
          title: 'Salary Paid', message, type: 'salary-payment', audience: 'specific', recipientUsers: [user._id], school: payroll.school,
          relatedResource: payroll._id, resourceModel: 'Payroll',
        } }, { upsert: true, new: true, runValidators: true });
      });
    }
    if (push) {
      if (isStaff) { recordOutcome(slip, 'push', 'skipped', 'not_applicable'); continue; }
      await deliver('push', 'salaryPush', async () => {
        if (!user) throw Object.assign(new Error('No teacher app account'), { code: 'missing_app_account' });
        const response = await require('../controllers/notificationController').sendPushNotifications(
          [user._id], 'Salary Paid', message,
          { type: 'salary-payment', payrollId: String(payroll._id), notificationId: String(slip._id), route: '/teacher/payslips', recipientUserId: String(user._id) }, { throwOnError: true, mobileOnly: true },
        );
        if (!response?.acceptedCount) throw Object.assign(new Error('No registered push device'), { code: 'missing_push_device' });
      });
    }
  }
  return result;
};

const notificationSummary = result => {
  const reasons = {
    already_sent: 'already recorded as sent', in_progress: 'another send is in progress',
    not_applicable: 'payroll-only staff without app accounts', recipient_lookup_failed: 'could not load recipient',
    claim_not_acquired: 'could not start delivery; retry', payslip_not_found: 'payslip could not be matched',
    missing_phone: 'missing SMS phone number', missing_app_account: 'missing teacher app account',
    missing_push_device: 'no registered mobile push device', delivery_failed: 'delivery failed',
  };
  return [['sms', 'SMS', 'sent'], ['push', 'Push', 'sent'], ['inApp', 'In-app', 'saved']].map(([channel, title, verb]) => {
    const counts = result[channel];
    const breakdown = {};
    for (const detail of result.details || []) {
      if (detail.channel === channel && detail.outcome !== 'sent') {
        const label = reasons[detail.reason] || 'delivery failed';
        breakdown[label] = (breakdown[label] || 0) + 1;
      }
    }
    const description = Object.entries(breakdown).map(([label, count]) => `${count} ${label}`).join('; ');
    return `${title}: ${counts.sent} ${verb}, ${counts.skipped} skipped, ${counts.failed} failed${description ? ` (${description})` : ''}.`;
  }).join(' ');
};
module.exports = { notifyPaidPayroll, notificationSummary };
