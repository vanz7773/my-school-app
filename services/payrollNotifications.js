const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const PayrollStaff = require('../models/PayrollStaff');
const User = require('../models/User');
const Notification = require('../models/Notification');
const smsService = require('./smsService');

const notifyPaidPayroll = async (payroll, { sms = true, push = true, inApp = true } = {}) => {
  if (payroll.status !== 'Paid') throw new Error('Mark payroll as paid before sending payment notifications');
  const result = { sms: { sent: 0, skipped: 0, failed: 0 }, push: { sent: 0, skipped: 0, failed: 0 }, inApp: { sent: 0, skipped: 0, failed: 0 } };
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
      if (sms) result.sms.skipped++;
      if (push) result.push.skipped++;
      if (inApp) result.inApp.skipped++;
      continue;
    }
    let employee, user;
    try {
      employee = await (isStaff ? PayrollStaff : Teacher).findOne({ _id: slip.teacher, school: payroll.school });
      if (employee?.user) user = await User.findOne({ _id: employee.user, school: payroll.school }).select('phone');
    } catch (error) {
      if (sms) result.sms[smsPending ? 'failed' : 'skipped']++;
      if (push) result.push[pushPending ? 'failed' : 'skipped']++;
      if (inApp) result.inApp[inAppPending ? 'failed' : 'skipped']++;
      continue;
    }
    const message = `${slip.teacherName}, your salary for ${period} is paid. Gross: GHS ${Number(slip.grossSalary || 0).toFixed(2)}. Deductions: GHS ${Number(slip.totalDeductions || 0).toFixed(2)}. Net pay: GHS ${Number(slip.netSalary || 0).toFixed(2)}. Ref: ${slip.referenceNumber}.${!isStaff ? ' Open the mobile app to view your payslip.' : ''}`;

    const deliver = async (channel, prefix, send) => {
      const sentKey = `${prefix}SentAt`, sendingKey = `${prefix}Sending`, claimedKey = `${prefix}ClaimedAt`;
      if (slip[sentKey]) { result[channel].skipped++; return; }
      let claimed = false;
      try {
        const claim = await Payroll.updateOne({ _id: payroll._id, school: payroll.school, payslips: { $elemMatch: {
          _id: slip._id, [sentKey]: null,
          $or: [{ [sendingKey]: { $ne: true } }, { [claimedKey]: { $lt: new Date(Date.now() - 10 * 60 * 1000) } }],
        } } }, { $set: { [`payslips.$.${sendingKey}`]: true, [`payslips.$.${claimedKey}`]: new Date() } });
        if (!claim.modifiedCount) { result[channel].skipped++; return; }
        claimed = true;
        await send();
        await Payroll.updateOne({ _id: payroll._id, school: payroll.school, 'payslips._id': slip._id }, {
          $set: { [`payslips.$.${sentKey}`]: new Date(), [`payslips.$.${sendingKey}`]: false },
        });
        result[channel].sent++;
      } catch (error) {
        result[channel].failed++;
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
      if (!phone) throw new Error('No salary SMS phone number');
      await smsService.sendSms({ schoolId: payroll.school, recipients: [phone], message, messageType: 'custom' });
    });
    if (inApp) {
      if (isStaff) result.inApp.skipped++;
      else await deliver('inApp', 'salaryInApp', async () => {
        if (!user) throw new Error('No teacher app account');
        // Persist separately from push so it remains available even without a registered device.
        await Notification.findOneAndUpdate({ _id: slip._id, school: payroll.school }, { $set: {
          title: 'Salary Paid', message, type: 'salary-payment', audience: 'specific', recipientUsers: [user._id], school: payroll.school,
          relatedResource: payroll._id, resourceModel: 'Payroll',
        } }, { upsert: true, new: true, runValidators: true });
      });
    }
    if (push) {
      if (isStaff) { result.push.skipped++; continue; }
      await deliver('push', 'salaryPush', async () => {
        if (!user) throw new Error('No teacher app account');
        const response = await require('../controllers/notificationController').sendPushNotifications(
          [user._id], 'Salary Paid', message,
          { type: 'salary-payment', payrollId: String(payroll._id), notificationId: String(slip._id), route: '/teacher/payslips', recipientUserId: String(user._id) }, { throwOnError: true, mobileOnly: true },
        );
        if (!response?.acceptedCount) throw new Error('No registered push device');
      });
    }
  }
  return result;
};

const notificationSummary = result => `SMS: ${result.sms.sent} sent, ${result.sms.skipped} skipped, ${result.sms.failed} failed. Push: ${result.push.sent} sent, ${result.push.skipped} skipped, ${result.push.failed} failed. In-app: ${result.inApp.sent} saved, ${result.inApp.skipped} skipped, ${result.inApp.failed} failed.`;
module.exports = { notifyPaidPayroll, notificationSummary };
