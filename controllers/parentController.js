// controllers/parentController.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Student = require('../models/Student');
const Notification = require('../models/Notification');

const GH_PHONE_REGEX = /^0\d{9}$/;

/**
 * Helper: sanitize and normalize array of ObjectId-ish values
 */
function normalizeIds(arr = []) {
  return Array.from(new Set(
    (arr || [])
      .filter(Boolean)
      .map(id => (String(id)))
  ));
}

/**
 * Create a parent and optionally link to children (two-way)
 * Body: { name, email, password, phone, childrenIds: [studentId] }
 */
exports.createParent = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { name, email, password, phone, childrenIds } = req.body;
    const schoolId = req.user.school;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    if (phone && !GH_PHONE_REGEX.test(phone)) {
      return res.status(400).json({ message: 'Invalid phone format. Use 0XXXXXXXXX' });
    }

    // Normalize inputs
    const normalizedChildrenIds = normalizeIds(childrenIds);

    // Quick uniqueness checks (single queries)
    const [existingEmail, existingPhone] = await Promise.all([
      User.findOne({ email }).lean(),
      phone ? User.findOne({ phone, school: schoolId }).lean() : Promise.resolve(null)
    ]);

    if (existingEmail) return res.status(400).json({ message: 'Parent with this email already exists.' });
    if (existingPhone) return res.status(400).json({ message: 'Phone number already in use.' });

    // Start transaction where available
    session.startTransaction();

    // Create parent
    const parent = new User({
      name,
      email,
      phone: phone || null,
      password, // hashed by pre-save hook
      role: 'parent',
      school: schoolId,
      childIds: []
    });

    await parent.save({ session });

    // If children provided, validate and link in bulk
    let linkedChildren = [];
    if (normalizedChildrenIds.length > 0) {
      // Only accept students from same school
      const validStudents = await Student.find({
        _id: { $in: normalizedChildrenIds },
        school: schoolId
      }).select('_id').lean();

      const validIds = validStudents.map(s => s._id.toString());

      if (validIds.length > 0) {
        // Add parent._id to each student's parentIds using $addToSet
        await Student.updateMany(
          { _id: { $in: validIds } },
          { $addToSet: { parentIds: parent._id } },
          { session }
        );

        // Set parent's childIds to the valid list
        parent.childIds = validIds;
        await parent.save({ session });

        linkedChildren = validIds;
      }
    }

    // Create welcome notification for parent + notify admins (in parallel)
    const adminDocs = await User.find({ role: 'admin', school: schoolId }).select('_id').lean();
    const adminIds = adminDocs.map(a => a._id);

    const notifications = [
      {
        title: 'Welcome to the School Portal',
        message: `👋 Welcome ${name}! Your parent account has been created.`,
        sender: req.user._id,
        recipientUsers: [parent._id],
        school: schoolId,
        type: 'announcement'
      },
      {
        title: 'New Parent Created',
        message: `📢 Parent "${name}" was added by ${req.user.name || 'an admin'}.`,
        sender: req.user._id,
        recipientUsers: adminIds,
        school: schoolId,
        type: 'announcement'
      }
    ];

    // Insert notifications (no need to be transactional)
    await Notification.insertMany(notifications, { session });

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      message: 'Parent created and linked successfully.',
      parent: {
        id: parent._id,
        name: parent.name,
        email: parent.email,
        phone: parent.phone,
        childIds: parent.childIds
      }
    });
  } catch (err) {
    try { await session.abortTransaction(); } catch (e) { }
    session.endSession();
    console.error('❌ Error creating parent:', err);
    return res.status(500).json({ message: 'Error creating parent', error: err.message });
  }
};

/**
 * Parent links a student by admissionNumber (used by parent to link themselves)
 * Body: { admissionNumber }
 * This will add the parent's id to student.parentIds and add student's id to parent's childIds
 */
