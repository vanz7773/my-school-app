const PayrollStaff = require('../models/PayrollStaff');
const { notifyPaidPayroll, notificationSummary } = require('../services/payrollNotifications');
const PayrollSettings = require('../models/PayrollSettings');
const TeacherSalary = require('../models/TeacherSalary');
const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const Attendance = require('../models/TeacherAttendance'); // existing model
const SchoolInfo = require('../models/SchoolInfo');
const { getPayslipLogo } = require('../services/payslipLogo');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;

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

    const staff = await PayrollStaff.find({ school: req.user.school });
    for (const employee of staff) {
      const salary = salaries.find(s => String(s.teacher) === String(employee._id));
      combined.push({ ...(salary ? salary.toObject() : { baseSalary: 0, allowances: [], deductions: [], accountDetails: {} }),
        employeeModel: 'PayrollStaff', teacher: { ...employee.toObject(), user: { name: employee.name, phone: employee.phone } } });
    }
    res.json({ success: true, salaries: combined });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateTeacherSalary = async (req, res) => {
  try {
    const { teacherId, baseSalary, allowances, deductions, accountDetails } = req.body;
    
    const employeeModel = req.body.employeeModel === 'PayrollStaff' ? 'PayrollStaff' : 'Teacher';
    const Employee = employeeModel === 'PayrollStaff' ? PayrollStaff : Teacher;
    if (!require('mongoose').isValidObjectId(teacherId)) return res.status(400).json({ message: 'Invalid employee ID' });
    const employee = await Employee.findOne({ _id: teacherId, school: req.user.school });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    if (!Number.isFinite(Number(baseSalary)) || Number(baseSalary) < 0 ||
        ![allowances || [], deductions || []].every(list => Array.isArray(list) && list.every(c => c && typeof c.name === 'string' && Number.isFinite(Number(c.amount)) && Number(c.amount) >= 0))) {
      return res.status(400).json({ message: 'Salary amounts must be valid non-negative numbers' });
    }
    // Accept the same local/international phone formats used for SMS delivery.
    let contactPhone;
    if (req.body.contactPhone !== undefined) {
      if (typeof req.body.contactPhone !== 'string') return res.status(400).json({ message: 'Enter a valid Ghana phone number' });
      const enteredPhone = req.body.contactPhone.trim();
      contactPhone = enteredPhone.replace(/[\s()+.\-]/g, '');
      if (contactPhone.startsWith('00')) contactPhone = contactPhone.slice(2);
      if (/^0\d{9}$/.test(contactPhone)) contactPhone = `233${contactPhone.slice(1)}`;
      else if (/^\d{9}$/.test(contactPhone)) contactPhone = `233${contactPhone}`;
      if (enteredPhone && !/^233(?:20|23|24|25|26|27|28|29|50|53|54|55|56|57|59)\d{7}$/.test(contactPhone)) {
        return res.status(400).json({ message: 'Enter a valid Ghana mobile number, e.g. 0241234567 or +233241234567' });
      }
    }
    // Sanitize: "Basic Salary" must never be stored inside the allowances array
    const sanitizedAllowances = allowances ? allowances.filter(a => a.name.trim().toLowerCase() !== 'basic salary').map(a => ({ name: a.name.trim(), amount: Number(a.amount) })) : [];

    const filter = { school: req.user.school, teacher: teacherId };
    const update = { baseSalary: Number(baseSalary), allowances: sanitizedAllowances, deductions: (deductions || []).map(d => ({ name: d.name.trim(), amount: Number(d.amount) })), accountDetails, employeeModel, ...(contactPhone !== undefined ? { contactPhone } : {}) };
    let salary;
    try {
      salary = await TeacherSalary.findOneAndUpdate(filter, update, { new: true, upsert: true, runValidators: true });
    } catch (error) {
      // Two initial saves can race to insert the same employee. Update the winning record.
      if (error.code !== 11000 || !error.keyPattern?.teacher) throw error;
      salary = await TeacherSalary.findOneAndUpdate(filter, update, { new: true, runValidators: true });
      if (!salary) throw error;
    }
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
    const salaries = await TeacherSalary.find({ school: req.user.school }).populate('teacher');
    await Teacher.populate(salaries.filter(s => s.employeeModel !== 'PayrollStaff').map(s => s.teacher).filter(Boolean), { path: 'user' });
    
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
      if (!salary.teacher) continue;
      const isStaff = salary.employeeModel === 'PayrollStaff';
      if (!isStaff && !salary.teacher.user) continue;

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
        teacherName: isStaff ? salary.teacher.name : salary.teacher.user.name,
        employeeModel: salary.employeeModel || 'Teacher',
        contactPhone: salary.contactPhone || salary.teacher.phone || salary.teacher.user?.phone,
        schoolName: schoolName,
        teacherLevel: salary.teacher.jobTitle || salary.teacher.rank || 'N/A',
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

    if (!['Approved', 'Paid'].includes(status)) return res.status(400).json({ message: 'Invalid payroll status' });
    const previousStatus = status === 'Approved' ? 'Draft' : 'Approved';
    const updateData = { status };
    if (status === 'Approved') {
        updateData.approvedBy = req.user._id;
        updateData.approvedAt = new Date();
    } else if (status === 'Paid') {
        updateData.paidAt = new Date();
        updateData.paidBy = req.user._id;
    }

    let payroll = await Payroll.findOneAndUpdate(
       { _id: id, school: req.user.school, status: previousStatus },
       updateData,
       { new: true }
    );
    // A repeated payment request retries only pending notifications and preserves the original payment date.
    if (!payroll && status === 'Paid') payroll = await Payroll.findOne({ _id: id, school: req.user.school, status: 'Paid' });
    if (!payroll) return res.status(409).json({ message: 'Payroll not found or status has already changed' });
    if (status === 'Paid') {
      try {
        const notifications = await notifyPaidPayroll(payroll);
        return res.json({ success: true, payroll, notifications, message: `Payroll marked as Paid. ${notificationSummary(notifications)}` });
      } catch (error) {
        console.error('Paid payroll notification processing failed:', error.message);
        return res.json({ success: true, payroll, notificationsError: true, message: 'Payroll is Paid, but notification processing failed. Use Retry Payment Notifications.' });
      }
    }
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

    const schoolInfo = await SchoolInfo.findOne({ school: req.user.school });

    const payrolls = await Payroll.find({ 
       school: req.user.school, 
       status: { $in: ['Approved', 'Paid'] },
       'payslips.teacher': teacher._id 
    }).sort({ month: -1 });

    const myPayslips = payrolls.map(p => {
       const slip = p.payslips.find(s => String(s.teacher) === String(teacher._id));
       return {
          payrollId: p._id,
          month: p.month,
          status: p.status,
          paidAt: p.paidAt,
          schoolLogo: schoolInfo?.logo || '',
          ...slip.toObject()
       };
    });

    res.json({ success: true, payslips: myPayslips });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.downloadPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const { teacherId } = req.query;

    const payroll = await Payroll.findOne({ _id: id, school: req.user.school }).populate('school');
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll batch not found' });
    }

    let slipsToPrint = payroll.payslips;
    if (req.user.role === 'teacher') {
      const teacher = await Teacher.findOne({ user: req.user._id, school: req.user.school });
      if (!teacher) return res.status(404).json({ success: false, message: 'Teacher record not found' });
      if (teacherId && String(teacherId) !== String(teacher._id)) return res.status(403).json({ message: 'You can only download your own payslip' });
      if (!['Approved', 'Paid'].includes(payroll.status)) return res.status(403).json({ message: 'Payslip is not available yet' });
      slipsToPrint = payroll.payslips.filter(s => String(s.teacher) === String(teacher._id));
    } else if (['admin', 'superadmin'].includes(req.user.role)) {
      if (teacherId) slipsToPrint = payroll.payslips.filter(s => String(s.teacher) === String(teacherId));
    } else {
      return res.status(403).json({ message: 'You do not have access to payslips' });
    }

    if (slipsToPrint.length === 0) {
      return res.status(404).json({ success: false, message: 'No payslips found to print' });
    }

    const schoolInfo = await SchoolInfo.findOne({ school: req.user.school });
    
    const { logoBase64, grayLogoBase64 } = await getPayslipLogo(schoolInfo, req.user.school);
    const doc = new jsPDF({ orientation: 'landscape', format: 'a5', compress: true });
    // All sections share the same eight-column grid (182 mm inside 14 mm margins).
    const columnWidths = [26, 18, 18, 38, 20, 20, 21, 21];
    const gridColumns = Object.fromEntries(columnWidths.map((cellWidth, index) => [index, { cellWidth }]));

    const [yyyy, mm] = payroll.month.split('-');
    const yearNum = parseInt(yyyy, 10);
    const monthIndex = parseInt(mm, 10) - 1;
    const lastDay = new Date(yearNum, monthIndex + 1, 0).getDate();
    const yy = yyyy.slice(-2);
    const shortMonth = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthIndex];
    const longMonth = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][monthIndex];
    
    const displayDate = `${longMonth} ${yearNum}`;
    const displayPeriod = `FROM 01-${shortMonth}-${yy} TO ${lastDay}-${shortMonth}-${yy}`;
    const displayMonthYear = `${lastDay}-${shortMonth}-${yy}`;

    const formatDOB = dobStr => {
      if (!dobStr) return 'N/A';
      const d = new Date(dobStr);
      if (isNaN(d.getTime())) return 'N/A';
      return `${String(d.getDate()).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    };

    slipsToPrint.forEach((slip, index) => {
      if (index > 0) doc.addPage('a5', 'landscape');
      
      const dobToUse = slip.teacherDateOfBirth || null;
      const activeSchoolName = (payroll.school && payroll.school.name) ? payroll.school.name.toUpperCase() : 'YOUR SCHOOL NAME';

      if (grayLogoBase64) {
        doc.setGState(new doc.GState({ opacity: 0.10 }));
        doc.addImage(grayLogoBase64, 'PNG', doc.internal.pageSize.width / 2 - 42.5, doc.internal.pageSize.height / 2 - 42.5, 85, 85);
        doc.setGState(new doc.GState({ opacity: 1 }));
      }

      doc.setTextColor(230, 230, 230);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(50);
      const textWidth = doc.getTextWidth(activeSchoolName);
      const optimalFontSize = 50 * (doc.internal.pageSize.width * 0.85 / textWidth);
      doc.setFontSize(optimalFontSize);
      const xPos = doc.internal.pageSize.width / 2;
      doc.text(activeSchoolName, xPos, doc.internal.pageSize.height / 2 - 5, { align: 'center' });
      doc.text("PAYSLIP", xPos, doc.internal.pageSize.height / 2 + optimalFontSize * 0.35 - 5, { align: 'center' });
      doc.setTextColor(0, 0, 0);

      autoTable(doc, {
        startY: 15, margin: { left: 14, right: 14 }, theme: 'grid',
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.5, lineWidth: 0.3, lineColor: [100, 100, 100], textColor: [60, 60, 60], fillColor: false },
        columnStyles: gridColumns,
        body: [
          [
            { content: logoBase64 ? '\n\n\n\n' + activeSchoolName : '[ Logo ]\n\n' + activeSchoolName, colSpan: 2, rowSpan: 3, styles: { fontStyle: 'bold', halign: 'center', valign: 'bottom', cellPadding: { bottom: 2 } } },
            { content: 'DATE', styles: { fontStyle: 'bold' } },
            { content: displayDate, colSpan: 2 },
            { content: 'SCHOOL', styles: { fontStyle: 'bold' } },
            { content: payroll.school?.name || 'N/A', colSpan: 2 }
          ],
          [
            { content: 'PERIOD', styles: { fontStyle: 'bold' } },
            { content: displayPeriod, colSpan: 2 },
            { content: 'DATE OF BIRTH', styles: { fontStyle: 'bold' } },
            { content: formatDOB(dobToUse), colSpan: 2 }
          ],
          [{ content: 'NAME', styles: { fontStyle: 'bold' } }, { content: slip.teacherName, colSpan: 5 }]
        ],
        didDrawCell: function (data) {
          if (data.section === 'body' && data.column.index === 0 && data.row.index === 0 && logoBase64) {
            doc.addImage(logoBase64, 'PNG', data.cell.x + data.cell.width / 2 - 5, data.cell.y + 1.5, 10, 10);
          }
        }
      });

      const tableRows = [];
      tableRows.push([displayMonthYear, '', '', 'Basic Salary', '', '', (slip.baseSalary || 0).toFixed(2), '']);
      (slip.earnings || []).forEach(e => tableRows.push([displayMonthYear, '', '', e.name, '', '', e.amount.toFixed(2), '']));
      (slip.deductions || []).forEach(d => tableRows.push([displayMonthYear, '', '', d.name, '', '', '', d.amount.toFixed(2)]));
      tableRows.push([
        { content: 'TOTALS', colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: (slip.grossSalary || 0).toFixed(2), styles: { halign: 'right', fontStyle: 'bold' } },
        { content: (slip.totalDeductions || 0).toFixed(2), styles: { halign: 'right', fontStyle: 'bold' } }
      ]);

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY, margin: { left: 14, right: 14 }, theme: 'grid',
        headStyles: { font: 'helvetica', textColor: [80, 80, 80], fontStyle: 'bold', lineWidth: 0.3, lineColor: [100, 100, 100], fontSize: 7, cellPadding: 1.5, fillColor: false },
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, lineWidth: 0.3, lineColor: [100, 100, 100], textColor: [60, 60, 60], fillColor: false },
        columnStyles: { ...gridColumns, 6: { ...gridColumns[6], halign: 'right' }, 7: { ...gridColumns[7], halign: 'right' } },
        head: [['MONTH/YEAR', 'NATURE', 'LEVEL', 'DESCRIPTION', 'HRS / ORIGINAL AMOUNT', 'RATE (%) BALANCE', 'PAYMENTS', 'DEDUCTIONS']],
        body: tableRows,
        willDrawCell: function (data) {
          if (data.section === 'body' && data.row.index !== tableRows.length - 1)
            data.cell.styles.lineWidth = { top: 0, bottom: 0, left: 0.3, right: 0.3 };
        }
      });

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY, margin: { left: 14, right: 14 }, theme: 'grid',
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.5, lineWidth: 0.3, lineColor: [100, 100, 100], textColor: [60, 60, 60], fillColor: false },
        columnStyles: {
          ...gridColumns,
          2: { ...gridColumns[2], halign: 'right' },
          4: { ...gridColumns[4], halign: 'right' },
          5: { ...gridColumns[5], halign: 'center' },
          6: { ...gridColumns[6], halign: 'center' },
          7: { ...gridColumns[7], halign: 'right', fontStyle: 'bold' }
        },
        body: [
          [
            { content: 'ANNUAL SALARY', colSpan: 2, styles: { fontStyle: 'bold' } }, (slip.annualSalary || 0).toFixed(2),
            'YTD SSF (WORKER)', '0.00', 'EMPLOYER S.S.F.',
            { content: 'PAYMENT MODE', styles: { fontStyle: 'bold', halign: 'center' } },
            { content: 'NET SALARY', styles: { halign: 'center' } }
          ],
          [
            { content: 'YTD GROSS PAY', colSpan: 2, styles: { fontStyle: 'bold' } }, (slip.ytdGross || 0).toFixed(2),
            'YTD INCOME TAX', '0.00', 'MONTHLY: 0.00',
            { content: 'Cash', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
            { content: (slip.netSalary || 0).toFixed(2), rowSpan: 2, styles: { valign: 'middle', halign: 'right', fontSize: 10 } }
          ],
          [
            { content: 'MONTHLY GROSS PAY', colSpan: 2, styles: { fontStyle: 'bold' } }, (slip.grossSalary || 0).toFixed(2),
            'PAGE', '1', 'YTD: 0.00'
          ]
        ]
      });
      doc.setFontSize(8);
      doc.text(`Page 1 of 1`, doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 10, { align: 'center' });
    });

    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    const fileName = slipsToPrint.length === 1
      ? `Payslip_${longMonth}_${yearNum}.pdf`
      : `Batch_Payslips_${longMonth}_${yearNum}.pdf`;

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
};

exports.createPayrollStaff = async (req, res) => {
  try {
    const { name, phone, jobTitle } = req.body;
    if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || !/^(?:0|\+?233)[235]\d{8}$/.test(phone.trim())) {
      return res.status(400).json({ message: 'Name and a valid Ghana phone number are required' });
    }
    const staff = await PayrollStaff.create({ school: req.user.school, name: name.trim(), phone: phone.trim(), jobTitle });
    res.status(201).json({ success: true, staff });
  } catch (err) { res.status(400).json({ message: err.message }); }
};

const sendPaymentNotifications = async (req, res, smsOnly = false) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, school: req.user.school });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });
    if (payroll.status !== 'Paid') return res.status(400).json({ message: 'Mark payroll as paid before sending payment notifications' });
    const notifications = await notifyPaidPayroll(payroll, { sms: true, push: !smsOnly, inApp: !smsOnly });
    res.json({ success: true, notifications, ...notifications.sms, message: notificationSummary(notifications) });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
exports.sendSalarySms = (req, res) => sendPaymentNotifications(req, res, true);
exports.sendPaymentNotifications = (req, res) => sendPaymentNotifications(req, res);
