const TransportRoute = require('../models/TransportRoute');
const TransportEnrollment = require('../models/TransportEnrollment');
const TransportAssignment = require('../models/TransportAssignment');
const TransportAttendance = require('../models/TransportAttendance');
const TransportFee = require('../models/TransportFee');
const Term = require('../models/term');

// ==========================================
// ROUTES MANAGEMENT
// ==========================================
exports.createRoute = async (req, res) => {
  try {
    const { name, stops, defaultFee } = req.body;
    const school = req.user.school;
    const route = new TransportRoute({ name, stops, defaultFee, school });
    await route.save();
    res.status(201).json({ success: true, route });
  } catch (err) {
    res.status(500).json({ message: 'Error creating route', error: err.message });
  }
};

exports.getRoutes = async (req, res) => {
  try {
    const routes = await TransportRoute.find({ school: req.user.school }).sort({ name: 1 });
    res.status(200).json({ success: true, routes });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching routes', error: err.message });
  }
};

exports.deleteRoute = async (req, res) => {
  try {
    await TransportRoute.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Route deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting route', error: err.message });
  }
};

// ==========================================
// ENROLLMENT MANAGEMENT
// ==========================================
exports.enrollStudent = async (req, res) => {
  try {
    const { studentId, termId, academicYear, routeId, dropOffStop } = req.body;
    const school = req.user.school;

    // Check if enrolled
    const existing = await TransportEnrollment.findOne({ student: studentId, term: termId });
    if (existing) {
      existing.route = routeId;
      existing.dropOffStop = dropOffStop;
      await existing.save();
      return res.status(200).json({ success: true, enrollment: existing });
    }

    const enrollment = new TransportEnrollment({
      student: studentId,
      term: termId,
      academicYear,
      route: routeId,
      dropOffStop,
      school
    });
    await enrollment.save();

    // Optionally create a Fee record here
    const route = await TransportRoute.findById(routeId);
    if (route && route.defaultFee > 0) {
      const fee = new TransportFee({
        student: studentId,
        term: termId,
        totalAmount: route.defaultFee,
        balance: route.defaultFee,
        school
      });
      await fee.save().catch(e => console.log('Fee exists or err', e.message)); // Ignore duplicate fee errors
    }

    res.status(201).json({ success: true, enrollment });
  } catch (err) {
    res.status(500).json({ message: 'Error enrolling student', error: err.message });
  }
};

exports.getEnrollments = async (req, res) => {
  try {
    const { termId, routeId } = req.query;
    const filter = { school: req.user.school };
    if (termId) filter.term = termId;
    if (routeId) filter.route = routeId;

    const enrollments = await TransportEnrollment.find(filter)
      .populate('student', 'name admissionNumber currentClass')
      .populate('route', 'name');

    res.status(200).json({ success: true, enrollments });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching enrollments', error: err.message });
  }
};

// ==========================================
// TEACHER ASSIGNMENT
// ==========================================
exports.assignTeacher = async (req, res) => {
  try {
    const { teacherId, routeId, date, termId } = req.body;
    const school = req.user.school;

    // Update if exists for that date and route, else create
    const assignment = await TransportAssignment.findOneAndUpdate(
      { route: routeId, date },
      { teacher: teacherId, term: termId, school },
      { upsert: true, new: true }
    );

    res.status(201).json({ success: true, assignment });
  } catch (err) {
    res.status(500).json({ message: 'Error assigning teacher', error: err.message });
  }
};

exports.getAssignments = async (req, res) => {
  try {
    const { date, termId } = req.query;
    const filter = { school: req.user.school };
    if (date) filter.date = date;
    if (termId) filter.term = termId;

    const assignments = await TransportAssignment.find(filter)
      .populate('teacher', 'name')
      .populate('route', 'name');

    res.status(200).json({ success: true, assignments });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching assignments', error: err.message });
  }
};