exports.linkChildByAdmission = async (req, res) => {
  try {
    const { admissionNumber } = req.body;
    const parentId = req.user._id;
    const schoolId = req.user.school;

    if (!admissionNumber) {
      return res.status(400).json({ message: 'Admission number is required' });
    }

    const student = await Student.findOne({ admissionNumber, school: schoolId });
    if (!student) return res.status(404).json({ message: 'Student not found in your school' });

    // Prevent linking duplicates
    const updates = [];
    if (!Array.isArray(student.parentIds) || !student.parentIds.map(String).includes(String(parentId))) {
      updates.push(
        Student.updateOne({ _id: student._id }, { $addToSet: { parentIds: parentId } })
      );
    }

    updates.push(User.updateOne({ _id: parentId, role: 'parent', school: schoolId }, { $addToSet: { childIds: student._id } }));

    await Promise.all(updates);

    return res.status(200).json({ message: 'Student linked successfully', studentId: student._id });
  } catch (err) {
    console.error('❌ linkChildByAdmission error:', err);
    return res.status(500).json({ message: 'Failed to link student', error: err.message });
  }
};

/**
 * Get children for logged-in parent
 */
exports.getMyChildren = async (req, res) => {
  try {
    const parentId = req.user._id;
    const schoolId = req.user.school;

    const parent = await User.findById(parentId).select('childIds role school').lean();
    if (!parent || parent.role !== 'parent') {
      return res.status(404).json({ message: 'Parent not found' });
    }

    const children = await Student.find({ _id: { $in: parent.childIds }, school: schoolId })
      .populate('user', 'name email')
      .populate('school', 'name schoolType')
      .lean();

    return res.json(children);
  } catch (err) {
    console.error('❌ getMyChildren error:', err);
    return res.status(500).json({ message: 'Error fetching children', error: err.message });
  }
};

/**
 * Admin: get all parents in school (fast, paginated-friendly)
 * Query params: page, limit, q (search)
 */
exports.getAllParents = async (req, res) => {
  try {
    const schoolId = req.user.school;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const q = (req.query.q || '').trim();

    const filter = { role: 'parent', school: schoolId };
    if (q) {
      // text-like search on name or email
      filter.$or = [
        { name: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') }
      ];
    }

    const [parents, total] = await Promise.all([
      User.find(filter)
        .select('-password')
        .populate({
          path: 'childIds',
          populate: { path: 'user', select: 'name email' }
        })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);

    return res.json({ parents, meta: { total, page, limit } });
  } catch (err) {
    console.error('❌ getAllParents error:', err);
    return res.status(500).json({ message: 'Error fetching parents', error: err.message });
  }
};

/**
 * Update parent and re-link children (two-way clean)
 * PUT /parents/:id
 */
exports.updateParent = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { name, email, password, phone, childrenIds } = req.body;
    const schoolId = req.user.school;

    // Validate phone if present
    if (phone && !GH_PHONE_REGEX.test(phone)) {
      return res.status(400).json({ message: 'Invalid phone number format. Use 0XXXXXXXXX' });
    }

    // Ensure parent belongs to this school
    const parent = await User.findOne({ _id: id, role: 'parent', school: schoolId });
    if (!parent) return res.status(404).json({ message: 'Parent not found in your school' });

    // Validate email uniqueness if changed
    if (email && email !== parent.email) {
      const exists = await User.findOne({ email }).lean();
      if (exists) return res.status(400).json({ message: 'Email already in use' });
    }

    // Start transaction
    session.startTransaction();

    // Update fields
    if (name) parent.name = name;
    if (email) parent.email = email;
    if (phone) parent.phone = phone;
    if (password) parent.password = await bcrypt.hash(password, 10);

    // Re-link children in bulk:
    const normalizedChildrenIds = normalizeIds(childrenIds || []);

    // 1) Remove this parent from any currently linked students that are not in new list
    if (Array.isArray(parent.childIds) && parent.childIds.length > 0) {
      const currentChildIds = parent.childIds.map(String);
      const toRemove = currentChildIds.filter(idStr => !normalizedChildrenIds.includes(idStr));
      if (toRemove.length > 0) {
        await Student.updateMany(
          { _id: { $in: toRemove }, school: schoolId },
          { $pull: { parentIds: parent._id } },
          { session }
        );
      }
    }

    // 2) Add parent to new children (only valid students in same school)
    let validNewChildren = [];
    if (normalizedChildrenIds.length > 0) {
      const validStudents = await Student.find({
        _id: { $in: normalizedChildrenIds },
        school: schoolId
      }).select('_id').lean();

      validNewChildren = validStudents.map(s => s._id.toString());

      if (validNewChildren.length > 0) {
        await Student.updateMany(
          { _id: { $in: validNewChildren } },
          { $addToSet: { parentIds: parent._id } },
          { session }
        );
      }
    }

    // Set parent's childIds to only valid ones
    parent.childIds = validNewChildren;

    await parent.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json({
      message: 'Parent updated and children re-linked successfully',
      parent: {
        id: parent._id,
        name: parent.name,
        email: parent.email,
        phone: parent.phone,
        childIds: parent.childIds
      }
    });
  } catch (err) {
    try { await session.abortTransaction(); } catch (e) { }
    session.endSession();
    console.error('❌ updateParent error:', err);
    return res.status(500).json({ message: 'Error updating parent', error: err.message });
  }
};

