const PayrollSettings = require('../models/PayrollSettings');
const TeacherSalary = require('../models/TeacherSalary');
const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const Attendance = require('../models/TeacherAttendance'); // existing model
const SchoolInfo = require('../models/SchoolInfo');

// PayrollSettings CRUD
exports.getSettings = async (req, res) => {
  try {
    let settings = await PayrollSettings.findOne({ school: req.user.school });
    
    const defaultComponents = [
      { name: 'Basic Salary', type: 'earning', isDefault: true, active: true },
      { name: 'Transport Allowance', type: 'earning', isDefault: false, active: true },
      { name: 'SSNIT', type: 'deduction', isDefault: true, active: true }
    ];

    if (!settings) {
      settings = await PayrollSettings.create({ 
        school: req.user.school,
        components: defaultComponents
      });
    } else {
      // Auto-inject SSNIT into existing settings if not present
      const hasSSNIT = settings.components.some(c => c.name.toUpperCase() === 'SSNIT');
      if (!hasSSNIT) {
        settings.components.push({ name: 'SSNIT', type: 'deduction', isDefault: true, active: true });
        await settings.save();
      }
    }
    
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { components, attendancePenalties } = req.body;
    const settings = await PayrollSettings.findOneAndUpdate(
      { school: req.user.school },
      { components, attendancePenalties },
      { new: true, upsert: true }
    );
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// TeacherSalary Management
exports.getTeacherSalaries = async (req, res) => {
  try {
    const teachers = await Teacher.find({ school: req.user.school }).populate('user', 'name email phone');
    const salaries = await TeacherSalary.find({ school: req.user.school });
    
    const combined = teachers.map(t => {
      const existing = salaries.find(s => String(s.teacher) === String(t._id));
      if (existing) return { ...existing.toObject(), teacher: t };
      return { teacher: t, baseSalary: 0, allowances: [], deductions: [], accountDetails: {} };
    });

    res.json({ success: true, salaries: combined });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateTeacherSalary = async (req, res) => {
  try {
    const { teacherId, baseSalary, allowances, deductions, accountDetails } = req.body;
    
    // Sanitize: "Basic Salary" must never be stored inside the allowances array
    const sanitizedAllowances = allowances ? allowances.filter(a => a.name.toLowerCase() !== 'basic salary') : [];

    const salary = await TeacherSalary.findOneAndUpdate(
      { school: req.user.school, teacher: teacherId },
      { baseSalary, allowances: sanitizedAllowances, deductions, accountDetails },
      { new: true, upsert: true }
    );
    res.json({ success: true, salary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Payroll Processing
exports.generatePayroll = async (req, res) => {
  try {
    const { month, year } = req.body;
    const period = `${year}-${String(month).padStart(2, '0')}`; // e.g. "2026-05"
    
    const existing = await Payroll.findOne({ school: req.user.school, month: period });
    if (existing && existing.status !== 'Draft') {
      return res.status(400).json({ success: false, message: 'Payroll for this month is already approved or paid.' });
    }

    // Calculate YTD Gross accumulated from previous months in the same year
    const payrollYear = period.substring(0, 4);
    const previousPayrollsThisYear = await Payroll.find({
      school: req.user.school,
      month: { $regex: `^${payrollYear}-`, $lt: period } // Earlier months in the same year
    });
    
    const ytdGrossMap = {};
    previousPayrollsThisYear.forEach(p => {
       p.payslips.forEach(slip => {
          const tid = String(slip.teacher);
          if (!ytdGrossMap[tid]) ytdGrossMap[tid] = 0;
          ytdGrossMap[tid] += (slip.grossSalary || 0);
       });
    });

    const settings = await PayrollSettings.findOne({ school: req.user.school });
    const salaries = await TeacherSalary.find({ school: req.user.school }).populate({
        path: 'teacher',
        populate: { path: 'user' }
    });
    
    // Fetch school to get the name for the payslip snapshots
    const schoolDoc = await require('../models/School').findById(req.user.school);
    const schoolName = schoolDoc ? schoolDoc.name : 'Unknown School';

    // We need start and end of month for attendance query
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const attendances = await Attendance.find({
      school: req.user.school,
      date: { $gte: startDate, $lte: endDate }
    });

    const payslips = [];
    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    for (const salary of salaries) {
      if (!salary.teacher || !salary.teacher.user) continue;

      const teacherAtt = attendances.filter(a => String(a.teacher) === String(salary.teacher._id));
      const absentCount = teacherAtt.filter(a => a.status === 'Absent').length;
      const lateCount = teacherAtt.filter(a => a.status === 'Late').length;
      const presentCount = teacherAtt.filter(a => a.status === 'Present' || a.status === 'On Time').length;

      let grossSalary = Number(salary.baseSalary) || 0;
      const earnings = [...(salary.allowances || [])];
      let tDeductions = 0;
      const deductions = [...(salary.deductions || [])];

      // Add earnings
      earnings.forEach(e => grossSalary += Number(e.amount || 0));

      // Fixed deductions
      deductions.forEach(d => tDeductions += Number(d.amount || 0));

      // Attendance penalties
      if (settings?.attendancePenalties?.absentPenaltyAmount && absentCount > 0) {
        const amt = settings.attendancePenalties.absentPenaltyAmount * absentCount;
        deductions.push({ name: `Absent Penalty (${absentCount} days)`, amount: amt, isAttendancePenalty: true });
        tDeductions += amt;
      }
      if (settings?.attendancePenalties?.latePenaltyAmount && lateCount > 0) {
        const amt = settings.attendancePenalties.latePenaltyAmount * lateCount;
        deductions.push({ name: `Late Penalty (${lateCount} days)`, amount: amt, isAttendancePenalty: true });
        tDeductions += amt;
      }

      const netSalary = grossSalary - tDeductions;
      const annualSalary = grossSalary * 12;
      const pastYTD = ytdGrossMap[String(salary.teacher._id)] || 0;
      const ytdGross = pastYTD + grossSalary;

      totalGross += grossSalary;
      totalDeductions += tDeductions;
      totalNet += netSalary;

      payslips.push({
        teacher: salary.teacher._id,
        teacherName: salary.teacher.user.name,
        schoolName: schoolName,
        teacherLevel: salary.teacher.rank || 'N/A',
        teacherDateOfBirth: salary.teacher.dateOfBirth,
        employeeId: salary.teacher.employeeId || 'N/A',
        baseSalary: salary.baseSalary,
        earnings,
        deductions,
        attendanceData: {
          present: presentCount,
          absent: absentCount,
          late: lateCount,
          totalWorkingDays: teacherAtt.length
        },
        grossSalary,
        annualSalary,
        ytdGross,
        totalDeductions: tDeductions,
        netSalary,
        accountDetails: salary.accountDetails,
        referenceNumber: `PAY-${period}-${String(salary.teacher._id).slice(-4).toUpperCase()}`
      });
    }

    let payroll;
    if (existing) {
       payroll = await Payroll.findByIdAndUpdate(existing._id, {
          payslips, totalGross, totalDeductions, totalNet, generatedBy: req.user._id
       }, { new: true });
    } else {
       payroll = await Payroll.create({
          school: req.user.school,
          month: period,
          status: 'Draft',
          payslips,
          totalGross,
          totalDeductions,
          totalNet,
          generatedBy: req.user._id
       });
    }

    res.json({ success: true, payroll });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPayrollHistory = async (req, res) => {
  try {
    const payrolls = await Payroll.find({ school: req.user.school }).sort({ month: -1 }).populate('generatedBy approvedBy', 'name');
    res.json({ success: true, payrolls });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPayrollDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const payroll = await Payroll.findOne({ _id: id, school: req.user.school })
      .populate('generatedBy approvedBy', 'name')
      .populate('school', 'name')
      .populate({ path: 'payslips.teacher', select: 'dateOfBirth' });
    if (!payroll) return res.status(404).json({ success: false, message: 'Payroll not found' });
    
    const schoolInfo = await SchoolInfo.findOne({ school: req.user.school });
    
    res.json({ success: true, payroll, schoolInfo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updatePayrollStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const updateData = { status };
    if (status === 'Approved') {
        updateData.approvedBy = req.user._id;
        updateData.approvedAt = new Date();
    } else if (status === 'Paid') {
        updateData.paidAt = new Date();
    }

    const payroll = await Payroll.findOneAndUpdate(
       { _id: id, school: req.user.school },
       updateData,
       { new: true }
    );
    res.json({ success: true, payroll });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// For Teacher Portal
exports.getMyPayslips = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({ user: req.user._id });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher record not found' });

    const payrolls = await Payroll.find({ 
       school: req.user.school, 
       status: { $in: ['Approved', 'Paid'] },
       'payslips.teacher': teacher._id 
    }).populate('school').sort({ month: -1 });

    const myPayslips = payrolls.map(p => {
       const slip = p.payslips.find(s => String(s.teacher) === String(teacher._id));
       return {
          month: p.month,
          status: p.status,
          paidAt: p.paidAt,
          schoolLogo: p.school?.logo || '',
          ...slip.toObject()
       };
    });

    res.json({ success: true, payslips: myPayslips });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
