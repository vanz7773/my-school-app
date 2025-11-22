const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema({
  title: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 200,
    index: true // Index for search operations
  },
  description: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  dueDate: {
    type: Date,
    required: true,
    index: true // Index for due date queries
  },
  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    required: true,
    index: true // Index for class-based queries
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true // Index for creator-based queries
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    index: true // Index for school-based queries
  },
  // New fields for better functionality
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled'],
    default: 'active',
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  attachments: [{
    name: String,
    url: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  submissionCount: {
    type: Number,
    default: 0
  }
}, { 
  timestamps: true,
  // Additional schema options for performance
  minimize: true, // Remove empty objects
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  },
  toObject: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

// --------------------------------------------------------------------
// 🔍 COMPOUND INDEXES FOR PERFORMANCE
// --------------------------------------------------------------------

// For school-based queries with due dates (most common)
assignmentSchema.index({ school: 1, dueDate: 1 });

// For teacher dashboard queries
assignmentSchema.index({ school: 1, createdBy: 1, dueDate: 1 });

// For class-specific assignment queries
assignmentSchema.index({ school: 1, class: 1, dueDate: 1 });

// For student view queries
assignmentSchema.index({ school: 1, class: 1, status: 1, dueDate: 1 });

// For admin dashboard with filters
assignmentSchema.index({ school: 1, status: 1, createdAt: -1 });

// For search functionality
assignmentSchema.index({ 
  school: 1, 
  title: 'text', 
  description: 'text' 
});

// For upcoming assignments
assignmentSchema.index({ dueDate: 1, status: 1, school: 1 });

// For bulk operations
assignmentSchema.index({ school: 1, class: 1, createdAt: -1 });

// --------------------------------------------------------------------
// 🎨 VIRTUAL FIELDS
// --------------------------------------------------------------------

// Virtual for formatted due date
assignmentSchema.virtual('dueDateFormatted').get(function() {
  return this.dueDate ? this.dueDate.toISOString().split('T')[0] : null;
});

// Virtual for days remaining
assignmentSchema.virtual('daysRemaining').get(function() {
  if (!this.dueDate) return null;
  
  const today = new Date();
  const due = new Date(this.dueDate);
  const diffTime = due - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return diffDays;
});

// Virtual for assignment status (overdue, due soon, etc.)
assignmentSchema.virtual('urgencyStatus').get(function() {
  if (!this.dueDate) return 'no-due-date';
  
  const daysRemaining = this.daysRemaining;
  
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining === 0) return 'due-today';
  if (daysRemaining <= 2) return 'due-soon';
  if (daysRemaining <= 7) return 'upcoming';
  
  return 'future';
});

// Virtual for assignment display color based on urgency
assignmentSchema.virtual('displayColor').get(function() {
  const status = this.urgencyStatus;
  const colorMap = {
    'overdue': '#FF3B30',
    'due-today': '#FF9500',
    'due-soon': '#FFCC00',
    'upcoming': '#4CD964',
    'future': '#8E8E93',
    'no-due-date': '#C7C7CC'
  };
  
  return colorMap[status] || '#8E8E93';
});

// Virtual for isOverdue
assignmentSchema.virtual('isOverdue').get(function() {
  return this.urgencyStatus === 'overdue';
});

// --------------------------------------------------------------------
// 📊 STATIC METHODS
// --------------------------------------------------------------------

// Get assignments by school with optional filters
assignmentSchema.statics.findBySchool = function(schoolId, options = {}) {
  const {
    classId,
    teacherId,
    status = 'active',
    dueBefore,
    dueAfter,
    search,
    page = 1,
    limit = 50,
    sort = '-dueDate'
  } = options;
  
  const filter = { school: schoolId, status };
  
  if (classId) filter.class = classId;
  if (teacherId) filter.createdBy = teacherId;
  
  if (dueBefore || dueAfter) {
    filter.dueDate = {};
    if (dueBefore) filter.dueDate.$lte = new Date(dueBefore);
    if (dueAfter) filter.dueDate.$gte = new Date(dueAfter);
  }
  
  if (search && search.trim()) {
    filter.$or = [
      { title: new RegExp(search.trim(), 'i') },
      { description: new RegExp(search.trim(), 'i') }
    ];
  }
  
  const skip = (page - 1) * limit;
  
  return this.find(filter)
    .populate('class', 'name section')
    .populate('createdBy', 'firstName lastName email')
    .sort(sort)
    .limit(limit)
    .skip(skip)
    .lean();
};

// Get assignments for a specific class
assignmentSchema.statics.findByClass = function(classId, options = {}) {
  const {
    status = 'active',
    upcomingOnly = false,
    limit = 100
  } = options;
  
  const filter = { class: classId, status };
  
  if (upcomingOnly) {
    filter.dueDate = { $gte: new Date() };
  }
  
  return this.find(filter)
    .populate('createdBy', 'firstName lastName')
    .sort({ dueDate: 1 })
    .limit(limit)
    .lean();
};

// Get upcoming assignments for student
assignmentSchema.statics.getUpcomingForStudent = function(studentClassId, limit = 10) {
  return this.find({
    class: studentClassId,
    status: 'active',
    dueDate: { $gte: new Date() }
  })
    .populate('class', 'name')
    .populate('createdBy', 'firstName lastName')
    .sort({ dueDate: 1 })
    .limit(limit)
    .lean();
};

