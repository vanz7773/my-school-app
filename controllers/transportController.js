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
const mongoose = require('mongoose');
const TransportFeeRecord = require('../models/TransportFeeRecord');
const { attendanceQueue } = require('../queue/attendanceQueue');
const { broadcastNotification } = require('./notificationController');
const DAY_MS = 24 * 60 * 60 * 1000;

const flattenWeeklyPaymentRecord = (doc) => {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const payment = obj.payment || {};
  const daysCount = Number(payment.daysCount ?? obj.daysCount ?? 0) || 0;
  const dailyRate = Number(payment.dailyRate ?? obj.dailyRate ?? 0) || 0;
  const totalAmount = Number(payment.totalAmount ?? obj.totalAmount ?? 0) || 0;

  return {
    _id: obj._id,
    student: obj.student,
    enrollment: obj.enrollment,
    term: obj.term,
    academicYear: obj.academicYear,
    weekLabel: payment.weekLabel || obj.weekLabel || '',
    date: obj.date,
    daysCount,
    dailyRate,
    totalAmount,
    paymentMethod: payment.paymentMethod || obj.paymentMethod || 'Cash',
    notes: payment.notes || obj.notes || '',
    school: obj.school,
    recordedBy: payment.recordedBy || obj.recordedBy || obj.markedBy || null,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    source: 'attendance',
  };
};

const parseDateOnly = (value) => {
  if (!value) return null;
  const [year, month, day] = String(value).split('T')[0].split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
};

