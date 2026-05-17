const PayrollSettings = require('../models/PayrollSettings');
const TeacherSalary = require('../models/TeacherSalary');
const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const Attendance = require('../models/TeacherAttendance'); // existing model
const SchoolInfo = require('../models/SchoolInfo');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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
    if (teacherId) {
      slipsToPrint = payroll.payslips.filter(s => String(s.teacher) === String(teacherId));
    } else if (req.user.role === 'teacher') {
      const teacher = await Teacher.findOne({ user: req.user._id });
      if (!teacher) return res.status(404).json({ success: false, message: 'Teacher record not found' });
      slipsToPrint = payroll.payslips.filter(s => String(s.teacher) === String(teacher._id));
    }

    if (slipsToPrint.length === 0) {
      return res.status(404).json({ success: false, message: 'No payslips found to print' });
    }

    const schoolInfo = await SchoolInfo.findOne({ school: req.user.school });
    
    let logoBase64 = null;
    if (schoolInfo && schoolInfo.logo) {
      try {
        const isAbsolute = schoolInfo.logo.startsWith('http');
        if (isAbsolute) {
          const response = await axios.get(schoolInfo.logo, { responseType: 'arraybuffer' });
          logoBase64 = `data:image/png;base64,${Buffer.from(response.data, 'binary').toString('base64')}`;
        } else {
          const filePath = path.join(__dirname, '..', schoolInfo.logo);
          if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath);
            const ext = path.extname(schoolInfo.logo).toLowerCase().replace('.', '') || 'png';
            logoBase64 = `data:image/${ext};base64,${fileData.toString('base64')}`;
          }
        }
      } catch (err) {
        console.error("Logo fetch failed", err);
      }
    }

    const doc = new jsPDF({ orientation: 'landscape', format: 'a5' });

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

      if (logoBase64) {
        doc.setGState(new doc.GState({ opacity: 0.10 }));
        doc.addImage(logoBase64, 'PNG', doc.internal.pageSize.width / 2 - 42.5, doc.internal.pageSize.height / 2 - 42.5, 85, 85);
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
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.5, lineWidth: 0.3, lineColor: 0, textColor: 0, fillColor: false },
        columnStyles: {
          0: { cellWidth: 35, halign: 'center', valign: 'bottom', fontStyle: 'bold' },
          1: { cellWidth: 20, fontStyle: 'bold' },
          2: { cellWidth: 50, fontStyle: 'normal' },
          3: { cellWidth: 20, fontStyle: 'bold' },
          4: { cellWidth: 'auto', fontStyle: 'normal' }
        },
        body: [
          [{ content: logoBase64 ? '\n\n\n\n' + activeSchoolName : '[ Logo ]\n\n' + activeSchoolName, rowSpan: 3, styles: { fontStyle: 'bold', halign: 'center', valign: 'bottom', cellPadding: { bottom: 2 } } }, 'DATE', displayDate, 'SCHOOL', (payroll.school && payroll.school.name) ? payroll.school.name : 'N/A'],
          ['PERIOD', displayPeriod, 'DATE OF BIRTH', formatDOB(dobToUse)],
          ['NAME', slip.teacherName, '', '']
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
        headStyles: { font: 'helvetica', textColor: 0, fontStyle: 'bold', lineWidth: 0.3, lineColor: 0, fontSize: 8, fillColor: false },
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, lineWidth: 0.3, lineColor: 0, textColor: 0, fillColor: false },
        columnStyles: { 6: { halign: 'right' }, 7: { halign: 'right' } },
        head: [['MONTH/YEAR', 'NATURE', 'LEVEL', 'DESCRIPTION', 'HRS/ORIGINAL AMOUNT', 'RATE(%) BALANCE', 'PAYMENTS', 'DEDUCTIONS']],
        body: tableRows,
        willDrawCell: function (data) {
          if (data.section === 'body' && data.row.index !== tableRows.length - 1)
            data.cell.styles.lineWidth = { top: 0, bottom: 0, left: 0.3, right: 0.3 };
        }
      });

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY, margin: { left: 14, right: 14 }, theme: 'grid',
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.5, lineWidth: 0.3, lineColor: 0, textColor: 0, fillColor: false },
        columnStyles: {
          0: { cellWidth: 30, fontStyle: 'bold' }, 1: { cellWidth: 20, halign: 'right' }, 2: { cellWidth: 30, fontStyle: 'bold' },
          3: { cellWidth: 18, halign: 'right' }, 4: { cellWidth: 25, fontStyle: 'bold' }, 5: { cellWidth: 15, halign: 'right' },
          6: { cellWidth: 24, halign: 'center', fontStyle: 'bold' }, 7: { cellWidth: 'auto', halign: 'right', fontStyle: 'bold' }
        },
        body: [
          ['ANNUAL SALARY', (slip.annualSalary || 0).toFixed(2), 'YTD SSF (WORKER)', '0.00', { content: 'EMPLOYER S.S.F.', colSpan: 2 }, { content: 'PAYMENT MODE', styles: { halign: 'center' } }, { content: 'NET SALARY', styles: { halign: 'center' } }],
          ['YTD GROSS PAY', (slip.ytdGross || 0).toFixed(2), 'YTD INCOME TAX', '0.00', 'MONTHLY', '0.00', { content: 'Cash', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } }, { content: (slip.netSalary || 0).toFixed(2), rowSpan: 2, styles: { valign: 'middle', halign: 'right', fontSize: 10 } }],
          ['MONTHLY GROSS PAY', (slip.grossSalary || 0).toFixed(2), 'PAGE', '1', 'YTD', '0.00']
        ]
      });
      doc.setFontSize(8);
      doc.text(`Page 1 of 1`, doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 10, { align: 'center' });
    });

    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    const fileName = slipsToPrint.length === 1
      ? `Payslip_${slipsToPrint[0].teacherName}_${payroll.month}.pdf`
      : `Payslips_Batch_${payroll.month}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
};
