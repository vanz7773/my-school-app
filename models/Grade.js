// 📁 models/Grade.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const gradeSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    term: {
      type: String,
      required: true,
    },
    // 🆕 Continuous Assessment Fields
    test1: {
      type: Number,
      default: 0,
      min: 0,
      max: 20,
    },
    test2: {
      type: Number,
      default: 0,
      min: 0,
      max: 20,
    },
    groupWork: {
      type: Number,
      default: 0,
      min: 0,
      max: 10,
    },
    projectWork: {
      type: Number,
      default: 0,
      min: 0,
      max: 10,
    },
    exam: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // 🧾 Optional comment
    comment: {
      type: String,
      default: '',
    },
    // 📌 Entered by which user
    enteredBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    // 📍 School that owns this grade
    school: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// ========================
// 🎯 STRATEGIC INDEXING
// ========================

// Compound indexes for common query patterns
gradeSchema.index({ student: 1, subject: 1, class: 1, term: 1 }); // Duplicate checks & unique constraints
gradeSchema.index({ school: 1, createdAt: -1 }); // School dashboard & recent grades
gradeSchema.index({ student: 1, term: 1 }); // Student report cards
gradeSchema.index({ class: 1, subject: 1, term: 1 }); // Class subject reports
gradeSchema.index({ school: 1, class: 1, term: 1 }); // Class term reports
gradeSchema.index({ enteredBy: 1, createdAt: -1 }); // Teacher grade entry history

// Text search index for comments
gradeSchema.index({ comment: 'text' });

// ========================
// 🎯 VIRTUAL FIELDS (Computed Properties)
// ========================

// Total Continuous Assessment
gradeSchema.virtual('totalCA').get(function() {
  return (this.test1 || 0) + (this.test2 || 0) + (this.groupWork || 0) + (this.projectWork || 0);
});

// Scaled CA (out of 50)
gradeSchema.virtual('scaledCA').get(function() {
  const totalCA = this.totalCA;
  return totalCA > 0 ? (totalCA / 60) * 50 : 0;
});

// Exam score out of 50
gradeSchema.virtual('exam50').get(function() {
  return (this.exam || 0) * 0.5;
});

// Overall score (Scaled CA + 50% Exam)
gradeSchema.virtual('overallScore').get(function() {
  return this.scaledCA + this.exam50;
});

// Grade letter calculation
gradeSchema.virtual('grade').get(function() {
  const score = this.overallScore;
  if (score > 79) return 'A';
  if (score > 75) return 'P';
  if (score > 65) return 'AP';
  if (score > 64.5) return 'D';
  return 'B';
});

// Grade remarks
gradeSchema.virtual('remarks').get(function() {
  const gradeMap = {
    'A': 'ADVANCE',
    'P': 'PROFICIENT',
    'AP': 'APPROACHING PROFICIENCY', 
    'D': 'DEVELOPING',
    'B': 'BEGINNING'
  };
  return gradeMap[this.grade] || '';
});

// Grade color for UI
gradeSchema.virtual('gradeColor').get(function() {
  const colorMap = {
    'A': '#2E7D32',   // Green
    'P': '#1565C0',   // Blue  
    'AP': '#F9A825',  // Yellow
    'D': '#EF6C00',   // Orange
    'B': '#C62828'    // Red
  };
  return colorMap[this.grade] || '#000000';
});

// Performance category (for analytics)
gradeSchema.virtual('performanceCategory').get(function() {
  const score = this.overallScore;
  if (score >= 80) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Average';
  if (score >= 50) return 'Below Average';
  return 'Needs Improvement';
});

// ========================
// 🎯 STATIC METHODS (Optimized Query Methods)
// ========================

// Get student report card with aggregation pipeline
gradeSchema.statics.getStudentReport = async function(studentId, term, schoolId = null) {
  const matchStage = { student: new mongoose.Types.ObjectId(studentId), term };
  if (schoolId) matchStage.school = new mongoose.Types.ObjectId(schoolId);

  return this.aggregate([
    { $match: matchStage },
    {
      $lookup: {
        from: 'students',
        localField: 'student',
        foreignField: '_id',
        as: 'student',
        pipeline: [
          {
            $lookup: {
              from: 'users',
              localField: 'user',
              foreignField: '_id',
              as: 'user',
              pipeline: [{ $project: { name: 1, email: 1 } }]
            }
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } }
        ]
      }
    },
    { $unwind: '$student' },
    {
      $lookup: {
        from: 'classes',
        localField: 'class',
        foreignField: '_id',
        as: 'class',
        pipeline: [{ $project: { name: 1 } }]
      }
    },
    { $unwind: { path: '$class', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        subject: 1,
        test1: 1,
        test2: 1,
        groupWork: 1,
        projectWork: 1,
        exam: 1,
        comment: 1,
        term: 1,
        totalCA: 1,
        scaledCA: 1,
        exam50: 1,
        overallScore: 1,
        grade: 1,
        remarks: 1,
        'student._id': 1,
        'student.admissionNumber': 1,
        'student.user.name': 1,
        'student.user.email': 1,
        'class.name': 1
      }
    },
    { $sort: { subject: 1 } }
  ]);
};