const getCoveredTransportPaymentMap = async ({ schoolId, termId, weekLabel, targetDate }) => {
  const [attendancePayments, legacyPayments] = await Promise.all([
    TransportAttendance.find({
      school: schoolId,
      term: termId,
      'payment.weekLabel': weekLabel,
      'payment.totalAmount': { $gt: 0 },
    }).lean(),
    TransportWeeklyFeePayment.find({
      school: schoolId,
      term: termId,
      weekLabel,
      totalAmount: { $gt: 0 },
    }).lean(),
  ]);

  const paymentMap = new Map();
  const normalizedPayments = [
    ...attendancePayments.map(flattenWeeklyPaymentRecord),
    ...legacyPayments.map(flattenWeeklyPaymentRecord),
  ].filter(Boolean);

  for (const payment of normalizedPayments) {
    const sid = payment.student?._id?.toString() || payment.student?.toString();
    const payStart = parseDateOnly(payment.date);

    if (!sid || !payStart) continue;

    const daysCount = Math.max(1, Number(payment.daysCount) || 1);
    const payEnd = new Date(payStart.getTime() + daysCount * DAY_MS);

    if (targetDate >= payStart && targetDate < payEnd) {
      const amount = Number(payment.totalAmount) || 0;
      const existing = paymentMap.get(sid);

      if (!existing || amount > existing.amount) {
        paymentMap.set(sid, {
          amount,
          date: payment.date,
          daysCount,
        });
      }
    }
  }

  return paymentMap;
};

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
    const enrollmentStatus = status || 'active';

    const mongoose = require('mongoose');
    const sId = (studentId && mongoose.Types.ObjectId.isValid(studentId)) ? new mongoose.Types.ObjectId(studentId) : studentId;

    if (!studentId) {
      return res.status(400).json({ message: 'Student is required' });
    }

    const student = await Student.findOne({ _id: sId, school }).select('_id');
    if (!student) {
      return res.status(404).json({ message: 'Student not found for this school' });
    }

    let resolvedRouteId = routeId;
    if (!resolvedRouteId) {
      let fallbackRoute = await TransportRoute.findOne({ school, name: 'Single Bus Route' }).select('_id');
      if (!fallbackRoute) {
        fallbackRoute = await TransportRoute.create({
          school,
          name: 'Single Bus Route',
          stops: ['Default Stop'],
          defaultFee: 0,
        });
      }
      resolvedRouteId = fallbackRoute._id;
    }

    const normalizedStop = typeof stop === 'string' ? stop.trim() : '';
    if (enrollmentStatus === 'active' && !normalizedStop) {
      return res.status(400).json({ message: 'Pickup location is required for active enrollment' });
    }

    // UNIQUE KEY: student + school (Continuous Enrollment)
    let enrollment = await TransportEnrollment.findOne({ student: sId, school });
    if (enrollment) {
      if (busId !== undefined) enrollment.bus = busId;
      if (resolvedRouteId !== undefined) enrollment.route = resolvedRouteId;
      if (normalizedStop) enrollment.stop = normalizedStop;
      if (status !== undefined) enrollment.status = enrollmentStatus;
      // Optionally update term/academicYear for the record, but it's not the primary key
      if (termId !== undefined) enrollment.term = termId;
      if (academicYear !== undefined) enrollment.academicYear = academicYear;
      await enrollment.save();
    } else {
      enrollment = new TransportEnrollment({
        student: sId,
        term: termId,
        academicYear,
        bus: busId,
        route: resolvedRouteId,
        stop: normalizedStop,
        status: enrollmentStatus,
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
      .populate('student', 'name admissionNumber class')
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
    const effectiveDate = date || new Date().toISOString().split('T')[0];

    if (!teacherId || !routeId || !termId) {
      return res.status(400).json({ message: 'teacherId, routeId and termId are required' });
    }

    let assignment = await TransportAssignment.findOne({ route: routeId, school })
      .sort({ updatedAt: -1, createdAt: -1 });

    if (!assignment) {
      assignment = new TransportAssignment({
        teacher: teacherId,
        route: routeId,
        date: effectiveDate,
        term: termId,
        school,
      });
    } else {
      assignment.teacher = teacherId;
      assignment.route = routeId;
      assignment.date = assignment.date || effectiveDate;
      assignment.term = termId;
      assignment.school = school;
    }

    await assignment.save();

    await TransportAssignment.deleteMany({
      route: routeId,
      school,
      _id: { $ne: assignment._id },
    });

    assignment = await TransportAssignment.findById(assignment._id)
      .populate('teacher', 'name profilePicture')
      .populate('route', 'name')
      .populate('term', 'term academicYear');

    res.status(201).json({ success: true, assignment });
  } catch (err) {
    res.status(500).json({ message: 'Error assigning teacher', error: err.message });
  }
};

exports.getAssignments = async (req, res) => {
  try {
    const { teacherId, routeId } = req.query;
    const filter = { school: req.user.school };
    if (teacherId) filter.teacher = teacherId;
    if (routeId) filter.route = routeId;

    const assignmentDocs = await TransportAssignment.find(filter)
      .populate('teacher', 'name profilePicture')
      .populate('route', 'name')
      .populate('term', 'term academicYear')
      .sort({ updatedAt: -1, createdAt: -1 });

    const seenRoutes = new Set();
    const assignments = assignmentDocs.filter((assignment) => {
      const routeKey = String(assignment.route?._id || assignment.route || '');
      if (!routeKey || seenRoutes.has(routeKey)) return false;
      seenRoutes.add(routeKey);
      return true;
    });

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
    const userId = req.user.id;

    console.log(`[DEBUG] getTodayAssignment lookup - User: ${userId}`);

    const Teacher = require('../models/Teacher');
    const teacherProfile = await Teacher.findOne({ user: userId });

    const teacherIds = [userId];
    if (teacherProfile) teacherIds.push(teacherProfile._id);

    // PERSISTENT ACCESS: Once an admin assigns a teacher to the bus, that
    // assignment remains active until an admin changes it.
    const assignment = await TransportAssignment.findOne({
      teacher: { $in: teacherIds },
      school: req.user.school,
    }).sort({ updatedAt: -1, createdAt: -1 })
      .populate('route')
      .populate('term', 'term academicYear');

    if (assignment) {
      console.log(`[DEBUG] Found persistent assignment for route: ${assignment.route?.name}, term: ${assignment.term?._id || assignment.term}`);
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
    const { date, busId, assignmentId, updates, termId, academicYear, weekLabel } = req.body;
    const school = req.user.school;
    const senderId = req.user._id || req.user.id;

    const results = [];
    const pushPromises = [];

    for (const update of updates) {
      const { studentId, routeSnapshot, stopSnapshot, picked, isAbsent, pickedAt, dropped, droppedAt, markedBy } = update;

      if (dropped && !picked) {
        continue;
      }

      const enrollment = await TransportEnrollment.findOne({
        student: studentId,
        school,
        status: 'active',
      }).select('feeAmount');

      const dailyRate = Number(enrollment?.feeAmount) || 0;
      const expectedAmount = dailyRate;

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
          term: termId || undefined,
          academicYear: academicYear || undefined,
          dailyRate,
          weeklyDaysExpected: 5,
          expectedAmount,
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
    const students = await require('../models/Student').find({ _id: { $in: studentIds } }, 'name admissionNumber class').lean();
    
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
      .populate('student', 'name admissionNumber class')
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
      date,           // e.g. "2026-03-28" 
      daysCount = 5,  // default to full 5-day school week
      paymentMethod,
      notes,
    } = req.body;

    if (!studentId || !termId || !academicYear || !weekLabel || !date) {
      return res.status(400).json({ message: 'studentId, termId, academicYear, weekLabel, date are required' });
    }

    console.log(`[DEBUG] recordWeeklyFeePayment lookup - Student: ${studentId}, Term: ${termId}, Week: ${weekLabel}, Date: ${date}, Received daysCount: ${req.body.daysCount}`);

    const mongoose = require('mongoose');
    const sId = (studentId && mongoose.Types.ObjectId.isValid(studentId)) ? new mongoose.Types.ObjectId(studentId) : studentId;
    const tId = (termId && mongoose.Types.ObjectId.isValid(termId)) ? new mongoose.Types.ObjectId(termId) : termId;
    const schoolId = (req.user.school && mongoose.Types.ObjectId.isValid(req.user.school)) ? new mongoose.Types.ObjectId(req.user.school) : req.user.school;
    const safeDaysCount = Math.max(1, Number(daysCount) || 1);

    // UNIQUE LOOKUP: Find the one persistent and active enrollment for this student in this school
    let enrollment = await TransportEnrollment.findOne({
      student: sId,
      school: schoolId,
      status: 'active'
    }).populate('route', 'name');
    
    if (!enrollment) {
      console.warn(`[DEBUG] NO ACTIVE ENROLLMENT found for student ${sId} at school ${schoolId}`);
      return res.status(404).json({ message: 'Transport enrollment not found for this student. Please enroll them first.' });
    }

    const dailyRate = Number(enrollment.feeAmount) || 0;
    const totalAmount = dailyRate * safeDaysCount;

    // EXACT DATE MATCHING explicitly for 'Daily' logs
    const targetDate = new Date(date);
    targetDate.setHours(0,0,0,0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23,59,59,999);

    const existingWeeklyPayment = await TransportAttendance.findOne({
      student: sId,
      term: tId,
      school: req.user.school,
      date: { $gte: targetDate, $lte: endOfDay }
    });

    const paymentPayload = existingWeeklyPayment?.payment || {};
    const updatedDaysCount = (Number(paymentPayload.daysCount) || 0) + safeDaysCount;
    const updatedTotalAmount = (Number(paymentPayload.totalAmount) || 0) + totalAmount;

    const payment = await TransportAttendance.findOneAndUpdate(
      existingWeeklyPayment
        ? { _id: existingWeeklyPayment._id }
        : { student: sId, date },
      {
        $setOnInsert: {
          student: sId,
          date,
          assignment: null,
          picked: false,
          isAbsent: false,
          dropped: false,
          markedBy: req.user.id,
          school: req.user.school,
        },
        $set: {
          term: tId,
          academicYear,
          dailyRate,
          weeklyDaysExpected: updatedDaysCount,
          expectedAmount: updatedTotalAmount,
          payment: {
            weekLabel,
            daysCount: updatedDaysCount,
            dailyRate,
            totalAmount: updatedTotalAmount,
            paymentMethod: paymentMethod || paymentPayload.paymentMethod || 'Cash',
            notes: notes || paymentPayload.notes || '',
            recordedBy: req.user.id,
            paidAt: new Date(),
          },
          routeSnapshot: enrollment.route?.name || 'Unknown Route',
          stopSnapshot: enrollment.stop || 'Unknown Stop',
        },
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      payment: flattenWeeklyPaymentRecord(payment),
      message: `Transport fee of ¢${totalAmount.toFixed(2)} recorded for ${weekLabel}`,
    });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key — already recorded, return existing attendance-backed payment
      const existing = await TransportAttendance.findOne({
        student: req.body.studentId,
        date: req.body.date,
      }).populate('student', 'name admissionNumber');
      return res.status(200).json({
        success: true,
        payment: flattenWeeklyPaymentRecord(existing),
        alreadyRecorded: true,
      });
    }
    res.status(500).json({ message: 'Error recording weekly fee payment', error: err.message });
  }
};

exports.getWeeklyFeePayments = async (req, res) => {
  try {
    const { termId, weekLabel, studentId, date } = req.query;
    const filter = { school: req.user.school };
    if (termId) filter.term = termId;
    if (weekLabel) filter['payment.weekLabel'] = weekLabel;
    if (studentId) filter.student = studentId;
    if (date) filter.date = date;

    const payments = await TransportAttendance.find({
      ...filter,
      'payment.totalAmount': { $gt: 0 },
    })
      .populate('student', 'name admissionNumber')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      payments: payments.map(flattenWeeklyPaymentRecord),
    });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching weekly fee payments', error: err.message });
  }
};