/**
 * Delete parent and unlink their children
 */
exports.deleteParent = async (req, res) => {
  try {
    const { id } = req.params;
    const schoolId = req.user.school;

    // Find parent and ensure same school
    const parent = await User.findOne({ _id: id, role: 'parent', school: schoolId });
    if (!parent) return res.status(404).json({ message: 'Parent not found in your school' });

    // Unlink parentId from any students' parentIds
    await Student.updateMany(
      { parentIds: parent._id, school: schoolId },
      { $pull: { parentIds: parent._id } }
    );

    // Delete parent user
    await User.deleteOne({ _id: parent._id });

    return res.json({ message: 'Parent deleted and students unlinked' });
  } catch (err) {
    console.error('❌ deleteParent error:', err);
    return res.status(500).json({ message: 'Error deleting parent', error: err.message });
  }
};

/**
 * Admin links a child to a parent (bulk-safe)
 * Body: { childId, parentId }
 */
exports.linkChild = async (req, res) => {
  try {
    const { childId, parentId } = req.body;
    const schoolId = req.user.school;

    if (!childId || !parentId) return res.status(400).json({ message: 'childId and parentId required' });

    const [parent, student] = await Promise.all([
      User.findOne({ _id: parentId, role: 'parent', school: schoolId }).select('_id').lean(),
      Student.findOne({ _id: childId, school: schoolId }).select('_id').lean()
    ]);

    if (!parent) return res.status(404).json({ message: 'Parent not found in your school' });
    if (!student) return res.status(404).json({ message: 'Student not found in your school' });

    await Promise.all([
      User.updateOne({ _id: parentId }, { $addToSet: { childIds: childId } }),
      Student.updateOne({ _id: childId }, { $addToSet: { parentIds: parentId } })
    ]);

    return res.json({ message: 'Parent linked to child successfully' });
  } catch (err) {
    console.error('❌ linkChild error:', err);
    return res.status(500).json({ message: 'Failed to link', error: err.message });
  }
};

/**
 * Admin unlink child <-> parent
 * Body: { childId, parentId }
 */
exports.unlinkChild = async (req, res) => {
  try {
    const { childId, parentId } = req.body;
    const schoolId = req.user.school;

    if (!childId || !parentId) return res.status(400).json({ message: 'childId and parentId required' });

    await Promise.all([
      User.updateOne({ _id: parentId, role: 'parent', school: schoolId }, { $pull: { childIds: childId } }),
      Student.updateOne({ _id: childId, school: schoolId }, { $pull: { parentIds: parentId } })
    ]);

    return res.json({ message: 'Parent unlinked from child successfully' });
  } catch (err) {
    console.error('❌ unlinkChild error:', err);
    return res.status(500).json({ message: 'Failed to unlink', error: err.message });
  }
};

/**
 * Parent Dashboard: Fetch children by parentId (used by mobile dashboard)
 * GET /parents/:parentId/children
 */
exports.getChildrenByParentId = async (req, res) => {
  try {
    const { parentId } = req.params;

    // Security: parent may only fetch their own children unless admin
    if (req.user.role === 'parent' && String(req.user._id) !== String(parentId)) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const parent = await User.findById(parentId).select('childIds role school').lean();
    if (!parent || parent.role !== 'parent') {
      return res.status(404).json({ message: 'Parent not found or invalid role' });
    }

    const children = await Student.find({
      _id: { $in: parent.childIds },
      school: parent.school
    })
      .populate('class', 'name')
      .populate('school', 'name schoolType')
      .select('name admissionNumber class school academicYear gender')
      .lean();

    return res.json({ children });
  } catch (err) {
    console.error('❌ getChildrenByParentId error:', err);
    return res.status(500).json({ message: 'Failed to fetch children', error: err.message });
  }
};