// Bulk create assignments (for imports)
assignmentSchema.statics.bulkCreate = function(assignments, options = {}) {
  const { validateBeforeSave = true, ordered = false } = options;
  return this.insertMany(assignments, { validateBeforeSave, ordered });
};

// Get assignment statistics for dashboard
assignmentSchema.statics.getStats = async function(schoolId, classId = null) {
  const matchStage = { school: new mongoose.Types.ObjectId(schoolId) };
  if (classId) matchStage.class = new mongoose.Types.ObjectId(classId);
  
  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        upcomingCount: {
          $sum: {
            $cond: [
              { $and: [{ $gte: ['$dueDate', new Date()] }, { $eq: ['$status', 'active'] }] },
              1,
              0
            ]
          }
        },
        overdueCount: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ['$dueDate', new Date()] }, { $eq: ['$status', 'active'] }] },
              1,
              0
            ]
          }
        }
      }
    }
  ]);
  
  return stats.reduce((acc, stat) => {
    acc[stat._id] = {
      total: stat.count,
      upcoming: stat.upcomingCount,
      overdue: stat.overdueCount
    };
    return acc;
  }, {});
};

// --------------------------------------------------------------------
// 🎯 INSTANCE METHODS
// --------------------------------------------------------------------

// Check if assignment is accessible to a specific user
assignmentSchema.methods.isAccessibleToUser = function(user) {
  if (!user || !user.role) return false;
  
  // Admin can access everything
  if (user.role === 'admin') return true;
  
  // Teacher can access their own assignments or if they teach the class
  if (user.role === 'teacher') {
    if (this.createdBy.toString() === user._id.toString()) return true;
    
    // Check if teacher is assigned to the class (would need population)
    return false; // This would require additional logic with class data
  }
  
  // Student can access assignments from their class
  if (user.role === 'student') {
    // This would require comparing student's class with assignment's class
    return false; // This would require additional logic
  }
  
  return false;
};

// Update submission count
assignmentSchema.methods.incrementSubmissionCount = function() {
  this.submissionCount += 1;
  return this.save();
};

// Mark as completed
assignmentSchema.methods.markAsCompleted = function() {
  this.status = 'completed';
  return this.save();
};

// Check if assignment is due soon (within 2 days)
assignmentSchema.methods.isDueSoon = function() {
  return this.urgencyStatus === 'due-soon' || this.urgencyStatus === 'due-today';
};

// Get notification payload for this assignment
assignmentSchema.methods.getNotificationPayload = function(action = 'created') {
  const actionMap = {
    created: 'New Assignment',
    updated: 'Assignment Updated', 
    deleted: 'Assignment Deleted',
    reminder: 'Assignment Reminder'
  };
  
  return {
    title: `${actionMap[action]}: ${this.title}`,
    message: `Assignment ${action}: ${this.title}`,
    type: "assignment",
    assignmentId: this._id,
    metadata: {
      assignmentTitle: this.title,
      dueDate: this.dueDate,
      class: this.class,
      urgency: this.urgencyStatus
    }
  };
};

// --------------------------------------------------------------------
// 🏷️ MIDDLEWARE
// --------------------------------------------------------------------

// Pre-save middleware for validation and defaults
assignmentSchema.pre('save', function(next) {
  // Ensure dueDate is in the future for new assignments
  if (this.isNew && this.dueDate && this.dueDate < new Date()) {
    // You might want to handle this differently based on requirements
    console.warn('Assignment due date is in the past');
  }
  
  // Auto-set status based on due date for existing assignments
  if (this.isModified('dueDate') && !this.isNew) {
    if (this.dueDate < new Date() && this.status === 'active') {
      // Optionally auto-mark as overdue
      // this.status = 'overdue';
    }
  }
  
  next();
});

// Post-save middleware for cache invalidation
assignmentSchema.post('save', function(doc) {
  // Invalidate any related caches
  // This would integrate with your caching system
  console.log(`Assignment ${doc._id} saved - cache invalidation needed`);
});

// Pre-remove middleware to handle cascading deletes
assignmentSchema.pre('remove', async function(next) {
  try {
    // Remove associated notifications
    const Notification = mongoose.model('Notification');
    await Notification.deleteMany({ assignmentId: this._id });
    
    // Remove associated submissions if they exist
    // const Submission = mongoose.model('Submission');
    // await Submission.deleteMany({ assignment: this._id });
    
    next();
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------
// 📈 QUERY HELPERS
// --------------------------------------------------------------------

// Query helper for active assignments
assignmentSchema.query.active = function() {
  return this.where('status').equals('active');
};

// Query helper for overdue assignments
assignmentSchema.query.overdue = function() {
  return this.where('dueDate').lt(new Date()).where('status').equals('active');
};

// Query helper for upcoming assignments
assignmentSchema.query.upcoming = function() {
  return this.where('dueDate').gte(new Date()).where('status').equals('active');
};

// Query helper for class
assignmentSchema.query.byClass = function(classId) {
  return this.where('class').equals(classId);
};

// Query helper for creator
assignmentSchema.query.byCreator = function(teacherId) {
  return this.where('createdBy').equals(teacherId);
};

// Query helper for date range
assignmentSchema.query.byDueDateRange = function(from, to) {
  if (from && to) {
    return this.where('dueDate').gte(new Date(from)).lte(new Date(to));
  }
  if (from) {
    return this.where('dueDate').gte(new Date(from));
  }
  if (to) {
    return this.where('dueDate').lte(new Date(to));
  }
  return this;
};

module.exports = mongoose.model('Assignment', assignmentSchema);