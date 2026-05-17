const { jsPDF } = require('jspdf');
require('jspdf-autotable');
const axios = require('axios');
const Payroll = require('../models/Payroll');
const SchoolInfo = require('../models/SchoolInfo');
const Teacher = require('../models/Teacher');
const path = require('path');
const fs = require('fs');

exports.downloadPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const { teacherId } = req.query;

    const payroll = await Payroll.findOne({ _id: id, school: req.user.school }).populate('school');
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll batch not found' });
    }

    // Determine which slips to print
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
          // If relative path like /uploads/logo.png, we must load from disk
          const filePath = path.join(__dirname, '..', schoolInfo.logo);
          if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath);
            logoBase64 = `data:image/png;base64,${fileData.toString('base64')}`;
          }
        }
      } catch (err) {
        console.error("Logo fetch failed", err);
      }
    }

    // Since we don't have Canvas in Node easily, we skip the grayscale canvas conversion.
    // jspdf's doc.setGState({ opacity: 0.10 }) will naturally make the watermark faint anyway.
    const grayLogoBase64 = logoBase64;

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

      doc.autoTable({
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

      doc.autoTable({
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

      doc.autoTable({
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
      doc.text('Page 1 of 1', doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 10, { align: 'center' });
    });

    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    const fileName = slipsToPrint.length === 1
      ? `Payslip_${slipsToPrint[0].teacherName}_${payroll.month}.pdf`
      : `Payslips_Batch_${payroll.month}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
};
