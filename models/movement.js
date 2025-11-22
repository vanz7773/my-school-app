const mongoose = require('mongoose');

const timeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM)$/i;

// 🔧 Helper: Convert "HH:MM AM/PM" into minutes since midnight
const timeToMinutes = (str) => {
  const match = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return NaN;

  let [ , h, m, period ] = match;
  h = Number(h);
  m = Number(m);
  period = period.toUpperCase();

  if (period === 'PM' && h < 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;

  return h * 60 + m;
};

const movementSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      default: Date.now,
      index: true              // ⚡ Allows fast sorting/filtering by date
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },

    destination: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    purpose: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500
    },

    departureTime: {
      type: String,
      required: true,
      validate: {
        validator: (v) => timeRegex.test(v),
        message: 'Invalid format. Use "HH:MM AM/PM".'
      }
    },

    arrivalTime: {
      type: String,
      required: true,
      validate: {
        validator: (v) => timeRegex.test(v),
        message: 'Invalid format. Use "HH:MM AM/PM".'
      }
    },

    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      required: true,
      index: true // ⚡ Fast teacher lookups
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// -------------------------------------------------------------------
// 🗓 Virtual for clean date format
// -------------------------------------------------------------------
movementSchema.virtual('formattedDate').get(function () {
  return this.date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
});

// -------------------------------------------------------------------
// 🔄 Virtual for quick teacher name (auto-population-friendly)
// -------------------------------------------------------------------
movementSchema.virtual('teacherName', {
  ref: 'Teacher',
  localField: 'teacher',
  foreignField: '_id',
  justOne: true,
  options: { select: 'name' }
});

// -------------------------------------------------------------------
// ✔ Arrival must be after departure (fast + efficient)
// -------------------------------------------------------------------
movementSchema.pre('validate', function (next) {
  if (!this.departureTime || !this.arrivalTime) {
    return next(new Error('Both departureTime and arrivalTime are required'));
  }

  const dep = timeToMinutes(this.departureTime);
  const arr = timeToMinutes(this.arrivalTime);

  if (Number.isNaN(dep) || Number.isNaN(arr)) {
    return next(new Error('Invalid time format. Use "HH:MM AM/PM".'));
  }

  if (arr <= dep) {
    return next(new Error('Arrival time must be after departure time.'));
  }

  next();
});

// -------------------------------------------------------------------
// ⚡ PERFORMANCE INDEXES
// -------------------------------------------------------------------
movementSchema.index({ teacher: 1, createdAt: -1 }); // Perfect for rate-limiting + dashboard
movementSchema.index({ date: -1 });                  // Sort fast by date
movementSchema.index({ teacher: 1 });                // Common lookup

module.exports = mongoose.model('Movement', movementSchema);