// Utility: Normalize week number
const normalizeWeekNumber = (week) => {
  if (!week) return 1;
  return typeof week === 'string' ? parseInt(week.replace(/Week\s*/i, '').trim(), 10) || 1 : parseInt(week, 10) || 1;
};

// ==========================================
// QUEUE BASED MARKS (Like Feeding Fee)
// ==========================================
exports.processTransportJob = async (jobData) => {
    const { student, termId, academicYear, week, day, status, routeSnapshot, stopSnapshot, reqUser } = jobData;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const schoolId = reqUser.school;
        const weekNumber = normalizeWeekNumber(week);

        let record = await TransportFeeRecord.findOne({
          termId,
          week: weekNumber,
          school: schoolId
        })
          .sort({ updatedAt: -1, createdAt: -1 })
          .session(session);

        if (!record) {
            record = new TransportFeeRecord({
                school: schoolId,
                termId,
                academicYear,
                week: weekNumber,
                breakdown: []
            });
        }

        let breakdownIndex = record.breakdown.findIndex(b => b.student.toString() === student.toString());

        if (breakdownIndex === -1) {
            const enrollment = await TransportEnrollment.findOne({
                student,
                school: schoolId,
                status: 'active'
            }).session(session);

            const dailyRate = enrollment && enrollment.feeAmount ? enrollment.feeAmount : 0;

            const studentDoc = await Student.findById(student)
              .populate('user', 'name')
              .populate('class', 'name displayName')
              .session(session);

            const resolvedClassName =
              studentDoc?.class?.displayName ||
              studentDoc?.class?.name ||
              'Unknown Class';

            record.breakdown.push({
                student,
              studentName: studentDoc ? (studentDoc.user?.name || studentDoc.name) : "Unknown Student",
              className: resolvedClassName,
                routeSnapshot: routeSnapshot || (enrollment?.route ? 'Route' : null),
                stopSnapshot: stopSnapshot || (enrollment?.stop || null),
                dailyRate,
                days: {
                    M: 'notmarked',
                    T: 'notmarked',
                    W: 'notmarked',
                    TH: 'notmarked',
                    F: 'notmarked'
                },
                perDayFee: { M: 0, T: 0, W: 0, TH: 0, F: 0 },
                total: 0,
                daysBoarded: 0,
                currency: 'GHS'
            });
            breakdownIndex = record.breakdown.length - 1;
        }

        // Validate day key
        if (['M', 'T', 'W', 'TH', 'F'].includes(day)) {
            record.breakdown[breakdownIndex].days[day] = status; // 'boarded', 'absent', 'notmarked'
        }
        
        record.markModified('breakdown');
        await record.save({ session });
        await session.commitTransaction();
        
        return { success: true, updatedDays: record.breakdown[breakdownIndex].days };
    } catch (error) {
        await session.abortTransaction();
        console.error("❌ Error in processTransportJob:", error);
        throw error;
    } finally {
        session.endSession();
    }
};

