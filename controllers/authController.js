// controllers/authController.js
const User = require("../models/User");
const School = require("../models/School");
const Student = require("../models/Student");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const AdminResetRequest = require("../models/AdminResetRequest");
const Notifications = require("../models/Notification");

// ------------------------------
// Helpers
// ------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const FRONTEND_URL = process.env.FRONTEND_URL || "";

const sendError = (res, code, message) =>
  res.status(code).json({ success: false, message });

const generateToken = (user) =>
  jwt.sign(
    {
      id: user._id,
      role: user.role,
      school: user.school ? (user.school._id || user.school) : null,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

const generateResetToken = () => crypto.randomBytes(24).toString("hex");
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// ------------------------------
// REGISTER (Admins Only)
// ------------------------------
exports.register = async (req, res) => {
  try {
    const { name, email, password, role, schoolName, schoolType } = req.body;
    if (!name || !email || !password || !role || !schoolName)
      return sendError(res, 400, "All fields are required");

    const normalizedEmail = String(email).toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail }).lean();
    if (existingUser) return sendError(res, 400, "User already exists");

    // Find or create school (single query when possible)
    let school = await School.findOne({ name: schoolName }).lean();
    if (!school) {
      const created = await School.create({
        name: schoolName,
        schoolType: schoolType || "Private"
      });
      school = created.toObject();
    }

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password,
      role,
      school: school._id || school.id,
    });

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        school: {
          id: school._id || school.id,
          name: school.name,
          schoolType: school.schoolType || "Private",
          location: school.location || null,
        },
      },
    });
  } catch (err) {
    console.error("Registration error:", err);
    return sendError(res, 500, "Registration failed");
  }
};

// ------------------------------
// LOGIN
// ------------------------------
exports.login = async (req, res) => {
  try {
    const { email, password, role: selectedRole, pushToken } = req.body;
    if (!email || !password)
      return sendError(res, 400, "Email and password are required");

    const normalizedEmail = String(email).toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail })
      .select("+password")
      .populate("school", "name location schoolType")
      .lean({ virtuals: true });

    if (!user) return sendError(res, 401, "Invalid email or password");

    const userForCompare = await User.findById(user._id).select("+password");
    if (!userForCompare) return sendError(res, 401, "Invalid email or password");

    const isMatch = await userForCompare.comparePassword(password);
    if (!isMatch) return sendError(res, 401, "Invalid email or password");

    if (selectedRole && user.role !== selectedRole) {
      return sendError(
        res,
        403,
        `You cannot log in as a ${selectedRole}. Your account role is ${user.role}.`
      );
    }

    // ------------------------------------------------------------
    // 📱 SAVE EXPO PUSH TOKEN (NEW + REQUIRED)
    // ------------------------------------------------------------
    if (pushToken && typeof pushToken === "string") {
      try {
        const userDoc = await User.findById(user._id);
        userDoc.pushToken = pushToken;
        await userDoc.save();
        console.log("✅ Expo Push Token saved:", pushToken);
      } catch (tokenErr) {
        console.error("⚠️ Failed to save push token:", tokenErr.message);
      }
    }

    const token = generateToken(user);

    const userResponse = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      school: user.school
        ? {
          id: user.school._id || user.school,
          name: user.school.name,
          schoolType: user.school.schoolType || "Private",
          location: user.school.location || null,
        }
        : null,
    };

    if (user.role === "parent" && Array.isArray(user.childIds) && user.childIds.length) {
      const children = await Student.find({
        _id: { $in: user.childIds },
        school: user.school ? user.school._id || user.school : undefined,
      })
        .select("name admissionNumber class school gender")
        .populate("class", "name")
        .populate("school", "name")
        .lean();

      userResponse.children = children;
      userResponse.childrenCount = children.length;
    }

    // Set HttpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    return res.json({
      success: true,
      message: "Login successful",
      user: userResponse,
      token, // Can keep sending token for mobile apps or just remove it if migrating fully
    });
  } catch (err) {
    console.error("Login error:", err);
    return sendError(res, 500, "Login failed");
  }
};


// ------------------------------
// LOGOUT
// ------------------------------
exports.logout = (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  });
  return res.json({ success: true, message: "Logged out successfully" });
};

