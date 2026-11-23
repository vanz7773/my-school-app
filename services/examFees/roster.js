const Student = require('../../models/Student');
const Charge = require('../../models/ExamFeeCharge');
const c = require('./core');
const Term = require('../../models/term');
const User = require('../../models/User');

// Recognize equivalent year formats without admitting students from another year.
function academicYearPattern(year) {
  const match = /^(\d{4})-(\d{4})$/.exec(year);
  if (!match) c.fail(400, 'Invalid examination academic year.');
  return new RegExp(`^\\s*${match[1]}\\s*(?:-|/|to|–|—)\\s*${match[2]}\\s*$`, 'i');
}
exports.academicYearPattern = academicYearPattern;
async function isCurrentTerm(user, campaign, session) {
  const now = new Date(), today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  return Boolean(await Term.exists({ ...c.scope(user), _id: campaign.term, academicYear: campaign.academicYear, startDate: { $lte: now }, endDate: { $gte: today } }).session(session || null));
}
exports.ensureCharges = async (user, campaign, session, selectedStudentIds) => {
  const allowSavedYearOverride = Boolean(selectedStudentIds?.length) && await isCurrentTerm(user, campaign, session);
  let chargesGenerated = 0, eligibleStudents = 0;
  const byClass = [], now = new Date();
  for (const fee of campaign.classFees) {
    const cursor = Student.find({ ...c.scope(user), class: fee.class, status: { $nin: ['graduated', 'withdrawn'] }, ...(allowSavedYearOverride ? {} : { academicYear: academicYearPattern(campaign.academicYear) }), ...(selectedStudentIds ? { _id: { $in: selectedStudentIds } } : {}) })
      .populate({ path: 'user', select: 'name', match: { school: user.school } }).session(session).cursor();
    let batch = [];
    const counts = { classId: fee.class, className: fee.className, eligibleStudents: 0, chargesGenerated: 0 };
    const flush = async () => {
      if (!batch.length) return;
      const result = await Charge.bulkWrite(batch, { session, timestamps: false });
      counts.chargesGenerated += result.upsertedCount;
      batch = [];
    };
    for await (const student of cursor) {
      counts.eligibleStudents++;
      batch.push({ updateOne: {
        filter: { ...c.scope(user), campaign: campaign._id, student: student._id },
        update: { $setOnInsert: { ...c.scope(user), campaign: campaign._id, student: student._id, class: fee.class,
          studentName: student.user?.name || [student.surname, student.otherNames].filter(Boolean).join(' ') || 'Student',
          admissionNumber: student.admissionNumber || '', className: fee.className,
          originalAmountPesewas: fee.amountPesewas, amountDuePesewas: fee.amountPesewas, netPaidPesewas: 0,
          createdAt: now, updatedAt: now } }, upsert: true, timestamps: false
      } });
      if (batch.length === 250) await flush();
    }
    await flush();
    chargesGenerated += counts.chargesGenerated; eligibleStudents += counts.eligibleStudents; byClass.push(counts);
  }
  return { chargesGenerated, eligibleStudents, byClass };
};


exports.review = async (user, campaign, query) => {
  c.admin(user);
  let classes = campaign.classFees;
  if (query.classId) {
    c.id(query.classId);
    classes = classes.filter(fee => String(fee.class) === query.classId);
    if (!classes.length) c.fail(400, 'This class is not included in the examination.');
  }
  const classIds = classes.map(fee => fee.class);
  const filter = { ...c.scope(user), class: { $in: classIds }, status: { $ne: 'graduated' } };
  const result = await c.paginated(Student, filter, query, { _id: 1 });
  const [users, charges, currentTerm, feeRecordCount] = await Promise.all([
    User.find({ ...c.scope(user), _id: { $in: result.items.map(student => student.user) } }).select('name').lean(),
    Charge.find({ ...c.scope(user), campaign: campaign._id, student: { $in: result.items.map(student => student._id) } }).select('student class className').lean(),
    isCurrentTerm(user, campaign),
    Charge.countDocuments({ ...c.scope(user), campaign: campaign._id, class: { $in: classIds } })
  ]);
  const names = new Map(users.map(person => [String(person._id), person.name]));
  const existing = new Map(charges.map(charge => [String(charge.student), charge]));
  const pattern = academicYearPattern(campaign.academicYear);
  return { ...result, feeRecordCount, currentTerm, items: result.items.map(student => {
    const charge = existing.get(String(student._id));
    const fee = classes.find(item => String(item.class) === String(student.class));
    const sameYear = pattern.test(student.academicYear || '');
    let reason;
    if (charge) reason = String(charge.class) === String(student.class) ? 'Already on list' : `Fee recorded under ${charge.className}. Existing payment history is retained.`;
    else if (student.status === 'withdrawn') reason = 'Withdrawn student — not eligible';
    else if (!sameYear && !currentTerm) reason = 'Saved academic year does not match this examination. Historical examinations cannot override it.';
    else if (!sameYear) reason = 'Saved year differs. Confirm addition to the current-term examination.';
    else reason = 'Missing fee record — ready to add';
    return { _id: student._id, name: names.get(String(student.user)) || [student.surname, student.otherNames].filter(Boolean).join(' ') || 'Student',
      className: fee.className, academicYear: student.academicYear || 'Not set', status: student.status || 'active', reason,
      canAdd: !charge && student.status !== 'withdrawn' && campaign.status === 'active' && (sameYear || currentTerm) };
  }) };
};