exports.markTransport = async (req, res) => {
    const { student, termId, academicYear, week, day, date, status, routeSnapshot, stopSnapshot } = req.body;

    if (!student || !termId || !week || !day || !status) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    try {
        // Run synchronously to ensure instant updates on the Admin Dashboard without background worker delays
        await exports.processTransportJob({
            student, termId, academicYear, week, day, status, routeSnapshot, stopSnapshot,
            reqUser: { 
                school: req.user.school, 
                _id: req.user._id 
            }
        });

        // Sync with TransportAttendance for backward compatibility with Daily Attendance reports
        if (date) {
            const updateObj = {
                student,
                school: req.user.school,
                term: termId,
                academicYear: academicYear || '',
                date,
                routeSnapshot: routeSnapshot || 'Unknown',
                stopSnapshot: stopSnapshot || 'Unknown',
                markedBy: req.user._id
            };
            
            if (status === 'boarded' || status === 'picked') {
                updateObj.picked = true;
                updateObj.pickedAt = new Date();
                updateObj.isAbsent = false;
                updateObj.dropped = false;
            } else if (status === 'dropped') {
                updateObj.dropped = true;
                updateObj.droppedAt = new Date();
                updateObj.isAbsent = false;
            } else if (status === 'absent') {
                updateObj.isAbsent = true;
                updateObj.picked = false;
                updateObj.dropped = false;
            } else if (status === 'notmarked') {
                updateObj.picked = false;
                updateObj.dropped = false;
                updateObj.isAbsent = false;
            }

            await TransportAttendance.findOneAndUpdate(
                { student, date, school: req.user.school },
                { $set: updateObj },
                { upsert: true, new: true }
            );
        }

        res.status(200).json({ success: true, message: 'Transport attendance processed successfully' });
    } catch (error) {
        console.error('Error queuing transport attendance:', error);
        res.status(500).json({ success: false, message: 'Server error enqueueing transport attendance' });
    }
};

