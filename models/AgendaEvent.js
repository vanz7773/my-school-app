const mongoose = require('mongoose');

const agendaEventSchema = new mongoose.Schema({
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    index: true // Added index for frequent school-based queries
  },
  title: { 
    type: String, 
    required: true,
    trim: true // Remove extra whitespace
  },
  description: { 
    type: String,
    trim: true
  },
  date: { 
    type: Date, 
    required: true,
    index: true // Index for date-based queries
  },
  time: { 
    type: String,
    match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/ // Validate time format (HH:MM)
  },
  // The audience type: all, teacher, student, parent, class
  audience: {
    type: String,
    enum: ['all', 'teacher', 'student', 'parent', 'class'],
    default: 'all',
    index: true // Index for audience-based filtering
  },
  color: {
    type: String,
    default: null,
    match: /^#[0-9A-F]{6}$/i // Validate hex color format
  },
  // Optional class link (if audience is "class")
  class: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Class', 
    default: null,
    index: true // Index for class-based queries
  },
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    index: true // Index for creator-based queries
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

// For school-based queries with date ranges (most common)
agendaEventSchema.index({ school: 1, date: 1 });

// For role-based access control queries
agendaEventSchema.index({ school: 1, audience: 1, date: 1 });

// For class-specific agenda queries
agendaEventSchema.index({ school: 1, class: 1, date: 1 });

// For admin dashboard queries
agendaEventSchema.index({ school: 1, createdAt: -1 });

// For complex filtering in getAgendasCore
agendaEventSchema.index({ 
  school: 1, 
  audience: 1, 
  class: 1, 
  date: 1 
});

// For date-only queries (calendar views)
agendaEventSchema.index({ date: 1, school: 1 });

// --------------------------------------------------------------------
// 🎨 VIRTUAL FIELDS
// --------------------------------------------------------------------

// Virtual for formatted date (YYYY-MM-DD)
agendaEventSchema.virtual('dateFormatted').get(function() {
  return this.date ? this.date.toISOString().split('T')[0] : null;
});

// Virtual for datetime combination (for sorting)
agendaEventSchema.virtual('datetime').get(function() {
  if (!this.date) return null;
  
  const dateStr = this.date.toISOString().split('T')[0];
  return this.time ? new Date(`${dateStr}T${this.time}`) : this.date;
});

// Virtual for display color (falls back to default)
agendaEventSchema.virtual('displayColor').get(function() {
  return this.color || getDefaultColorForModel(this.audience);
});

// --------------------------------------------------------------------
// 📊 STATIC METHODS
// --------------------------------------------------------------------

// Get agendas by school with optional date range
agendaEventSchema.statics.findBySchool = function(schoolId, options = {}) {
  const { from, to, audience, classId, limit = 50, skip = 0 } = options;
  
  const filter = { school: schoolId };
  
  if (from && to) {
    filter.date = { $gte: new Date(from), $lte: new Date(to) };
  }
  
  if (audience) {
    filter.audience = audience;
  }
  
  if (classId) {
    filter.class = classId;
  }
  
  return this.find(filter)
    .populate('class', 'name')
    .populate('createdBy', 'firstName lastName')
    .sort({ date: 1, time: 1 })
    .limit(limit)
    .skip(skip)
    .lean();
};

// Get agenda dates for calendar view (optimized)
agendaEventSchema.statics.getCalendarDates = function(schoolId, year, month) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);
  
  return this.aggregate([
    {
      $match: {
        school: new mongoose.Types.ObjectId(schoolId),
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $project: {
        date: 1,
        audience: 1,
        color: 1,
        title: 1,
        formattedDate: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$date"
          }
        }
      }
    },
    {
      $group: {
        _id: "$formattedDate",
        events: {
          $push: {
            _id: "$_id",
            audience: "$audience",
            color: "$color",
            title: "$title"
          }
        }
      }
    }
  ]);
};

// Bulk create agendas (for imports)
agendaEventSchema.statics.bulkCreate = function(agendas) {
  return this.insertMany(agendas, { ordered: false });
};

// --------------------------------------------------------------------
// 🎯 INSTANCE METHODS
// --------------------------------------------------------------------

// Check if agenda is applicable to a specific user
agendaEventSchema.methods.isApplicableToUser = function(user) {
  if (!user || !user.role) return false;
  
  // Admin sees everything
  if (user.role === 'admin') return true;
  
  // All audience applies to everyone
  if (this.audience === 'all') return true;
  
  // Direct audience match
  if (this.audience === user.role) return true;
  
  // Class-specific logic
  if (this.audience === 'class' && this.class) {
    if (user.role === 'student' && user.class?.equals(this.class)) {
      return true;
    }
    if (user.role === 'teacher' && user.teachingClasses?.includes(this.class.toString())) {
      return true;
    }
    if (user.role === 'parent' && user.childClasses?.includes(this.class.toString())) {
      return true;
    }
  }
  
  return false;
};

// Get notification payload for this agenda
agendaEventSchema.methods.getNotificationPayload = function(action = 'created') {
  const actionMap = {
    created: 'New Agenda',
    updated: 'Agenda Updated', 
    deleted: 'Agenda Deleted'
  };
  
  return {
    title: `${actionMap[action]}: ${this.title}`,
    message: `Agenda ${action}: ${this.title}`,
    type: "agenda",
    agendaId: this._id,
    metadata: {
      agendaTitle: this.title,
      date: this.date,
      audience: this.audience,
      class: this.class
    }
  };
};

// --------------------------------------------------------------------
// 🏷️ MIDDLEWARE
// --------------------------------------------------------------------

// Pre-save middleware to set default color if not provided
agendaEventSchema.pre('save', function(next) {
  if (!this.color) {
    this.color = getDefaultColorForModel(this.audience);
  }
  
  // Ensure date is start of day for consistent querying
  if (this.date) {
    const date = new Date(this.date);
    date.setHours(0, 0, 0, 0);
    this.date = date;
  }
  
  next();
});

// Pre-remove middleware to handle cascading deletes (if needed)
agendaEventSchema.pre('remove', async function(next) {
  // Remove associated notifications
  const Notification = mongoose.model('Notification');
  await Notification.deleteMany({ agendaId: this._id });
  
  next();
});

// --------------------------------------------------------------------
// 🎨 HELPER FUNCTIONS
// --------------------------------------------------------------------

function getDefaultColorForModel(audience) {
  const colorMap = {
    student: '#2196F3',
    teacher: '#FF9800', 
    parent: '#9C27B0',
    class: '#4CAF50',
    all: '#9E9E9E'
  };
  
  return colorMap[audience] || '#E0F7FA';
}

// --------------------------------------------------------------------
// 📈 QUERY HELPERS
// --------------------------------------------------------------------

// Query helper for date ranges
agendaEventSchema.query.byDateRange = function(from, to) {
  if (from && to) {
    return this.where('date').gte(new Date(from)).lte(new Date(to));
  }
  return this;
};

// Query helper for audience
agendaEventSchema.query.byAudience = function(audience) {
  if (audience) {
    return this.where('audience', audience);
  }
  return this;
};

// Query helper for class
agendaEventSchema.query.byClass = function(classId) {
  if (classId) {
    return this.where('class', classId);
  }
  return this;
};

module.exports = mongoose.model('AgendaEvent', agendaEventSchema);