// Bulk grade insertion with duplicate check
gradeSchema.statics.bulkInsertGrades = async function(gradeRecords, session = null) {
  const options = { ordered: false };
  if (session) options.session = session;
  
  return this.insertMany(gradeRecords, options);
};

// Get class performance summary
gradeSchema.statics.getClassPerformance = async function(classId, term, schoolId) {
  return this.aggregate([
    { 
      $match: { 
        class: new mongoose.Types.ObjectId(classId), 
        term,
        school: new mongoose.Types.ObjectId(schoolId)
      } 
    },
    {
      $group: {
        _id: '$subject',
        subject: { $first: '$subject' },
        averageScore: { $avg: '$overallScore' },
        highestScore: { $max: '$overallScore' },
        lowestScore: { $min: '$overallScore' },
        totalStudents: { $sum: 1 },
        gradeDistribution: {
          $push: '$grade'
        }
      }
    },
    {
      $project: {
        subject: 1,
        averageScore: { $round: ['$averageScore', 2] },
        highestScore: { $round: ['$highestScore', 2] },
        lowestScore: { $round: ['$lowestScore', 2] },
        totalStudents: 1,
        gradeDistribution: 1
      }
    },
    { $sort: { subject: 1 } }
  ]);
};

// Check for duplicate grades
gradeSchema.statics.findDuplicates = async function(gradeConditions) {
  return this.find({ $or: gradeConditions })
    .select('student subject class term')
    .lean();
};

// Get grades with lean optimization
gradeSchema.statics.getGradesBySchool = function(schoolId, limit = 1000, page = 1) {
  const skip = (page - 1) * limit;
  
  return this.find({ school: schoolId })
    .populate('student', 'admissionNumber')
    .populate('class', 'name')
    .populate('enteredBy', 'name')
    .select('subject test1 test2 groupWork projectWork exam term createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip)
    .lean();
};

// ========================
// 🎯 QUERY HELPERS (Chainable Filters)
// ========================

// School filter
gradeSchema.query.bySchool = function(schoolId) {
  return this.where({ school: schoolId });
};

// Student and term filter
gradeSchema.query.byStudentAndTerm = function(studentId, term) {
  return this.where({ student: studentId, term });
};

// Class and subject filter
gradeSchema.query.byClassAndSubject = function(classId, subject) {
  return this.where({ class: classId, subject });
};

// Term filter
gradeSchema.query.byTerm = function(term) {
  return this.where({ term });
};

// Subject filter
gradeSchema.query.bySubject = function(subject) {
  return this.where({ subject });
};

// Date range filter
gradeSchema.query.byDateRange = function(startDate, endDate) {
  return this.where({
    createdAt: {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    }
  });
};

// ========================
// 🎯 INSTANCE METHODS
// ========================

// Update grade with validation
gradeSchema.methods.updateSafely = async function(updates, session = null) {
  const allowedUpdates = ['test1', 'test2', 'groupWork', 'projectWork', 'exam', 'comment'];
  
  allowedUpdates.forEach(field => {
    if (updates[field] !== undefined) {
      this[field] = updates[field];
    }
  });

  return session ? this.save({ session }) : this.save();
};

// Check if grade belongs to school
gradeSchema.methods.belongsToSchool = function(schoolId) {
  return this.school.toString() === schoolId.toString();
};

// ========================
// 🎯 MIDDLEWARE (Hooks)
// ========================

// Pre-save validation for business rules
gradeSchema.pre('save', function(next) {
  // Validate that total CA doesn't exceed maximum
  const totalCA = this.totalCA;
  if (totalCA > 60) {
    return next(new Error('Total continuous assessment cannot exceed 60 points'));
  }

  // Validate exam score
  if (this.exam > 100) {
    return next(new Error('Exam score cannot exceed 100 points'));
  }

  next();
});

// Pre-remove hook to log grade deletions (for audit)
gradeSchema.pre('remove', function(next) {
  console.log(`Grade deleted: ${this._id} for student ${this.student}`);
  next();
});

// ========================
// 🎯 ADDITIONAL OPTIMIZATIONS
// ========================

// Custom toJSON transformation to include virtuals
gradeSchema.methods.toJSON = function() {
  const grade = this.toObject();
  
  // Include virtuals
  grade.totalCA = this.totalCA;
  grade.scaledCA = Math.round(this.scaledCA * 100) / 100;
  grade.exam50 = Math.round(this.exam50 * 100) / 100;
  grade.overallScore = Math.round(this.overallScore * 100) / 100;
  grade.grade = this.grade;
  grade.remarks = this.remarks;
  grade.gradeColor = this.gradeColor;
  grade.performanceCategory = this.performanceCategory;
  
  return grade;
};

module.exports = mongoose.model('Grade', gradeSchema);