// ------------------------------
// ADMIN: Issue Reset Token
// ------------------------------
exports.issueResetToken = async (req, res) => {
  try {
    const admin = req.user;
    const { userId } = req.body;

    if (!admin || admin.role !== "admin")
      return sendError(res, 403, "Admins only");

    if (!userId) return sendError(res, 400, "Missing userId");

    const user = await User.findById(userId);
    if (!user) return sendError(res, 404, "User not found");

    const token = generateResetToken();
    user.passwordResetTokenHash = hashToken(token);
    user.passwordResetExpiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes
    await user.save();

    return res.json({
      success: true,
      message: "Password reset token created",
      resetLink: `${FRONTEND_URL}/reset-password?uid=${user._id}&token=${token}`,
      token,
      expiresIn: "30 minutes",
    });
  } catch (err) {
    console.error("Issue reset token error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// USER: Reset With Token
// ------------------------------
exports.resetPassword = async (req, res) => {
  try {
    const { uid, token, newPassword } = req.body;
    if (!uid || !token || !newPassword)
      return sendError(res, 400, "Missing fields");

    const user = await User.findById(uid).select("+password");
    if (!user) return sendError(res, 404, "User not found");

    if (!user.passwordResetTokenHash || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < Date.now()) {
      return sendError(res, 400, "Invalid or expired token");
    }

    if (hashToken(token) !== user.passwordResetTokenHash)
      return sendError(res, 400, "Invalid token");

    user.password = newPassword;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    return res.json({ success: true, message: "Password reset successful" });
  } catch (err) {
    console.error("Reset password error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// SELF-SERVICE: Admin Request Reset (No DOB check)
// ------------------------------
exports.requestResetForAdmin = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return sendError(res, 400, "Email is required");

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail, role: 'admin' }).select("_id name").lean();

    if (!user) {
      // Return 404 so frontend knows to show "contact super admin" message
      // In a real generic app, we might return generic success to prevent enumeration,
      // but for this specific UX requirement, we return 404.
      return sendError(res, 404, "No admin account found with this email");
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Save hashed code on user
    await User.findByIdAndUpdate(user._id, {
      passwordResetTokenHash: hashToken(code),
      passwordResetExpiresAt: Date.now() + 15 * 60 * 1000,
    });

    // In a real app, SEND EMAIL HERE.
    // For now, we return the code to the frontend for demo purposes.
    console.log(`🔐 RESET CODE for ${user.email}: ${code}`);

    return res.json({
      success: true,
      message: "Verification code sent to email",
      code, // TODO: Remove this in production and send email instead
      expiresIn: "15 minutes",
    });
  } catch (err) {
    console.error("requestResetForAdmin error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// SELF-SERVICE: Request Reset Using DOB
// ------------------------------
exports.requestResetWithDOB = async (req, res) => {
  try {
    const { email, dateOfBirth } = req.body;
    if (!email || !dateOfBirth)
      return sendError(res, 400, "Email and date of birth required");

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).lean();
    if (!user) return sendError(res, 404, "No account found");

    // Fetch student (lean)
    const student = await Student.findOne({ user: user._id }).select("dateOfBirth").lean();
    if (!student?.dateOfBirth)
      return sendError(res, 400, "DOB missing, contact admin");

    const stored = new Date(student.dateOfBirth).toISOString().split("T")[0];
    const entered = new Date(dateOfBirth).toISOString().split("T")[0];

    if (stored !== entered) return sendError(res, 400, "DOB does not match records");

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    // Save hashed code on user (select false still ok)
    await User.findByIdAndUpdate(user._id, {
      passwordResetTokenHash: hashToken(code),
      passwordResetExpiresAt: Date.now() + 15 * 60 * 1000,
    });

    return res.json({
      success: true,
      message: "Verification code created",
      code, // DEMO ONLY
      expiresIn: "15 minutes",
    });
  } catch (err) {
    console.error("requestResetWithDOB error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// SELF-SERVICE: Reset With Code
// ------------------------------
exports.resetPasswordWithCode = async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword)
      return sendError(res, 400, "Missing fields");

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).select("+password");
    if (!user) return sendError(res, 404, "User not found");

    if (!user.passwordResetTokenHash || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < Date.now()) {
      return sendError(res, 400, "Invalid or expired code");
    }

    if (hashToken(code) !== user.passwordResetTokenHash)
      return sendError(res, 400, "Incorrect verification code");

    user.password = newPassword;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    return res.json({ success: true, message: "Password reset successful" });
  } catch (err) {
    console.error("resetPasswordWithCode error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// USER: Change Password
// ------------------------------
exports.changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      return sendError(res, 400, "Old and new password required");

    const me = await User.findById(req.user?.id).select("+password");
    if (!me) return sendError(res, 404, "User not found");

    const match = await me.comparePassword(oldPassword);
    if (!match) return sendError(res, 400, "Incorrect old password");

    me.password = newPassword;
    await me.save();

    return res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    console.error("changePassword error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// SELF-SERVICE: Admin Reset Request
// ------------------------------
exports.requestAdminResetSelfService = async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) return sendError(res, 400, "Email and role are required");

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).lean();
    if (!user) return sendError(res, 404, "No account found for this email");

    const existing = await AdminResetRequest.findOne({ email: normalizedEmail, status: "pending" }).lean();
    if (existing) return sendError(res, 400, "You already have a pending password reset request. Please wait for approval");

    const reqDoc = await AdminResetRequest.create({
      user: user._id,
      email: normalizedEmail,
      role,
      school: user.school,
      requestedByIp: req.ip,
    });

    // Notify admins (lean list)
    const admins = await User.find({ school: user.school, role: "admin" }).select("_id").lean();

    const io = req.app.get("io");
    const connectedUsers = req.app.get("connectedUsers");

    // create notifications sequentially to avoid large simultaneous writes
    for (const admin of admins) {
      const notif = await Notifications.create({
        title: "Password Reset Request",
        message: `${user.name} (${role}) has requested a password reset.`,
        type: "reset-request",
        audience: "admin",
        sender: user._id,
        recipient: admin._id,
        school: user.school,
        relatedResource: reqDoc._id,
        resourceModel: "AdminResetRequest",
      });

      const socketId = connectedUsers?.get(String(admin._id));
      if (socketId && io) {
        io.to(socketId).emit("notification", {
          _id: notif._id,
          title: notif.title,
          message: notif.message,
          type: notif.type,
          from: user.name,
          audience: "admin",
          relatedResource: reqDoc._id,
          createdAt: notif.createdAt,
        });
      }
    }

    return res.json({
      success: true,
      message: "Reset request submitted",
      requestId: reqDoc._id,
    });
  } catch (err) {
    console.error("requestAdminResetSelfService error:", err);
    return sendError(res, 500, "Server error");
  }
};

// ------------------------------
// ADMIN: List / Approve / Reject Requests
// ------------------------------
exports.listAdminResetRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const admin = req.user;

    const filter = {};
    if (status) filter.status = status;

    // Security: Only show requests for the admin's school
    const schoolId = admin.school?._id || admin.school;

    console.log("🔍 [DEBUG] listAdminResetRequests:");
    console.log("👤 Admin:", admin?.email, "| Role:", admin?.role);
    console.log("🏫 School ID:", schoolId);

    if (schoolId) {
      filter.school = schoolId;
    }

    console.log("🔍 Filter Object:", JSON.stringify(filter));

    const requests = await AdminResetRequest.find(filter)
      .sort({ requestedAt: -1 })
      .populate("user", "name email role")
      .populate("handledBy", "name email")
      .lean();

    return res.json({ success: true, requests });
  } catch (err) {
    console.error("listAdminResetRequests error:", err);
    return sendError(res, 500, "Server error");
  }
};

exports.approveAdminResetRequest = async (req, res) => {
  try {
    const { newPassword, note } = req.body;
    const { id } = req.params;
    const admin = req.user;

    if (!admin || admin.role !== "admin") return sendError(res, 403, "Admins only");
    if (!newPassword || newPassword.length < 6) return sendError(res, 400, "New password must be at least 6 characters");

    const reqDoc = await AdminResetRequest.findById(id).populate("user");
    if (!reqDoc) return sendError(res, 404, "Request not found");

    // Security: Ensure admin belongs to the same school
    if (String(reqDoc.school) !== String(admin.school)) {
      return sendError(res, 403, "Access denied: Request is from a different school");
    }

    if (reqDoc.status !== "pending") return sendError(res, 400, "Request already processed");

    const user = reqDoc.user;
    user.password = newPassword;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    reqDoc.status = "approved";
    reqDoc.handledBy = admin._id;
    reqDoc.handledAt = new Date();
    reqDoc.result = { note: note || "Password reset by admin" };
    await reqDoc.save();

    // create notification (non-blocking)
    Notifications.create({
      title: "Password Reset Approved",
      message: "Your password reset request has been approved. A new password has been set.",
      type: "reset-approved",
      audience: user.role,
      sender: admin._id,
      recipient: user._id,
      school: user.school,
      relatedResource: reqDoc._id,
      resourceModel: "AdminResetRequest",
    }).catch(e => console.error("Notification create error:", e));

    return res.json({ success: true, message: "Password reset approved", requestId: reqDoc._id });
  } catch (err) {
    console.error("approveAdminResetRequest error:", err);
    return sendError(res, 500, "Server error");
  }
};

exports.rejectAdminResetRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = req.user;

    if (!admin || admin.role !== "admin") return sendError(res, 403, "Admins only");

    const reqDoc = await AdminResetRequest.findById(id).populate("user");
    if (!reqDoc) return sendError(res, 404, "Request not found");

    // Security: Ensure admin belongs to the same school
    if (String(reqDoc.school) !== String(admin.school)) {
      return sendError(res, 403, "Access denied: Request is from a different school");
    }

    reqDoc.status = "rejected";
    reqDoc.handledBy = admin._id;
    reqDoc.handledAt = new Date();
    reqDoc.note = req.body.note || "Rejected by admin";
    await reqDoc.save();

    // create notification (non-blocking)
    Notifications.create({
      title: "Password Reset Request Rejected",
      message: "Your password reset request was rejected by the administrator.",
      type: "reset-rejected",
      audience: reqDoc.user.role,
      sender: admin._id,
      recipient: reqDoc.user._id,
      school: reqDoc.school,
      relatedResource: reqDoc._id,
      resourceModel: "AdminResetRequest",
    }).catch(e => console.error("Notification create error:", e));

    return res.json({ success: true, message: "Request rejected", requestId: reqDoc._id });
  } catch (err) {
    console.error("rejectAdminResetRequest error:", err);
    return sendError(res, 500, "Server error");
  }
};
