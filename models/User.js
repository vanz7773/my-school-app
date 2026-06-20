const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const PERMISSION_KEYS = [
  "canViewDashboard",
  "canViewTeachers",
  "canAddTeachers",
  "canEditTeachers",
  "canDeleteTeachers",
  "canViewAttendance",
  "canEditAttendance",
  "canApproveMovement",
  "canExportReports",
  "canViewFees",
  "canEditFees",
  "canViewFeedingFee",
  "canEditFeedingFee",
  "canManageAdmins",
];

const buildPermissions = (value = false) =>
  PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = value;
    return acc;
  }, {});

const normalizePermissions = (permissions = {}) =>
  PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = Boolean(permissions?.[key]);
    return acc;
  }, {});

/* -----------------------------------------------------
   SCHEMA
----------------------------------------------------- */

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true, // 🔥 faster lookups by name (teacher search, etc.)
    },

    gender: {
      type: String,
      enum: ["Male", "Female", null, ""],
      default: null,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true, // 🔥 login speed
    },

    phone: {
      type: String,
      match: [/^0\d{9}$/, "Invalid Ghana phone number format"],
      default: null,
      index: true, // 🔥 helpful for contact fetch
    },

    password: {
      type: String,
      required: true,
      select: false, // 🔥 improves security + reduces payload size
    },

    role: {
      type: String,
      enum: ["admin", "teacher", "student", "parent", "superadmin"],
      required: true,
      index: true, // 🔥 role-based dashboards & filters
    },

    permissions: {
      canViewDashboard: { type: Boolean, default: false },
      canViewTeachers: { type: Boolean, default: false },
      canAddTeachers: { type: Boolean, default: false },
      canEditTeachers: { type: Boolean, default: false },
      canDeleteTeachers: { type: Boolean, default: false },
      canViewAttendance: { type: Boolean, default: false },
      canEditAttendance: { type: Boolean, default: false },
      canApproveMovement: { type: Boolean, default: false },
      canExportReports: { type: Boolean, default: false },
      canViewFees: { type: Boolean, default: false },
      canEditFees: { type: Boolean, default: false },
      canViewFeedingFee: { type: Boolean, default: false },
      canEditFeedingFee: { type: Boolean, default: false },
      canManageAdmins: { type: Boolean, default: false },
    },

    // False means a legacy admin account should keep full access until edited.
    permissionsConfigured: {
      type: Boolean,
      default: false,
      index: true,
    },

    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true, // 🔥 almost every query filters by school
    },

    profilePicture: {
      type: String,
      default: null,
    },

    /* -----------------------------------------------------
       🔔 Expo Push Notification Token (NEW FIELD)
    ----------------------------------------------------- */
    pushToken: {
      type: String,
      default: null,
      index: true, // 🔥 fast lookup when sending push notifications
    },

    // Parent → children relationship
    childIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Student",
        index: true, // 🔥 parent dashboards load faster
      },
    ],

    // Reset token + expiry
    passwordResetTokenHash: {
      type: String,
      default: null,
      select: false, // 🔥 private security field
    },

    passwordResetExpiresAt: {
      type: Date,
      default: null,
      index: true, // 🔥 expire searches faster
    },

    dateOfBirth: { type: Date, default: null },

    // 🔥 Added to guarantee Welcome Card only shows once globally
    hasSeenWelcome: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true, index: true },
    deletedAt: { type: Date, default: null },

    audit: {
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      lastActionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      lastActionAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

/* -----------------------------------------------------
   INDEXES: Huge performance boost for all your controllers
----------------------------------------------------- */

// 🔥 fast login, fast student/teacher fetch
userSchema.index({ school: 1, role: 1 });

// 🔥 parent-child relationships
userSchema.index({ childIds: 1 });

// 🔥 expiration handling
userSchema.index({ passwordResetExpiresAt: 1 });
userSchema.index({ school: 1, role: 1, isActive: 1 });

/* -----------------------------------------------------
   PASSWORD HASHING (Performance + Safety)
----------------------------------------------------- */

userSchema.pre("save", async function (next) {
  if (this.role === "superadmin") {
    this.permissions = buildPermissions(true);
    this.permissionsConfigured = true;
  }

  if (!this.isModified("password")) return next();

  try {
    // Salt rounds: 10 = secure + fast for mobile/low-end devices
    this.password = await bcrypt.hash(this.password, 10);
    next();
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------
   METHOD: comparePassword (Lightning-fast)
----------------------------------------------------- */
userSchema.methods.comparePassword = function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.statics.permissionKeys = PERMISSION_KEYS;
userSchema.statics.emptyPermissions = () => buildPermissions(false);
userSchema.statics.fullAdminPermissions = () => buildPermissions(true);
userSchema.statics.normalizePermissions = normalizePermissions;

/* -----------------------------------------------------
   EXPORT
----------------------------------------------------- */
module.exports =
  mongoose.models.User || mongoose.model("User", userSchema);
