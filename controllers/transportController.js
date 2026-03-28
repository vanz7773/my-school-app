const TransportRoute = require('../models/TransportRoute');
const TransportEnrollment = require('../models/TransportEnrollment');
const TransportAssignment = require('../models/TransportAssignment');
const TransportAttendance = require('../models/TransportAttendance');
const TransportFee = require('../models/TransportFee');
const TransportWeeklyFeePayment = require('../models/transportWeeklyFeePayment');
const Bus = require('../models/Bus');
const Term = require('../models/term');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const { broadcastNotification } = require('./notificationController');

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

    const mongoose = require('mongoose');
    const sId = (studentId && mongoose.Types.ObjectId.isValid(studentId)) ? new mongoose.Types.ObjectId(studentId) : studentId;
    const tId = (termId && mongoose.Types.ObjectId.isValid(termId)) ? new mongoose.Types.ObjectId(termId) : termId;

    // UNIQUE KEY: student + school (Continuous Enrollment)
    let enrollment = await TransportEnrollment.findOne({ student: sId, school });
    if (enrollment) {
      if (busId !== undefined) enrollment.bus = busId;
      if (routeId !== undefined) enrollment.route = routeId;
      if (stop !== undefined) enrollment.stop = stop;
      if (status !== undefined) enrollment.status = status;
      // Optionally update term/academicYear for the record, but it's not the primary key
      if (termId !== undefined) enrollment.term = termId;
      if (academicYear !== undefined) enrollment.academicYear = academicYear;
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
    const { termId, routeId, busId, academicYear } = req.query;
    const filter = { school: req.user.school };
    if (termId) filter.term = termId;
    if (routeId) filter.route = routeId;
    if (busId) filter.bus = busId;
    if (academicYear) filter.academicYear = academicYear;

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

exports.updateEnrollmentFee = async (req, res) => {
  try {
    const { enrollmentId } = req.params;
    const { feeAmount } = req.body;
    
    if (feeAmount === undefined || isNaN(feeAmount)) {
      return res.status(400).json({ message: 'Valid feeAmount is required' });
    }

    const enrollment = await TransportEnrollment.findOneAndUpdate(
      { _id: enrollmentId, school: req.user.school },
      { feeAmount: Number(feeAmount) },
      { new: true }
    );

    if (!enrollment) {
      return res.status(404).json({ message: 'Enrollment not found' });
    }

    res.status(200).json({ success: true, enrollment });
  } catch (err) {
    res.status(500).json({ message: 'Error updating fee amount', error: err.message });
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
    // Priority: Query param date > Localized date > UTC fallback
    const today = req.query.date || new Date().toISOString().split('T')[0];
    const userId = req.user.id;

    console.log(`[DEBUG] getTodayAssignment lookup - User: ${userId}, Date: ${today}`);

    const Teacher = require('../models/Teacher');
    const teacherProfile = await Teacher.findOne({ user: userId });

    const teacherIds = [userId];
    if (teacherProfile) teacherIds.push(teacherProfile._id);

    // DYNAMIC ACCESS: Since the teacher is assigned to the bus permanently 
    // (Monday - Friday), we fetch their MOST RECENT assignment and use its 
    // term credentials to grant them access to today's manifest, ignoring strict date expiration.
    const assignment = await TransportAssignment.findOne({
      teacher: { $in: teacherIds }
    }).sort({ createdAt: -1 })
      .populate('route')
      .populate('term', 'term academicYear');

    if (assignment) {
      console.log(`[DEBUG] Found recent persistent assignment for route: ${assignment.route?.name}, term: ${assignment.term?._id || assignment.term}`);
    } else {
      console.log(`[DEBUG] No assignment found for teacher IDs: ${teacherIds}`);
    }

    res.status(200).json({ success: true, assignment });
  } catch (err) {
    console.error('[CRITICAL] getTodayAssignment error:', err);
    res.status(500).json({ message: 'Failed to fetch today assignment', error: err.message });
  }
};

exports.getRouteStudents = async (req, res) => {
  try {
    let { routeId, termId } = req.query;
    console.log(`[DEBUG] getRouteStudents Query - routeId: ${routeId}, termId: ${termId}, user school: ${req.user?.school}`);

    // Robust ID Casting (Prevent string vs ObjectId mismatch in filter)
    const mongoose = require('mongoose');
    if (routeId && mongoose.Types.ObjectId.isValid(routeId)) routeId = new mongoose.Types.ObjectId(routeId);
    if (termId && mongoose.Types.ObjectId.isValid(termId)) termId = new mongoose.Types.ObjectId(termId);

    const filter = {
      school: req.user.school,
      status: 'active'
    };
    
    // NOTE: Term filter is removed to allow Continuous Enrollment manifest.
    // Students enrolled in ANY term (active status) are picked up by the bus.
    
    // DELIBERATE OMISSION: We are NO LONGER filtering by `filter.route = routeId`
    // because this school operates a Single-Bus System where one bus picks up 
    // ALL students from all locations. This ensures the teacher sees the full manifest.

    console.log('[DEBUG] Final filter (Single-Bus Mode):', JSON.stringify(filter));

    const enrollments = await TransportEnrollment.find(filter)
      .populate({
        path: 'student',
        populate: { path: 'user', select: 'name profilePicture photo' }
      })
      .populate('route', 'name stops')
      .populate('term', 'term academicYear');

    console.log(`[DEBUG] Found ${enrollments.length} matching enrollments`);

    // Normalize each enrollment for the mobile app
    const students = enrollments.map(e => {
      const obj = e.toObject();
      if (obj.student) {
        // Explicitly extract name from nested user if available
        const studentName = obj.student.user?.name || obj.student.name || 'Unknown Student';
        obj.student.name = studentName;
        obj.student.photo = obj.student.user?.photo || obj.student.user?.profilePicture || obj.student.photo;
        
        console.log(`[DEBUG] Mapping Student - ID: ${obj.student._id}, Name: ${studentName}`);
      }
      return obj;
    });

    res.status(200).json({ success: true, students });
  } catch (err) {
    console.error('[CRITICAL] getRouteStudents error:', err);
    res.status(500).json({ message: 'Failed to fetch route students', error: err.message });
  }
};

exports.syncAttendance = async (req, res) => {
  try {
    const { date, busId, assignmentId, updates } = req.body;
    const school = req.user.school;
    const senderId = req.user._id || req.user.id;

    const results = [];
    const pushPromises = [];

    for (const update of updates) {
      const { studentId, routeSnapshot, stopSnapshot, picked, isAbsent, pickedAt, dropped, droppedAt, markedBy } = update;

      if (dropped && !picked) {
        continue;
      }

      // Check PREVIOUS state to only notify when state CHANGES
      const existing = await TransportAttendance.findOne({ student: studentId, date });
      const wasDropped = existing ? existing.dropped : false;
      const wasPicked = existing ? existing.picked : false;

      const record = await TransportAttendance.findOneAndUpdate(
        { student: studentId, date },
        {
          bus: busId,
          routeSnapshot,
          stopSnapshot,
          assignment: assignmentId,
          picked,
          isAbsent: isAbsent || false,
          pickedAt: picked ? (pickedAt || new Date()) : null,
          dropped,
          droppedAt: dropped ? (droppedAt || new Date()) : null,
          markedBy: markedBy || req.user.id,
          school
        },
        { upsert: true, new: true }
      );
      results.push(record);

      // Trigger Push Notification if status changed
      if ((picked && !wasPicked) || (dropped && !wasDropped)) {
        const studentInfo = await Student.findById(studentId).populate('user', 'name');
        if (studentInfo) {
          const parentRecipients = new Set();
          if (studentInfo.parent) parentRecipients.add(String(studentInfo.parent));
          if (Array.isArray(studentInfo.parentIds)) {
            studentInfo.parentIds.forEach(p => parentRecipients.add(String(p._id || p)));
          }

          if (parentRecipients.size > 0) {
            const userList = [...parentRecipients];
            const studentName = studentInfo.user?.name || studentInfo.name || "Your child";
            
            let title = '';
            let message = '';
            
            if (dropped && !wasDropped) {
                title = "Student Dropped Off";
                message = `${studentName} has safely been dropped off by the school bus.`;
            } else if (picked && !wasPicked) {
                title = "Student Boarded Bus";
                message = `${studentName} has boarded the school bus.`;
            }

            const notif = new Notification({
              sender: senderId,
              school: school,
              title: title,
              message: message,
              type: "parent-transport",
              audience: "parent",
              recipientRoles: [],
              recipientUsers: userList,
              studentId: studentInfo._id,
              createdAt: new Date()
            });

            pushPromises.push(notif.save().then(saved => broadcastNotification(req, saved)));
          }
        }
      }
    }

    // Process push notifications in the background
    if (pushPromises.length > 0) {
        Promise.allSettled(pushPromises).catch(console.error);
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
    const { date, startDate, endDate, routeSnapshot, student } = req.query;
    const filter = { school: req.user.school };
    
    // Add student filtering for parent tracking
    if (student) filter.student = student;
    
    if (startDate && endDate) {
      filter.date = { $gte: startDate, $lte: endDate };
    } else if (date) {
      filter.date = date;
    }
    
    if (routeSnapshot) filter.routeSnapshot = routeSnapshot;

    const records = await TransportAttendance.find(filter)
      .populate('student', 'name admissionNumber')
      .populate('markedBy', 'name')
      .sort({ date: -1 }); // Newest dates first for parent history

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

// ==========================================
// WEEKLY FEE PAYMENT (Teacher records)
// ==========================================
exports.recordWeeklyFeePayment = async (req, res) => {
  try {
    const {
      studentId,
      termId,
      academicYear,
      weekLabel,      // e.g. "Week 4"
      daysCount = 5,  // default to full 5-day school week
      paymentMethod,
      notes,
    } = req.body;

    if (!studentId || !termId || !academicYear || !weekLabel) {
      return res.status(400).json({ message: 'studentId, termId, academicYear, weekLabel are required' });
    }

    const mongoose = require('mongoose');
    const sId = (studentId && mongoose.Types.ObjectId.isValid(studentId)) ? new mongoose.Types.ObjectId(studentId) : studentId;
    const tId = (termId && mongoose.Types.ObjectId.isValid(termId)) ? new mongoose.Types.ObjectId(termId) : termId;
    const schoolId = (req.user.school && mongoose.Types.ObjectId.isValid(req.user.school)) ? new mongoose.Types.ObjectId(req.user.school) : req.user.school;

    console.log(`[DEBUG] recordWeeklyFeePayment lookup - Student: ${sId}, Term: ${tId}, Teacher School: ${schoolId}`);

    // UNIQUE LOOKUP: Find the one persistent and active enrollment for this student in this school
    let enrollment = await TransportEnrollment.findOne({
      student: sId,
      school: schoolId,
      status: 'active'
    });
    
    if (!enrollment) {
      console.warn(`[DEBUG] NO ACTIVE ENROLLMENT found for student ${sId} at school ${schoolId}`);
      return res.status(404).json({ message: 'Transport enrollment not found for this student. Please enroll them first.' });
    }

    const dailyRate = enrollment.feeAmount || 0;
    const totalAmount = dailyRate * Number(daysCount);

    // upsert: if already paid this week, update notes/method but keep the amount
    const payment = await TransportWeeklyFeePayment.findOneAndUpdate(
      { student: sId, term: tId, weekLabel, school: schoolId },
      {
        $set: {
          enrollment: enrollment._id,
          academicYear,
          daysCount: Number(daysCount),
          dailyRate,
          totalAmount,
          paymentMethod: paymentMethod || 'Cash',
          notes: notes || '',
          recordedBy: req.user.id,
          school: req.user.school,
        },
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      payment,
      message: `Weekly fee of ¢${totalAmount.toFixed(2)} recorded for ${weekLabel}`,
    });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key — already recorded, return existing
      const existing = await TransportWeeklyFeePayment.findOne({
        student: req.body.studentId,
        term: req.body.termId,
        weekLabel: req.body.weekLabel,
      });
      return res.status(200).json({ success: true, payment: existing, alreadyRecorded: true });
    }
    res.status(500).json({ message: 'Error recording weekly fee payment', error: err.message });
  }
};

exports.getWeeklyFeePayments = async (req, res) => {
  try {
    const { termId, weekLabel, studentId } = req.query;
    const filter = { school: req.user.school };
    if (termId) filter.term = termId;
    if (weekLabel) filter.weekLabel = weekLabel;
    if (studentId) filter.student = studentId;

    const payments = await TransportWeeklyFeePayment.find(filter)
      .populate('student', 'name admissionNumber')
      .populate('recordedBy', 'user')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, payments });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching weekly fee payments', error: err.message });
  }
};