exports.getTransportFeeRecords = async (req, res) => {
    try {
        const { termId, week } = req.query;
        let query = { school: req.user.school, termId };
        
        // If week is provided correctly (not NaN or undefined string), enforce week constraint
        if (week && week !== 'NaN' && week !== 'undefined') {
            query.week = normalizeWeekNumber(week);
        }
        
        // Sort by updatedAt descending so the freshest duplicate document takes absolute precedence
        const records = await TransportFeeRecord.find(query).sort({ updatedAt: -1 });

        // Use the same response shape as FeedingFee
        res.status(200).json({ 
          success: true, 
          data: records 
        });
    } catch (error) {
        console.error('Error fetching transport fee records:', error);
        res.status(500).json({ success: false, message: 'Server error fetching transport records' });
    }
};

/* --------------------------------------------------------------------
 * 🔍 Get Transport Debtors For Date
 * -------------------------------------------------------------------- */
exports.getTransportDebtorsForWeek = async (req, res) => {
    try {
        const { termId, week, activeDayKey, dateStr } = req.query;
        if (!termId || !week || !activeDayKey || !dateStr) {
            return res.status(400).json({ success: false, message: "Missing required parameters" });
        }

        const schoolId = req.user.school;
        const weekNumber = parseInt(String(week).replace(/Week\s*/i, ""), 10) || Number(week);
        const weekLabel = `Week ${weekNumber}`;
        const targetDate = parseDateOnly(dateStr);
        if (!targetDate) {
            return res.status(400).json({ success: false, message: "Invalid dateStr" });
        }

        const records = await TransportFeeRecord.find({
            school: schoolId,
            termId,
            week: weekNumber
        })
        .populate('breakdown.student', 'guardianName guardianPhone')
        .lean();

        const paymentMap = await getCoveredTransportPaymentMap({
            schoolId,
            termId,
            weekLabel,
            targetDate,
        });
        const paidStudentIds = new Set(paymentMap.keys());

        const debtors = [];

        for (const record of records) {
            if (!record.breakdown) continue;
            
            for (const entry of record.breakdown) {
                const status = entry.days?.[activeDayKey];
                // Check if they boarded
                if (status === 'boarded' || status === 'dropped') {
                    const studentObj = entry.student || {};
                    const studentIdId = studentObj._id?.toString() || studentObj?.toString();

                    if (studentIdId && !paidStudentIds.has(studentIdId)) {
                        debtors.push({
                            studentId: studentIdId,
                            studentName: entry.studentName,
                            className: entry.className,
                            week: record.week,
                            guardianName: studentObj.guardianName || '',
                            guardianPhone: studentObj.guardianPhone || ''
                        });
                    }
                }
            }
        }

        return res.json({
            success: true,
            count: debtors.length,
            debtors
        });

    } catch (error) {
        console.error("Error fetching transport debtors:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch transport debtors" });
    }
};

