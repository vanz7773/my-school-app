const TransportRoute = require('../models/TransportRoute');
const TransportEnrollment = require('../models/TransportEnrollment');
const TransportAssignment = require('../models/TransportAssignment');
const TransportAttendance = require('../models/TransportAttendance');
const TransportFee = require('../models/TransportFee');
const Bus = require('../models/Bus');
const Term = require('../models/term');

// ==========================================
// BUS MANAGEMENT
// ==========================================
exports.createBus = async (req, res) => {
  try {
    const { name, capacity, driverName, driverPhone, teacher } = req.body;
    const school = req.user.school;
    const bus = new Bus({ name, capacity, driverName, driverPhone, teacher, school });
    await bus.save();
    res.status(201).json({ success: true, bus });
  } catch (err) {
    res.status(500).json({ message: 'Error creating bus', error: err.message });
  }
};

exports.getBuses = async (req, res) => {
  try {
    const buses = await Bus.find({ school: req.user.school }).populate('teacher', 'name');
    res.status(200).json({ success: true, buses });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching buses', error: err.message });
  }
};

exports.updateBus = async (req, res) => {
  try {
    const bus = await Bus.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      req.body,
      { new: true }
    );
    res.status(200).json({ success: true, bus });
  } catch (err) {
    res.status(500).json({ message: 'Error updating bus', error: err.message });
  }
};

exports.deleteBus = async (req, res) => {
  try {
    await Bus.findOneAndDelete({ _id: req.params.id, school: req.user.school });
    res.status(200).json({ success: true, message: 'Bus deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting bus', error: err.message });
  }
};

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
    const { studentId, termId, academicYear, busId, routeId, stop, status } = req.body;
    const school = req.user.school;

    let enrollment = await TransportEnrollment.findOne({ student: studentId, term: termId });
    if (enrollment) {
      if (busId !== undefined) enrollment.bus = busId;
      if (routeId !== undefined) enrollment.route = routeId;
      if (stop !== undefined) enrollment.stop = stop;
      if (status !== undefined) enrollment.status = status;
      await enrollment.save();
    } else {
      enrollment = new TransportEnrollment({
        student: studentId,
        term: termId,
        academicYear,
        bus: busId,
        route: routeId,
        stop,
        status: status || 'active',
        school
      });
      await enrollment.save();
    }

    res.status(201).json({ success: true, enrollment });
  } catch (err) {
    res.status(500).json({ message: 'Error enrolling student', error: err.message });
  }
};

exports.getEnrollments = async (req, res) => {
  try {
    const { termId, routeId, busId } = req.query;
    const filter = { school: req.user.school };
    if (termId) filter.term = termId;
    if (routeId) filter.route = routeId;
    if (busId) filter.bus = busId;

    const enrollments = await TransportEnrollment.find(filter)
      .populate('student', 'name admissionNumber currentClass')
      .populate('route', 'name')
      .populate('bus', 'name')
      .populate('term', 'term academicYear');

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
    const { date, termId, teacherId } = req.query;
    const filter = { school: req.user.school };
    if (date) filter.date = date;
    if (termId) filter.term = termId;
    if (teacherId) filter.teacher = teacherId;

    const assignments = await TransportAssignment.find(filter)
      .populate({
        path: 'teacher',
        populate: { path: 'user', select: 'name profilePicture' }
      })
      .populate('route', 'name')
      .populate('term', 'term academicYear');

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
    const today = new Date().toISOString().split('T')[0];
    const userId = req.user.id;

    // TransportAssignment.teacher references 'User' (stores User._id)
    // But older records may have stored the Teacher document _id by mistake.
    // Look up the Teacher profile to get both IDs so we match either way.
    const Teacher = require('../models/Teacher');
    const teacherProfile = await Teacher.findOne({ user: userId });

    const teacherIds = [userId];
    if (teacherProfile) teacherIds.push(teacherProfile._id);

    const assignment = await TransportAssignment.findOne({
      teacher: { $in: teacherIds },
      date: today
    }).populate('route').populate('term', 'term academicYear');

    res.status(200).json({ success: true, assignment });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch today assignment', error: err.message });
  }
};

