const Student = require('../models/Student');
const Class = require('../models/Class');

// Fixed ordering for class promotion
const classOrder = [
  'CRECHE',
  'NURSERY 1', 'NURSERY 2',
  'KG 1', 'KG 2',
  'BASIC 1', 'BASIC 2', 'BASIC 3', 'BASIC 4',
  'BASIC 5', 'BASIC 6', 'BASIC 7', 'BASIC 8', 'BASIC 9'
];

exports.migrateStudents = async (req, res) => {
  const { fromYear, toYear, classId, students } = req.body;

  if (!fromYear || !toYear) {
    return res.status(400).json({ message: 'Missing academic year.' });
  }

  if (fromYear === toYear) {
    return res.status(400).json({ message: 'Cannot migrate to the same academic year.' });
  }

  try {
    const schoolId = req.user.school;

    // ------------------------------------------------------------
    // 1. PRELOAD ALL CLASSES ONCE (FAST)
    // ------------------------------------------------------------
    const allClasses = await Class.find({ school: schoolId }).lean();

    const classMap = {};
    const promotionMap = {}; // className → nextClassId

    allClasses.forEach(cls => {
      const name = cls.name.trim().toUpperCase();
      classMap[name] = cls._id;
    });

    // Build promotion mapping
    classOrder.forEach((className, index) => {
      const current = className.toUpperCase();
      const next = classOrder[index + 1]?.toUpperCase();

      if (classMap[current] && classMap[next]) {
        promotionMap[classMap[current]] = classMap[next]; // store classId → next classId
      }
    });

    // ------------------------------------------------------------
    // 2. LOAD STUDENTS TO MIGRATE (ONLY ONCE)
    // ------------------------------------------------------------
    let studentsToMigrate = [];

    if (classId) {
      // FULL CLASS MIGRATION
      studentsToMigrate = await Student.find({
        school: schoolId,
        class: classId,
        academicYear: fromYear,
        status: { $ne: "graduated" }
      })
      .select('class academicYear status user')
      .lean();
    }

    else if (Array.isArray(students) && students.length > 0) {
      // INDIVIDUAL MIGRATION
      const ids = students.map(s => s.studentId);

      studentsToMigrate = await Student.find({
        school: schoolId,
        _id: { $in: ids },
        status: { $ne: "graduated" }
      })
      .select('class academicYear status user')
      .lean();
    }

    else {
      return res.status(400).json({
        message: 'Provide either classId (full class migration) or students[] (individual migration).'
      });
    }

    if (studentsToMigrate.length === 0) {
      return res.json({ success: true, message: "No eligible students to migrate." });
    }

    // ------------------------------------------------------------
    // 3. PREPARE BULK UPDATE OPERATIONS
    // ------------------------------------------------------------
    const bulkOps = [];
    let migratedCount = 0;
    let graduatedCount = 0;

    // Build a quick lookup for individual migration flags
    const promoteMap = {};
    if (Array.isArray(students)) {
      students.forEach(s => {
        promoteMap[s.studentId] = s.promote !== false; // default true
      });
    }

    // ------------------------------------------------------------
    // 4. PROCESS EACH STUDENT IN MEMORY (FAST)
    // ------------------------------------------------------------
    for (const student of studentsToMigrate) {
      const promote = Array.isArray(students)
        ? promoteMap[student._id] !== false
        : true;

      const currentClassId = String(student.class);
      const nextClassId = promotionMap[currentClassId]; // may be undefined

      const isFinalClass = !nextClassId;

      // ------------ GRADUATION ------------
      if (isFinalClass && promote) {
        bulkOps.push({
          updateOne: {
            filter: { _id: student._id },
            update: {
              $set: {
                status: "graduated",
                academicYear: toYear,
                class: null
              }
            }
          }
        });
        graduatedCount++;
        continue;
      }

      // ------------ PROMOTION / MOVE ------------
      const newClassId = promote && nextClassId ? nextClassId : currentClassId;

      bulkOps.push({
        updateOne: {
          filter: { _id: student._id },
          update: {
            $set: {
              academicYear: toYear,
              class: newClassId,
              status: "active"
            }
          }
        }
      });

      migratedCount++;
    }

    // ------------------------------------------------------------
    // 5. EXECUTE BULK OPERATION (SUPER FAST)
    // ------------------------------------------------------------
    if (bulkOps.length > 0) {
      await Student.bulkWrite(bulkOps);
    }

    // ------------------------------------------------------------
    // 6. RESPONSE
    // ------------------------------------------------------------
    return res.json({
      success: true,
      migrated: migratedCount,
      graduated: graduatedCount,
      message: `✔️ ${migratedCount} promoted, 🎓 ${graduatedCount} graduated.`
    });

  } catch (err) {
    console.error('❌ Migration error:', err);
    return res.status(500).json({
      message: 'Migration failed.',
      error: err.message
    });
  }
};
