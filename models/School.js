// models/School.js
const mongoose = require("mongoose");

const schoolSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["active", "restricted"],
      default: "active",
    },

    schoolType: {
      type: String,
      enum: ["Private", "Government"],
      default: "Private",
    },

    lockedFeatures: [{
      type: String,
      enum: [
        "exams",
        "reports",
        "feeding_fee",
        "attendance",
        "transport",
        "billing",
        "teacher_attendance_card",
        "student_attendance_card",
        "teacher_feeding_fee_card",
        "teacher_events_card",
        "teacher_announcements_card",
        "teacher_assignments_card",
        "teacher_online_quiz_card",
        "teacher_transport_card",
        "teacher_timetable_card",
        "teacher_weekly_exercise_card",
        "teacher_exams_report_card",
        "teacher_sba_direct_entry_card",
        "teacher_payslips_card",
      ],
    }],

    lastAdminLogin: { type: Date, default: null },


    // Geofence — optional
    location: {
      type: {
        type: String,
        enum: ["Polygon"],
      },
      coordinates: {
        type: [[[Number]]],
        validate: {
          validator: function (coords) {
            if (!coords) return true; // allow empty
            if (!Array.isArray(coords) || coords.length === 0) return false;

            const ring = coords[0];
            if (!Array.isArray(ring) || ring.length < 4) return false;

            const first = ring[0];
            const last = ring[ring.length - 1];

            return (
              Array.isArray(first) &&
              Array.isArray(last) &&
              first[0] === last[0] &&
              first[1] === last[1]
            );
          },
          message:
            "Polygon must be closed and contain at least 4 coordinate points.",
        },
      },
    },

    geofenceRadius: {
      type: Number,
      default: 50,
      min: 10,
    },

    sbaMaster: {
      type: Map,
      of: {
        path: String,
        url: String,
      },
      default: {},
    },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    toJSON: {
      transform(doc, ret) {
        if (ret.location?.coordinates) {
          ret.location.coordinates = ret.location.coordinates.map((ring) =>
            ring.map((point) => point.map((v) => Number(v)))
          );
        }
        return ret;
      },
    },
  }
);

// -----------------------------------------
// PRE-SAVE — clean empty location
// -----------------------------------------
schoolSchema.pre("save", function (next) {
  // If no coordinates, wipe the whole location object
  if (!this.location?.coordinates) {
    this.location = undefined;
  } else {
    // Normalize numbers
    this.location.coordinates = this.location.coordinates.map((ring) =>
      ring.map((point) => point.map((n) => Number(n)))
    );
  }

  this.updatedAt = Date.now();
  next();
});

// -----------------------------------------
// Sparse index so MongoDB doesn't require location
// -----------------------------------------
schoolSchema.index({ location: "2dsphere" }, { sparse: true });

// Virtual center point
schoolSchema.virtual("centerPoint").get(function () {
  if (!this.location?.coordinates) return null;

  const ring = this.location.coordinates[0];
  const lngSum = ring.reduce((s, p) => s + p[0], 0);
  const latSum = ring.reduce((s, p) => s + p[1], 0);

  return {
    longitude: lngSum / ring.length,
    latitude: latSum / ring.length,
  };
});

module.exports = mongoose.model("School", schoolSchema);
