const Student = require('../../models/Student');
const Charge = require('../../models/ExamFeeCharge');
const c = require('./core');

// Recognize equivalent year formats without admitting students from another year.
function academicYearPattern(year) {
  const match = /^(\d{4})-(\d{4})$/.exec(year);
  if (!match) c.fail(400, 'Invalid examination academic year.');
  return new RegExp(`^\\s*${match[1]}\\s*(?:-|/|to|–|—)\\s*${match[2]}\\s*$`, 'i');
}
exports.academicYearPattern = academicYearPattern;
exports.ensureCharges = async (user, campaign, session) => {
  let chargesGenerated = 0, eligibleStudents = 0;
  const byClass = [], now = new Date();
  for (const fee of campaign.classFees) {
    const cursor = Student.find({ ...c.scope(user), class: fee.class, status: { $nin: ['graduated', 'withdrawn'] }, academicYear: academicYearPattern(campaign.academicYear) })
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