// ==========================================
// MOBILE APP ENDPOINTS (TEACHER)
// ==========================================
exports.getTodayAssignment = async (req, res) => {
  try {
    // Expected format: YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];
    const teacherId = req.user.id;

    // First find the assignment
    const assignment = await TransportAssignment.findOne({
      teacher: teacherId,
      date: today
    }).populate('route');

    if (!assignment) {
      return res.status(200).json({ success: true, assignment: null });
    }

    res.status(200).json({ success: true, assignment });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch today assignment', error: err.message });
  }
};

exports.getRouteStudents = async (req, res) => {
  try {
    const { routeId, termId } = req.query;
    
    // Find enrollments for this route and term
    const enrollments = await TransportEnrollment.find({
      route: routeId,
      term: termId,
      school: req.user.school
    }).populate('student', 'name admissionNumber photo');

    res.status(200).json({ success: true, students: enrollments });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch route students', error: err.message });
  }
};

// Sync handler for offline mobile operations
exports.syncAttendance = async (req, res) => {
  try {
    const { date, routeId, assignmentId, updates } = req.body;
    const school = req.user.school;

    // updates format: [{ studentId, boarded, boardedAt, exited, exitedAt, exitStop }, ...]
    const results = [];

    for (const update of updates) {
      const { studentId, boarded, boardedAt, exited, exitedAt, exitStop } = update;

      const record = await TransportAttendance.findOneAndUpdate(
        { student: studentId, date },
        {
          route: routeId,
          assignment: assignmentId,
          boarded,
          boardedAt: boardedAt || null,
          exited,
          exitedAt: exitedAt || null,
          exitStop: exitStop || null,
          school
        },
        { upsert: true, new: true }
      );
      results.push(record);
    }

    res.status(200).json({ success: true, updatedCount: results.length });
  } catch (err) {
    res.status(500).json({ message: 'Error syncing attendance', error: err.message });
  }
};

// ==========================================
// ADMIN ANALYTICS & ALERTS
// ==========================================
exports.getMissingDropOffs = async (req, res) => {
  try {
    const { date } = req.query;
    const filter = { 
      school: req.user.school, 
      boarded: true, 
      exited: false 
    };
    if (date) filter.date = date;

    const missing = await TransportAttendance.find(filter)
      .populate('student', 'name')
      .populate('route', 'name')
      .populate({
        path: 'assignment',
        populate: { path: 'teacher', select: 'name' }
      });

    res.status(200).json({ success: true, missing });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching missing lists', error: err.message });
  }
};

exports.getDailyAttendance = async (req, res) => {
  try {
    const { date, routeId } = req.query;
    const filter = { school: req.user.school, date };
    if (routeId) filter.route = routeId;

    const records = await TransportAttendance.find(filter)
      .populate('student', 'name admissionNumber')
      .populate('route', 'name stops');

    res.status(200).json({ success: true, records });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching daily records', error: err.message });
  }
};

// ==========================================
// FEE MANAGEMENT
// ==========================================
exports.getFees = async (req, res) => {
  try {
    const { termId } = req.query;
    const fees = await TransportFee.find({ term: termId, school: req.user.school })
      .populate('student', 'name admissionNumber currentClass');

    res.status(200).json({ success: true, fees });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching fees', error: err.message });
  }
};

exports.recordPayment = async (req, res) => {
  try {
    const { feeId, amount, method, receiptNumber } = req.body;
    
    const fee = await TransportFee.findById(feeId);
    if (!fee) return res.status(404).json({ message: 'Fee record not found' });

    fee.amountPaid += amount;
    fee.balance = fee.totalAmount - fee.amountPaid;
    
    fee.paymentHistory.push({
      amount,
      method,
      receiptNumber,
      recordedBy: req.user.id
    });

    await fee.save();
    res.status(200).json({ success: true, fee });
  } catch (err) {
    res.status(500).json({ message: 'Error recording payment', error: err.message });
  }
};
