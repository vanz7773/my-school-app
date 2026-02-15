const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

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

/* -----------------------------------------------------
   PASSWORD HASHING (Performance + Safety)
----------------------------------------------------- */

userSchema.pre("save", async function (next) {
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

/* -----------------------------------------------------
   EXPORT
----------------------------------------------------- */
module.exports =
  mongoose.models.User || mongoose.model("User", userSchema);