/* --------------------------------------------------------------------
 * 📋 Get Transport Audit Report
 * -------------------------------------------------------------------- */
exports.getTransportAuditReport = async (req, res) => {
    try {
        const { termId, week, activeDayKey, dateStr } = req.query;
        if (!termId || !week || !activeDayKey || !dateStr) {
            return res.status(400).json({ success: false, message: "Missing required parameters" });
        }

        const schoolId = req.user.school;
        const weekNumber = parseInt(String(week).replace(/Week\s*/i, ""), 10) || Number(week);
        const weekLabel = `Week ${weekNumber}`;
        const targetDate = parseDateOnly(dateStr);
        if (!targetDate) {
            return res.status(400).json({ success: false, message: "Invalid dateStr" });
        }

        const records = await TransportFeeRecord.find({
            school: schoolId,
            termId,
            week: weekNumber
        })
        .populate('breakdown.student', 'guardianName guardianPhone')
        .lean();

        const paymentMap = await getCoveredTransportPaymentMap({
            schoolId,
            termId,
            weekLabel,
            targetDate,
        });

        const classMap = new Map();
        let grandTotal = 0;
        let totalPaid = 0;
        let totalUnpaid = 0;

        for (const record of records) {
            if (!record.breakdown || record.breakdown.length === 0) continue;

            for (const entry of record.breakdown) {
                const status = entry.days?.[activeDayKey];
                // Only include boarded students in the audit report
                if (status === 'boarded' || status === 'dropped') {
                    const studentObj = entry.student || {};
                    const sid = studentObj._id?.toString() || studentObj?.toString();
                    
                    if (!sid) continue;

                    const paymentDetails = paymentMap.get(sid);
                    const isPaid = Boolean(paymentDetails);
                    const amount = isPaid ? paymentDetails.amount : 0;
                    
                    if (isPaid) {
                        totalPaid++;
                        grandTotal += amount;
                    } else {
                        totalUnpaid++;
                    }

                    const className = entry.className || 'Unknown Class';
                    if (!classMap.has(className)) {
                        classMap.set(className, {
                            className,
                            totalAmount: 0,
                            paidCount: 0,
                            unpaidCount: 0,
                            students: []
                        });
                    }

                    const classGroup = classMap.get(className);
                    classGroup.students.push({
                        studentId: sid,
                        studentName: entry.studentName,
                        status: isPaid ? 'present' : 'absent',
                        isPaid,
                        amount,
                        paymentDate: paymentDetails?.date || null,
                        guardianName: studentObj.guardianName || '',
                        guardianPhone: studentObj.guardianPhone || ''
                    });

                    if (isPaid) {
                        classGroup.paidCount++;
                        classGroup.totalAmount += amount;
                    } else {
                        classGroup.unpaidCount++;
                    }
                }
            }
        }

        const auditReport = Array.from(classMap.values());

        for (const clsReport of auditReport) {
            clsReport.students.sort((a, b) => {
                if (!a.studentName) return 1;
                if (!b.studentName) return -1;
                return a.studentName.localeCompare(b.studentName);
            });
        }

        auditReport.sort((a, b) => a.className.localeCompare(b.className));

        return res.json({
            success: true,
            day: activeDayKey,
            week: weekNumber,
            dateStr,
            grandTotal,
            totalPaid,
            totalUnpaid,
            report: auditReport
        });

    } catch (error) {
        console.error("Error fetching transport audit report:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch transport audit report" });
    }
};