exports.getRouteStudents = async (req, res) => {
  try {
    const { routeId, termId } = req.query;
    const filter = {
      term: termId,
      school: req.user.school,
      status: 'active'
    };
    if (routeId) filter.route = routeId;
    
    const enrollments = await TransportEnrollment.find(filter)
      .populate('student', 'name admissionNumber photo')
      .populate('route', 'name')
      .populate('term', 'term academicYear');

    res.status(200).json({ success: true, students: enrollments });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch route students', error: err.message });
  }
};

exports.syncAttendance = async (req, res) => {
  try {
    const { date, busId, assignmentId, updates } = req.body;
    const school = req.user.school;

    const results = [];

    for (const update of updates) {
      const { studentId, routeSnapshot, stopSnapshot, picked, pickedAt, dropped, droppedAt, markedBy } = update;

      if (dropped && !picked) {
        continue;
      }

      const record = await TransportAttendance.findOneAndUpdate(
        { student: studentId, date },
        {
          bus: busId,
          routeSnapshot,
          stopSnapshot,
          assignment: assignmentId,
          picked,
          pickedAt: picked ? (pickedAt || new Date()) : null,
          dropped,
          droppedAt: dropped ? (droppedAt || new Date()) : null,
          markedBy: markedBy || req.user.id,
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
      picked: true, 
      dropped: false 
    };
    if (date) filter.date = date;

    const missing = await TransportAttendance.find(filter)
      .populate('student', 'name')
      .populate('bus', 'name')
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
    const { date, routeSnapshot } = req.query;
    const filter = { school: req.user.school, date };
    if (routeSnapshot) filter.routeSnapshot = routeSnapshot;

    const records = await TransportAttendance.find(filter)
      .populate('student', 'name admissionNumber')
      .populate('markedBy', 'name');

    res.status(200).json({ success: true, records });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching daily records', error: err.message });
  }
};

// ==========================================
// USAGE-BASED FEE COMPUTATION
// ==========================================
exports.getMonthlyReport = async (req, res) => {
  try {
    const { month, year } = req.query;
    const school = req.user.school;
    
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    const monthStr = month.toString().padStart(2, '0');
    const datePrefix = `${year}-${monthStr}`;

    const attendances = await TransportAttendance.find({
      school,
      date: { $regex: `^${datePrefix}` },
      picked: true
    }).lean();

    const routes = await TransportRoute.find({ school }).lean();
    const routeFeeMap = {};
    routes.forEach(r => {
      routeFeeMap[r.name] = r.defaultFee || 0;
    });

    const studentUsageMap = {};

    attendances.forEach(att => {
      const sId = att.student.toString();
      if (!studentUsageMap[sId]) {
        studentUsageMap[sId] = {
          studentId: att.student,
          daysUsed: 0,
          totalFee: 0,
          dailyBreakdown: []
        };
      }
      studentUsageMap[sId].daysUsed += 1;
      
      const feeForDay = routeFeeMap[att.routeSnapshot] || 0;
      studentUsageMap[sId].totalFee += feeForDay;
      studentUsageMap[sId].dailyBreakdown.push({
        date: att.date,
        route: att.routeSnapshot,
        fee: feeForDay
      });
    });

    const studentIds = Object.keys(studentUsageMap);
    const students = await require('../models/Student').find({ _id: { $in: studentIds } }, 'name admissionNumber currentClass').lean();
    
    const finalReport = students.map(s => {
      const usage = studentUsageMap[s._id.toString()];
      return {
        student: s,
        daysUsed: usage.daysUsed,
        totalFee: usage.totalFee,
        dailyBreakdown: usage.dailyBreakdown,
        avgFeePerDay: usage.daysUsed > 0 ? (usage.totalFee / usage.daysUsed) : 0
      };
    });

    res.status(200).json({ success: true, report: finalReport });
  } catch (err) {
    res.status(500).json({ message: 'Error generating report', error: err.message });
  }
};

exports.getFees = async (req, res) => {
  try {
    const { termId } = req.query;
    const fees = await TransportFee.find({ term: termId, school: req.user.school })
      .populate('student', 'name admissionNumber currentClass')
      .populate('term', 'term academicYear');

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
