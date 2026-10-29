const User = require('../models/User');
const Student = require('../models/Student');
const smsService = require('./smsService');
const { normalizeRecipients } = require('../utils/smsPhoneNumbers');

const idString = value => String(value?._id || value || '');
const belongsToSchool = (student, schoolId) => student &&
  (!student.school || idString(student.school) === idString(schoolId));

// Always resolve linked accounts within the requesting school, even for populated refs.
async function collectParentPhonesFromStudents(students, schoolId) {
  if (!schoolId) throw new Error('School is required to resolve SMS recipients');
  const phones = [];
  const parentIds = new Set();
  for (const student of students || []) {
    if (!belongsToSchool(student, schoolId)) continue;
    phones.push(student.guardianPhone, student.guardianPhone2);
    for (const parent of [student.parent, ...(student.parentIds || [])]) {
      if (parent) parentIds.add(idString(parent));
    }
  }
  if (parentIds.size) {
    const parents = await User.find({
      _id: { $in: [...parentIds] }, school: schoolId, role: 'parent'
    }).select('phone');
    phones.push(...parents.map(parent => parent.phone));
  }
  return normalizeRecipients(phones);
}

async function collectAnnouncementPhones({ schoolId, recipientUserIds = [], includeGuardians, classId }) {
  if (!schoolId) throw new Error('School is required to resolve SMS recipients');
  const users = recipientUserIds.length ? await User.find({
    _id: { $in: recipientUserIds }, school: schoolId
  }).select('phone') : [];
  let guardianPhones = [];
  if (includeGuardians) {
    const students = await Student.find({
      school: schoolId, status: { $ne: 'withdrawn' }, ...(classId ? { class: classId } : {})
    }).select('school guardianPhone guardianPhone2 parent parentIds');
    guardianPhones = await collectParentPhonesFromStudents(students, schoolId);
  }
  return normalizeRecipients([...users.map(user => user.phone), ...guardianPhones]);
}

async function sendFeePaymentSms({ schoolId, student, isDailyVariable, message }) {
  // Daily-variable payments retain their weekly summary instead of immediate receipts.
  if (isDailyVariable) return;
  const settings = await smsService.getSchoolSettings(schoolId);
  if (!settings.smsEnabled || !settings.autoTriggers?.feePayments) return;
  const recipients = await collectParentPhonesFromStudents([student], schoolId);
  if (recipients.length) {
    return smsService.sendSms({ schoolId, recipients, message, messageType: 'fees' });
  }
}

async function sendReportSms({ schoolId, students, termLabel }) {
  if (!students?.length) return;
  const settings = await smsService.getSchoolSettings(schoolId);
  if (!settings.smsEnabled || !settings.autoTriggers?.examReports) return;
  const errors = [];
  for (const student of students) {
    if (!belongsToSchool(student, schoolId)) continue;
    try {
      const phones = await collectParentPhonesFromStudents([student], schoolId);
      // Preserve delivery to the student's existing account as well as family contacts.
      const users = student.user ? await User.find({
        _id: idString(student.user), school: schoolId, role: 'student'
      }).select('phone') : [];
      const recipients = normalizeRecipients([...phones, ...users.map(user => user.phone)]);
      if (!recipients.length) continue;
      const name = student.user?.name || student.name || 'your child';
      await smsService.sendSms({
        schoolId, recipients, messageType: 'reports',
        message: `New Report Card: The ${termLabel} report card for ${name} is now available.`
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new Error(`SMS failed for ${errors.length} report(s): ${errors[0].message}`);
}

module.exports = { collectParentPhonesFromStudents, collectAnnouncementPhones, sendReportSms, sendFeePaymentSms };
