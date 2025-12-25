const mongoose = require('mongoose');
const { FeeTemplate, TermBill, Parent, Payment } = require('../models/allModels');
const currency = require('currency-formatter');
const PDFDocument = require('pdfkit');
const User = require('../models/User');
const Student = require('../models/Student');

// 🟦 STEP 1 — ADD HELPER FUNCTION
const resolveClassNames = (classDoc) => {
  if (!classDoc) {
    return {
      className: 'Unassigned',
      classDisplayName: 'Unassigned',
    };
  }

  const name = classDoc.name || 'Unassigned';
  const stream = classDoc.stream || null;

  const classDisplayName =
    classDoc.displayName ||
    (stream ? `${name}${stream}` : name);

  return { className: name, classDisplayName };
};

// Enhanced utility function to transform bills with better name handling
const transformBill = (bill) => {
  const transformNumber = (value) => {
    if (!value) return 0;
    if (typeof value === 'object') {
      return value.$numberInt ? parseInt(value.$numberInt) : 
             value.$numberDouble ? parseFloat(value.$numberDouble) : 0;
    }
    return typeof value === 'number' ? value : 0;
  };

  // Enhanced student name extraction
  const getStudentName = (student) => {
    if (!student) return 'Unknown';
    if (typeof student === 'object') {
      // First try to get from populated user object
      if (student.user?.name) return student.user.name;
      // Then try direct name property
      if (student.name) return student.name;
      // Then try admission number
      if (student.admissionNumber) return student.admissionNumber;
      return 'Unknown';
    }
    return 'Unknown';
  };

  // 🟦 STEP 2 — UPDATED transformBill (SAFE MERGE)
const { className, classDisplayName } = resolveClassNames(
  bill.class || bill.student?.class
);

return {
  ...(bill._doc ? bill._doc : bill),

  items: bill.items?.map(item => ({
    ...item,
    amount: transformNumber(item.amount),
    paid: transformNumber(item.paid),
    balance: transformNumber(item.balance),
  })) || [],

  totalAmount: transformNumber(bill.totalAmount),
  totalPaid: transformNumber(bill.totalPaid),

  student: {
    ...(typeof bill.student === 'object'
      ? bill.student
      : { _id: bill.student }),
    name: getStudentName(bill.student),
  },

  // ✅ FIX: preserve original class object
  class: bill.class
    ? {
        ...bill.class,              // keep _id, stream, populated fields
        name: className,             // normalized base name
        displayName: classDisplayName, // normalized display name
      }
    : {
        name: className,
        displayName: classDisplayName,
      },
};
};
  
// Consistent currency formatting
const formatCurrency = (amount) => {
  try {
    return `₵ ${Number(amount).toFixed(2)}`;
  } catch (e) {
    return '₵ 0.00';
  }
};

module.exports = {
  // School admin creates fee structure
  async createFeeTemplate(req, res) {
    try {
      if (!req.user || !req.user.school) {
        return res.status(403).json({ 
          message: 'Unauthorized: School information missing' 
        });
      }

      const { name, items } = req.body;
      
      if (!name || !items || !Array.isArray(items)) {
        return res.status(400).json({ 
          message: 'Missing required fields: name and items array' 
        });
      }

      const template = await FeeTemplate.create({
        school: req.user.school,
        name,
        items: items.map(item => ({
          name: item.name,
          amount: item.amount,
          isMandatory: item.isMandatory !== false
        })),
        currency: 'GHS'
      });

      const io = req.app.get('io');
      io.to(req.user.school.toString()).emit('fee-template-created', template);

      res.status(201).json(template);

    } catch (error) {
      console.error('Fee template error:', error);
      res.status(500).json({ 
        message: 'Server error creating fee template',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  // Preview bills before generation
  async previewBills(req, res) {
    try {
      if (!req.user?.school) {
        return res.status(403).json({ message: 'Unauthorized' });
      }

      const { templateId, studentIds, classId } = req.body;

      if (!templateId || (!studentIds && !classId)) {
        return res.status(400).json({
          message: 'Missing templateId or studentIds/classId'
        });
      }

      const template = await FeeTemplate.findById(templateId);
      if (!template) {
        return res.status(404).json({ message: 'Fee template not found' });
      }

      let students = [];
      if (studentIds) {
        students = await Student.find({ 
          _id: { $in: studentIds },
          school: req.user.school 
        })
        .populate({
          path: 'user',
          select: 'name'
        })
        // 🟦 STEP 1 — UPDATED: Added stream and displayName
        .populate({
          path: 'class',
          select: 'name stream displayName',
          options: { lean: true }
        })
        .select('_id user class admissionNumber');
      } else if (classId) {
        students = await Student.find({ 
          class: classId,
          school: req.user.school 
        })
        .populate({
          path: 'user',
          select: 'name'
        })
        // 🟦 STEP 1 — UPDATED: Added stream and displayName
        .populate({
          path: 'class',
          select: 'name stream displayName',
          options: { lean: true }
        })
        .select('_id user class admissionNumber');
      }

      if (students.length === 0) {
        return res.status(404).json({ message: 'No students found' });
      }

      // Verify student data
      students.forEach(student => {
        if (!student.user || !student.user.name) {
          console.warn(`Student ${student._id} missing user name`);
        }
        if (!student.class || !student.class.name) {
          console.warn(`Student ${student._id} missing class name`);
        }
      });

      // 🟦 STEP 3 — UPDATED previewBills
      const previewData = students.map(student => {
        const { className, classDisplayName } = resolveClassNames(student.class);
        
        return {
          studentId: student._id,
          studentName: student.user?.name || student.admissionNumber || 'Unknown',
          className,
          classDisplayName,
          items: template.items.map(item => ({
            name: item.name,
            amount: item.amount,
            isMandatory: item.isMandatory
          })),
          totalAmount: template.items.reduce((sum, item) => sum + item.amount, 0),
          currency: template.currency
        };
      });

      res.json({
        success: true,
        templateName: template.name,
        count: previewData.length,
        preview: previewData,
        summary: {
          totalStudents: previewData.length,
          totalAmount: previewData.reduce((sum, item) => sum + item.totalAmount, 0),
          currency: template.currency
        }
      });

    } catch (error) {
      console.error('Preview error:', error);
      res.status(500).json({
        message: 'Error generating preview',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

 async generateBills(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (!req.user?.school) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const { templateId, studentIds, classId, manualBills = [], term, academicYear } = req.body;

    // Validate required fields
    if (!templateId || (!studentIds && !classId) || !term || !academicYear) {
      await session.abortTransaction();
      return res.status(400).json({
        message: 'Missing required fields: templateId, classId/studentIds, term, or academicYear'
      });
    }

    // Validate manualBills
    if (manualBills && !Array.isArray(manualBills)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'manualBills must be an array' });
    }

    // Fetch students
    let studentsList = [];
    const query = { school: req.user.school };
    if (studentIds) query._id = { $in: studentIds };
    else if (classId) query.class = classId;

    // 🟦 STEP 1 — UPDATED: Added stream and displayName
    studentsList = await Student.find(query)
      .populate({ path: 'user', select: 'name' })
      .populate({ path: 'class', select: 'name stream displayName' })
      .select('_id user class admissionNumber')
      .session(session);

    if (!studentsList.length) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'No students found' });
    }

    // Fetch template
    const template = await FeeTemplate.findOne({
      _id: templateId,
      school: req.user.school
    }).session(session);

    if (!template) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Fee template not found' });
    }

    // Validate manualBills student IDs
    if (manualBills.length > 0) {
      const invalidStudents = manualBills.filter(
        bill => !studentsList.some(s => s._id.toString() === bill.studentId.toString())
      );
      if (invalidStudents.length) {
        await session.abortTransaction();
        return res.status(400).json({
          message: `Invalid student IDs in manual bills: ${invalidStudents.map(b => b.studentId).join(', ')}`
        });
      }
    }

    // Prepare lookup maps
    const manualBillsMap = new Map();
    manualBills.forEach(bill => manualBillsMap.set(bill.studentId.toString(), bill));

    const existingBills = await TermBill.find({
      student: { $in: studentsList.map(s => s._id) },
      term,
      academicYear,
      school: req.user.school
    }).session(session);

    const existingBillsMap = new Map();
    existingBills.forEach(bill => existingBillsMap.set(bill.student.toString(), bill));

    // Process bills
    const bills = [];
    const errors = [];

    for (const student of studentsList) {
      try {
        const studentId = student._id.toString();
        const manualBill = manualBillsMap.get(studentId);
        const existingBill = existingBillsMap.get(studentId);
        let billToReturn;

        if (manualBill) {
          if (!Array.isArray(manualBill.items)) {
            errors.push(`Invalid items for student ${studentId}`);
            continue;
          }
          if (existingBill) {
            billToReturn = await TermBill.findByIdAndUpdate(
              existingBill._id,
              {
                items: manualBill.items,
                totalAmount: manualBill.totalAmount,
                totalPaid: manualBill.totalPaid,
                status: manualBill.status,
                isManualUpdate: true,
                template: templateId,
                class: student.class || null, // ✅ ensure class is stored
                term,
                academicYear
              },
              { new: true, session }
            );
          } else {
            billToReturn = await TermBill.create([{
              school: req.user.school,
              student: student._id,
              class: student.class || null, // ✅ store class
              template: templateId,
              term,
              academicYear,
              items: manualBill.items,
              totalAmount: manualBill.totalAmount,
              totalPaid: manualBill.totalPaid,
              status: manualBill.status,
              isManualUpdate: true
            }], { session });
            billToReturn = billToReturn[0];
          }
        } else if (existingBill) {
          billToReturn = existingBill;
        } else {
          const total = template.items.reduce((sum, item) => sum + item.amount, 0);
          billToReturn = await TermBill.create([{
            school: req.user.school,
            student: student._id,
            class: student.class || null, // ✅ store class
            template: templateId,
            term,
            academicYear,
            items: template.items.map(item => ({
              name: item.name,
              amount: item.amount,
              paid: 0,
              balance: item.amount
            })),
            totalAmount: total,
            totalPaid: 0,
            status: 'Unpaid',
            isManualUpdate: false
          }], { session });
          billToReturn = billToReturn[0];
        }

        // Populate bill
        const populatedBill = await TermBill.findById(billToReturn._id)
          .populate({
            path: 'student',
            populate: [
              { path: 'user', select: 'name' },
              // 🟦 STEP 1 — UPDATED: Added stream and displayName
              { path: 'class', select: 'name stream displayName' }
            ]
          })
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          .populate('class', 'name stream displayName')
          .session(session);

        const studentData = populatedBill.student || student;
        const studentName = studentData?.user?.name || studentData?.admissionNumber || 'Unknown Student';
        
        // 🟦 STEP 4 — UPDATED generateBills
        const { className, classDisplayName } = resolveClassNames(
          populatedBill.class || studentData.class
        );

        const billObj = populatedBill.toObject();

bills.push(transformBill({
  ...billObj,
  student: {
    ...billObj.student,
    name: studentName,
  },
  class: billObj.class
    ? {
        ...billObj.class,
        name: className,
        displayName: classDisplayName,
      }
    : {
        name: className,
        displayName: classDisplayName,
      }
}));


      } catch (err) {
        console.error(`Error processing student ${student._id}:`, err);
        errors.push(`Failed to process student ${student._id}: ${err.message}`);
      }
    }

    if (errors.length === 0) {
      await session.commitTransaction();
    } else {
      await session.abortTransaction();
      return res.status(207).json({
        success: true,
        count: bills.length,
        errorCount: errors.length,
        message: `Processed ${bills.length} bills with ${errors.length} errors`,
        bills: bills.map(bill => ({
          ...bill,
          formattedTotal: formatCurrency(bill.totalAmount)
        })),
        errors
      });
    }

    // Emit event
    const io = req.app.get('io');
    io.to(req.user.school.toString()).emit('bills-generated', {
      count: bills.length,
      template: template.name
    });

    res.status(201).json({
      success: true,
      count: bills.length,
      template: template.name,
      bills: bills.map(bill => ({
        ...bill,
        formattedTotal: formatCurrency(bill.totalAmount)
      }))
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Bill generation error:', error);
    res.status(500).json({
      message: 'Error generating bills',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
},

  // Parent views children's fees
  async getParentBills(req, res) {
    try {
      if (!req.user?._id) {
        return res.status(403).json({ message: 'Unauthorized' });
      }

      const parent = await Parent.findOne({ 
        user: req.user._id 
      }).populate({
        path: 'children',
        populate: [
          {
            path: 'user',
            select: 'name'
          },
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          {
            path: 'class',
            select: 'name stream displayName'
          }
        ]
      });

      if (!parent) {
        return res.status(404).json({ message: 'Parent record not found' });
      }

      const bills = await TermBill.find({
        student: { $in: parent.children },
        status: { $ne: 'Paid' }
      })
      .populate('template')
      .populate({
        path: 'student',
        populate: [
          {
            path: 'user',
            select: 'name'
          },
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          {
            path: 'class',
            select: 'name stream displayName'
          }
        ]
      })
      .lean();

      const transformedBills = bills.map(bill => {
        const transformed = transformBill(bill);
        const totalAmount = transformed.totalAmount;
        const payments = transformed.payments || [];
        const paidAmount = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        const balance = totalAmount - paidAmount;

        let paymentStatus;
        if (balance <= 0) paymentStatus = 'Paid';
        else if (paidAmount > 0) paymentStatus = 'Partial';
        else paymentStatus = 'Unpaid';

        // 🟦 STEP 5 — UPDATED getParentBills
        const { className, classDisplayName } = resolveClassNames(
          transformed.student?.class
        );

        return {
          ...transformed,
          studentName: transformed.student?.name || 'Unknown',
          className,
          classDisplayName,
          studentId: transformed.student?._id,
          totalAmount,
          paidAmount,
          balance,
          formattedTotal: formatCurrency(totalAmount),
          formattedPaid: formatCurrency(paidAmount),
          formattedBalance: formatCurrency(balance),
          paymentStatus,
          lastPayment: payments.length > 0 
            ? payments[payments.length - 1].paymentDate 
            : null
        };
      });

      res.json({
        success: true,
        data: transformedBills
      });

    } catch (error) {
      console.error('Parent bills error:', error);
      res.status(500).json({ 
        message: 'Error fetching bills',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  // Generate PDF Receipt
  async generateReceipt(req, res) {
  try {
    const { paymentId } = req.params;

    // Get school info with better error handling
    const schoolInfo = await require('../models/SchoolInfo')
      .findOne({ school: req.user.school })
      .populate('school', 'name')
      .lean();

    if (!schoolInfo) {
      return res.status(404).json({ message: 'School information not found' });
    }

    // Get payment with all necessary relations
    const payment = await Payment.findById(paymentId)
      .populate({
        path: 'bill',
        populate: [
          { 
            path: 'template', 
            select: 'name' 
          },
          { 
            path: 'student',
            populate: [
              { path: 'user', select: 'name' },
              // 🟦 STEP 1 — UPDATED: Added stream and displayName
              { path: 'class', select: 'name stream displayName' }
            ]
          }
        ]
      });

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Transform bill and ensure amount is included
    const transformedBill = transformBill(payment.bill);
    if (!transformedBill.balance && payment.amount) {
      transformedBill.balance = transformedBill.totalAmount - (transformedBill.totalPaid || 0);
    }

    // Create PDF document
    const doc = new PDFDocument();
    
    // School header
    if (schoolInfo.logo) {
      try {
        doc.image(schoolInfo.logo, 250, 30, { width: 60 });
      } catch (e) {
        console.error('Could not load logo:', e);
      }
    }
    doc.moveDown(1)
       .fontSize(18)
       .text(schoolInfo.school?.name || 'School Name', { align: 'center' })
       .moveDown(0.3);

    // Payment details section
    doc.fontSize(14)
       .text('OFFICIAL PAYMENT RECEIPT', { 
         align: 'center', 
         underline: true 
       })
       .moveDown(1);

    // Student information
    // 🟦 STEP 7 — UPDATED generateReceipt
    const { classDisplayName: receiptClassDisplay } = resolveClassNames(
      transformedBill.student.class
    );
    
    doc.fontSize(12)
       .text(`Student: ${transformedBill.student.name}`, { continued: true })
       .text(`Class: ${receiptClassDisplay || 'N/A'}`, { align: 'right' })
       .moveDown(1);

    // Payment summary
    const col1 = 50;
    const col2 = 300;
    
    doc.fontSize(12)
       .text('Receipt No:', col1).text(payment._id.toString(), col2).moveDown(0.5)
       .text('Date:', col1).text(payment.createdAt.toLocaleDateString(), col2).moveDown(0.5)
       .text('Amount Paid:', col1).text(formatCurrency(payment.amount), col2).moveDown(0.5)
       .text('Balance:', col1).text(formatCurrency(transformedBill.balance), col2)
       .moveDown(1.5);

    // Fee breakdown
    if (transformedBill.items?.length > 0) {
      doc.fontSize(12)
         .text('FEE BREAKDOWN:', { underline: true })
         .moveDown(0.5);

      // Table headers
      doc.text('Description', 50)
         .text('Amount', 250)
         .text('Status', 400)
         .moveDown(0.5);

      // Table rows
      transformedBill.items.forEach(item => {
        const status = item.balance <= 0 ? 'PAID' : 'PENDING';
        doc.text(item.name, 50)
           .text(formatCurrency(item.amount), 250)
           .text(status, 400)
           .moveDown(0.5);
      });
    }

    // Footer
    doc.moveDown(2)
       .fontSize(10)
       .text('This is an official computer-generated receipt', { align: 'center' });

    // Send PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt_${payment._id}.pdf`);
    doc.pipe(res);
    doc.end();

  } catch (error) {
    console.error('Receipt generation error:', error);
    res.status(500).json({
      message: 'Error generating receipt',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
},

  // Get all fee templates for a school
  async getFeeTemplates(req, res) {
    try {
      if (!req.user?.school) {
        return res.status(403).json({ message: 'Unauthorized' });
      }

      const templates = await FeeTemplate.find({ 
        school: req.user.school 
      }).lean();

      res.json({
        success: true,
        count: templates.length,
        templates
      });
    } catch (error) {
      console.error('Error fetching fee templates:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error fetching fee templates',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  // Get term bills for students in a class
  async getTermBills(req, res) {
    try {
      const { classId, term, academicYear } = req.query;
      
      if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid classId is required'
        });
      }

      const cleanTerm = term?.trim();
      const cleanAcademicYear = academicYear?.trim();

      if (!cleanTerm || !cleanAcademicYear) {
        return res.status(400).json({
          success: false,
          message: 'Both term and academicYear are required'
        });
      }

      const classObjectId = new mongoose.Types.ObjectId(classId);

      const termBills = await TermBill.find({
        term: cleanTerm,
        academicYear: cleanAcademicYear
      })
      .populate({
        path: 'student',
        match: { 
          class: classObjectId
        },
        populate: [
          {
            path: 'user',
            select: 'name'
          },
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          {
            path: 'class',
            select: 'name stream displayName'
          }
        ],
        select: 'user class'
      })
      .populate({
        path: 'template',
        select: 'name description items'
      })
      .populate({
        path: 'payments',
        select: 'amount paymentDate method'
      })
      .lean();

      const processedBills = termBills
        .filter(bill => bill.student)
        .map(bill => {
          const transformedBill = transformBill(bill);
          const totalAmount = transformedBill.totalAmount;
          const payments = transformedBill.payments || [];
          const paidAmount = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
          const balance = totalAmount - paidAmount;

          let paymentStatus;
          if (balance <= 0) paymentStatus = 'Paid';
          else if (paidAmount > 0) paymentStatus = 'Partial';
          else paymentStatus = 'Unpaid';

          // 🟦 BONUS: Updated getTermBills for consistency
          const { className, classDisplayName } = resolveClassNames(
            transformedBill.student?.class
          );

          return {
            ...transformedBill,
            studentName: transformedBill.student?.name || 'Unknown',
            className,
            classDisplayName,
            studentId: transformedBill.student?._id,
            totalAmount,
            paidAmount,
            balance,
            formattedTotal: formatCurrency(totalAmount),
            formattedPaid: formatCurrency(paidAmount),
            formattedBalance: formatCurrency(balance),
            paymentStatus,
            lastPayment: payments.length > 0 
              ? payments[payments.length - 1].paymentDate 
              : null
          };
        });

      return res.status(200).json({
        success: true,
        count: processedBills.length,
        data: processedBills,
        meta: {
          classId,
          term: cleanTerm,
          academicYear: cleanAcademicYear,
          generatedAt: new Date().toISOString(),
          currency: 'GHS'
        }
      });

    } catch (error) {
      console.error('Term bill processing failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to process term bills request',
        error: process.env.NODE_ENV === 'development' ? {
          message: error.message,
          stack: error.stack
        } : undefined
      });
    }
  },

// Add this to your controllers
async recordPayment(req, res) {
  const session = await mongoose.startSession();
  let transactionCommitted = false;

  try {
    await session.startTransaction();
    const { billId, amount, method, term, academicYear, studentId, itemsToPay } = req.body;

    // Validate required fields
    if (!billId || !amount || amount <= 0 || !method || !term || !academicYear || !studentId) {
      throw new Error('Missing required fields: billId, amount, method, term, academicYear, studentId');
    }

    // Check if bill exists
    const bill = await TermBill.findOne({
      _id: billId,
      student: studentId,
      term,
      academicYear,
      school: req.user.school
    }).session(session);

    if (!bill) throw new Error('Bill not found');

    // Validate payment amount
    const remainingBalance = bill.totalAmount - bill.totalPaid;
    if (amount > remainingBalance) throw new Error('Payment amount exceeds remaining balance');

    // Create payment record
    const payment = await Payment.create([{
      bill: billId,
      amount,
      method,
      term,
      academicYear,
      student: studentId,
      school: req.user.school,
      recordedBy: req.user._id
    }], { session });

    // Apply payment to items
    let amountLeft = amount;
    const updatedItems = bill.items.map(item => {
      if (amountLeft <= 0 || (itemsToPay?.length && !itemsToPay.includes(item._id.toString()))) return item;

      const paymentApplied = Math.min(amountLeft, item.balance);
      amountLeft -= paymentApplied;

      return {
        ...item.toObject(),
        paid: item.paid + paymentApplied,
        balance: item.balance - paymentApplied
      };
    });

    // Update bill totals
    const totalPaid = bill.totalPaid + amount;
    const newBalance = bill.totalAmount - totalPaid;
    const status = newBalance <= 0 ? 'Paid' : 'Partial';

    // Update bill
    let updatedBill = await TermBill.findByIdAndUpdate(
      billId,
      {
        items: updatedItems,
        totalPaid,
        balance: newBalance,
        status,
        $push: {
          payments: {
            _id: payment[0]._id,
            amount,
            method,
            date: new Date()
          }
        }
      },
      { new: true, session }
    )
    .populate({
      path: 'student',
      populate: [
        { path: 'user', select: 'name' },
        // 🟦 STEP 1 — UPDATED: Added stream and displayName
        { path: 'class', select: 'name stream displayName' }
      ]
    })
    .populate('template', 'name')
    .session(session);

    await session.commitTransaction();
    transactionCommitted = true;

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.to(req.user.school.toString()).emit('payment-recorded', {
        billId,
        amount,
        studentId,
        newBalance
      });
    }

// Response payload
    const { className, classDisplayName } = resolveClassNames(
      updatedBill.student?.class
    );

    const responseData = {
      ...updatedBill.toObject(),
      student: {
        _id: updatedBill.student._id,
        name: updatedBill.student.user?.name || 'N/A',
      },
      class: {
        ...updatedBill.student?.class,
        name: className,
        displayName: classDisplayName,
      },
      items: updatedBill.items.map(item => ({
        _id: item._id,
        name: item.name,
        amount: item.amount,
        paid: item.paid,
        balance: item.balance
      })),
      payments: updatedBill.payments.map(p => ({
        _id: p._id,
        amount: p.amount,
        method: p.method,
        date: p.date
      }))
    };

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      payment: {
        _id: payment[0]._id,
        amount: payment[0].amount,
        method: payment[0].method,
        date: payment[0].date
      },
      updatedBill: responseData
    });

  } catch (error) {
    if (!transactionCommitted && session.inTransaction()) await session.abortTransaction();

    console.error('Payment recording error:', error);
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      message: error.message || 'Error recording payment',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    await session.endSession();
  }
},


  async updateOrCreateBill(req, res) {
  const session = await mongoose.startSession();
  let committed = false; // ✅ Track commit state

  try {
    await session.startTransaction();

    if (!req.user?.school) {
      throw new Error('Unauthorized');
    }

    const { studentId, templateId, items, term, academicYear, billId } = req.body;

    // Validate required fields
    if (!studentId || !templateId || !items || !Array.isArray(items) || !term || !academicYear) {
      throw new Error('Missing required fields: studentId, templateId, items array, term, or academicYear');
    }

    // Validate items structure
    const invalidItems = items.filter(item =>
      !item.name || typeof item.amount !== 'number' || item.amount < 0
    );
    if (invalidItems.length > 0) {
      throw new Error('Invalid items: Each item must have a name and positive amount');
    }

    // Find student
    const student = await Student.findOne({
      _id: studentId,
      school: req.user.school
    })
      .populate({ path: 'user', select: 'name' })
      // 🟦 STEP 1 — UPDATED: Added stream and displayName
      .populate('class', 'name stream displayName')
      .session(session);

    if (!student) throw new Error('Student not found');

    // Validate template
    const template = await FeeTemplate.findOne({
      _id: templateId,
      school: req.user.school
    }).session(session);

    if (!template) throw new Error('Fee template not found');

    // Calculate totals
    const totalAmount = items.reduce((sum, item) => sum + (item.amount || 0), 0);
    const totalPaid = items.reduce((sum, item) => sum + (item.paid || 0), 0);
    const status =
      totalPaid >= totalAmount ? 'Paid' : totalPaid > 0 ? 'Partial' : 'Unpaid';

    const billItems = items.map(item => ({
      name: item.name,
      amount: item.amount,
      paid: item.paid || 0,
      balance: (item.amount || 0) - (item.paid || 0)
    }));

    let bill;

    if (billId) {
      // Update existing bill
      bill = await TermBill.findByIdAndUpdate(
        billId,
        {
          items: billItems,
          totalAmount,
          totalPaid,
          status,
          isManualUpdate: true
        },
        { new: true, session }
      )
        .populate({
          path: 'student',
          populate: [
            { path: 'user', select: 'name' },
            // 🟦 STEP 1 — UPDATED: Added stream and displayName
            { path: 'class', select: 'name stream displayName' }
          ]
        })
        .populate('template', 'name')
        .session(session);
    } else {
      // Create new bill
      const newBill = await TermBill.create(
        [
          {
            school: req.user.school,
            student: studentId,
            template: templateId,
            items: billItems,
            totalAmount,
            totalPaid,
            term,
            academicYear,
            status,
            isManualUpdate: true
          }
        ],
        { session }
      );
      bill = newBill[0];
    }

    // Populate if needed
    if (!bill.student?.name) {
      bill = await TermBill.findById(bill._id)
  .populate({
    path: 'student',
    populate: [
      { path: 'user', select: 'name' },
      // 🟦 STEP 1 — UPDATED: Added stream and displayName
      { path: 'class', select: 'name stream displayName' }
    ]
  })
  .populate('template', 'name')
  .lean();   // ✅ removes session + circular refs
    }

// Construct response
const { className, classDisplayName } = resolveClassNames(student.class);

const responseBill = {
  ...transformBill(bill),
  student: {
    _id: student._id,
    name: student.user?.name || 'N/A'
  },
  class: {
    ...student.class,
    name: className,
    displayName: classDisplayName,
  }
};

    // Commit transaction
    await session.commitTransaction();
    committed = true; // ✅ Mark commit completed

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.to(req.user.school.toString()).emit('bill-updated', {
        studentId,
        billId: bill._id,
        action: billId ? 'updated' : 'created'
      });
    }

    res.status(billId ? 200 : 201).json({
      success: true,
      message: billId ? 'Bill updated successfully' : 'Bill created successfully',
      bill: responseBill
    });

  } catch (error) {
    // ✅ Safe abort: only abort if not committed yet
    if (!committed && session.inTransaction()) {
      await session.abortTransaction();
    }

    console.error('Bill update/create error:', error);

    res.status(500).json({
      message: 'Error processing bill',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });

  } finally {
    await session.endSession(); // Always end session
  }
},

// Student views their own fees
// ✅ Get student (or parent's children) bills — supports childId filter
async getStudentBills(req, res) {
  try {
    const { childId } = req.query;
    const user = req.user;

    if (!user?._id) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    let students = [];

    // 🎓 If student is logged in
    if (user.role === "student") {
      const student = await Student.findOne({ user: user._id })
        .populate("user", "name")
        // 🟦 STEP 1 — UPDATED: Added stream and displayName
        .populate("class", "name stream displayName");

      if (!student) {
        return res.status(404).json({ message: "Student record not found" });
      }
      students.push(student);
    }

    // 👪 If parent is logged in
    else if (user.role === "parent") {
      if (childId) {
        // ✅ Parent viewing a specific child
        const targetChild = await Student.findOne({
          _id: childId,
          school: user.school,
          $or: [
            { parent: user._id },
            { parentIds: { $in: [user._id] } },
          ],
        })
          .populate("user", "name")
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          .populate("class", "name stream displayName");

        if (!targetChild) {
          return res.status(403).json({
            message: "Unauthorized: This child is not linked to your account.",
          });
        }

        students = [targetChild];
      } else {
        // ✅ Otherwise, fetch all linked children
        students = await Student.find({
          school: user.school,
          $or: [
            { parent: user._id },
            { parentIds: { $in: [user._id] } },
          ],
        })
          .populate("user", "name")
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          .populate("class", "name stream displayName");

        if (!students.length) {
          return res.status(404).json({
            message: "No children linked to your account.",
          });
        }
      }
    }

    // 🚫 Any other role
    else {
      return res.status(403).json({
        message: "Access denied: Only students or parents can view bills.",
      });
    }

    // 🧠 Normalize IDs for safe matching
    const mongoose = require("mongoose");
    const studentIds = students.map((s) => s._id);
    const objectIds = studentIds.map((id) => new mongoose.Types.ObjectId(id));

    console.log("🎯 Fetching bills for student IDs:", objectIds);

    // 📋 Fetch bills for ONLY those students (casted ObjectIds)
    const bills = await TermBill.find({
      student: { $in: objectIds },
      school: user.school,
    })
      .populate("template")
      .populate({
        path: "student",
        populate: [
          { path: "user", select: "name" },
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          { path: "class", select: "name stream displayName" },
        ],
      })
      .populate({
        path: "payments",
        select: "amount paymentDate method",
      })
      .lean();

    if (!bills.length) {
      console.log(`⚠️ No bills found for student(s):`, objectIds);
      return res.json({
        success: true,
        data: [],
        message: "No bills found for this student or children.",
      });
    }

    // 💰 Transform and calculate totals
    const transformedBills = bills.map((bill) => {
      const transformed = transformBill(bill);
      const totalAmount = transformed.totalAmount;
      const payments = transformed.payments || [];
      const paidAmount = payments.reduce(
        (sum, p) => sum + (Number(p.amount) || 0),
        0
      );
      const balance = totalAmount - paidAmount;

      let paymentStatus;
      if (balance <= 0) paymentStatus = "Paid";
      else if (paidAmount > 0) paymentStatus = "Partial";
      else paymentStatus = "Unpaid";

      // 🟦 STEP 6 — UPDATED getStudentBills
      const { className, classDisplayName } = resolveClassNames(
        transformed.student?.class || transformed.class
      );

      return {
        ...transformed,
        studentName:
          transformed.student?.user?.name ||
          transformed.student?.name ||
          "Unknown",
        className,
        classDisplayName,
        studentId: transformed.student?._id?.toString(),
        totalAmount,
        paidAmount,
        balance,
        formattedTotal: formatCurrency(totalAmount),
        formattedPaid: formatCurrency(paidAmount),
        formattedBalance: formatCurrency(balance),
        paymentStatus,
        lastPayment:
          payments.length > 0
            ? payments[payments.length - 1].paymentDate
            : null,
      };
    });

    // ✅ If parent requested a specific child, filter strictly
    const finalBills = childId
      ? transformedBills.filter((b) => b.studentId === childId)
      : transformedBills;

    console.log(
      `✅ Returning ${finalBills.length} bills for`,
      childId || "all linked students"
    );

    res.json({
      success: true,
      count: finalBills.length,
      data: finalBills,
    });
  } catch (error) {
    console.error("❌ Student bills error:", error);
    res.status(500).json({
      message: "Error fetching student bills",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
},



// ✅ Generate receipt (student or parent's child)
async generateStudentReceipt(req, res) {
  try {
    const { paymentId, childId } = req.params;
    const user = req.user;

    if (!user?._id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    let targetStudent;

    // 🎓 If student
    if (user.role === 'student') {
      targetStudent = await Student.findOne({
        user: user._id,
        school: user.school,
      });
    }

    // 👪 If parent
    else if (user.role === 'parent') {
      if (!childId) {
        return res.status(400).json({ message: 'Missing childId parameter' });
      }

      targetStudent = await Student.findOne({
        _id: childId,
        school: user.school,
        $or: [
          { parent: user._id },
          { parentIds: { $in: [user._id] } },
        ],
      });

      if (!targetStudent) {
        return res.status(403).json({
          message: 'Unauthorized: This child is not linked to your account.',
        });
      }
    }

    // 🚫 Other roles
    else {
      return res.status(403).json({
        message: 'Access denied: Only students or parents can generate receipts.',
      });
    }

    if (!targetStudent) {
      return res.status(404).json({ message: 'Student record not found.' });
    }

    // 🏫 Get school info
    const schoolInfo = await require('../models/SchoolInfo')
      .findOne({ school: user.school })
      .populate('school', 'name')
      .lean();

    if (!schoolInfo) {
      return res.status(404).json({ message: 'School information not found.' });
    }

    // 💰 Fetch payment (must belong to this student)
    const payment = await Payment.findOne({
      _id: paymentId,
      student: targetStudent._id,
      school: user.school,
    })
      .populate({
        path: 'bill',
        populate: [
          { path: 'template', select: 'name' },
          {
            path: 'student',
            populate: [
              { path: 'user', select: 'name' },
              // 🟦 STEP 1 — UPDATED: Added stream and displayName
              { path: 'class', select: 'name stream displayName' },
            ],
          },
        ],
      });

    if (!payment) {
      return res.status(404).json({
        message: 'Payment not found or unauthorized access.',
      });
    }

    const transformedBill = transformBill(payment.bill);
    if (!transformedBill.balance && payment.amount) {
      transformedBill.balance =
        transformedBill.totalAmount - (transformedBill.totalPaid || 0);
    }

    // 🧾 Generate PDF
    const doc = new PDFDocument();

    if (schoolInfo.logo) {
      try {
        doc.image(schoolInfo.logo, 250, 30, { width: 60 });
      } catch (e) {
        console.error('Could not load logo:', e);
      }
    }

    doc.moveDown(1)
      .fontSize(18)
      .text(schoolInfo.school?.name || 'School Name', { align: 'center' })
      .moveDown(0.3);

    doc.fontSize(14)
      .text('STUDENT PAYMENT RECEIPT', { align: 'center', underline: true })
      .moveDown(1);

    // 🟦 STEP 7 — UPDATED generateStudentReceipt
    const { classDisplayName: studentReceiptClassDisplay } = resolveClassNames(
      transformedBill.student.class
    );
    
    doc.fontSize(12)
      .text(`Student: ${transformedBill.student.user?.name}`, { continued: true })
      .text(`Class: ${studentReceiptClassDisplay || 'N/A'}`, {
        align: 'right',
      })
      .moveDown(1);

    const col1 = 50,
      col2 = 300;
    doc.fontSize(12)
      .text('Receipt No:', col1)
      .text(payment._id.toString(), col2)
      .moveDown(0.5)
      .text('Date:', col1)
      .text(payment.createdAt.toLocaleDateString(), col2)
      .moveDown(0.5)
      .text('Amount Paid:', col1)
      .text(formatCurrency(payment.amount), col2)
      .moveDown(0.5)
      .text('Balance:', col1)
      .text(formatCurrency(transformedBill.balance), col2)
      .moveDown(1.5);

    if (transformedBill.items?.length > 0) {
      doc.fontSize(12).text('FEE BREAKDOWN:', { underline: true }).moveDown(0.5);

      doc.text('Description', 50).text('Amount', 250).text('Status', 400).moveDown(0.5);

      transformedBill.items.forEach((item) => {
        const status = item.balance <= 0 ? 'PAID' : 'PENDING';
        doc
          .text(item.name, 50)
          .text(formatCurrency(item.amount), 250)
          .text(status, 400)
          .moveDown(0.5);
      });
    }

    doc.moveDown(2)
      .fontSize(10)
      .text('This is an official computer-generated receipt', { align: 'center' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=receipt_${targetStudent._id}.pdf`
    );
    doc.pipe(res);
    doc.end();
  } catch (error) {
    console.error('Student receipt error:', error);
    res.status(500).json({
      message: 'Error generating student receipt',
      error:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
},


// Generate full Fee Statement PDF
async generateFeeStatement(req, res) {
  try {
    const { studentId, term, academicYear } = req.query;

    if (!studentId || !term || !academicYear) {
      return res.status(400).json({ message: "Missing studentId, term, or academicYear" });
    }

    // Load school info
    const SchoolInfo = require('../models/SchoolInfo');
    const schoolInfo = await SchoolInfo.findOne({ school: req.user.school })
      .populate('school', 'name')
      .lean();

    if (!schoolInfo) {
      return res.status(404).json({ message: 'School information not found' });
    }

    // Fetch bill
    const bill = await TermBill.findOne({
      student: studentId,
      term,
      academicYear,
      school: req.user.school
    })
      .populate({
        path: 'student',
        populate: [
          { path: 'user', select: 'name' },
          // 🟦 STEP 1 — UPDATED: Added stream and displayName
          { path: 'class', select: 'name stream displayName' }
        ]
      })
      .populate('payments')
      .populate('template');

    if (!bill) {
      return res.status(404).json({ message: 'No bill found for this student/term' });
    }

    const transformed = transformBill(bill);

    // Calculate totals
    const totalAmount = transformed.totalAmount || 0;
    const payments = bill.payments || [];
    const paidAmount = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const balance = totalAmount - paidAmount;

    // Start PDF doc
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40 });

    // Pipe to response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=statement_${studentId}_${term}.pdf`);
    doc.pipe(res);

    // Header
    if (schoolInfo.logo) {
      try {
        doc.image(schoolInfo.logo, 250, 30, { width: 60 });
      } catch (e) {
        console.error("Logo load error:", e);
      }
    }

    doc.fontSize(18).text(schoolInfo.school?.name || "School", { align: "center" });
    doc.moveDown(0.5).fontSize(14).text("FEE STATEMENT", { align: "center", underline: true });
    doc.moveDown(1);

    // Student info
    // 🟦 STEP 7 — UPDATED generateFeeStatement
    const { classDisplayName: statementClassDisplay } = resolveClassNames(
      transformed.class
    );
    
    doc.fontSize(12)
      .text(`Student: ${transformed.student?.name || 'Unknown'}`)
      .text(`Class: ${statementClassDisplay || 'N/A'}`)
      .text(`Term: ${term} (${academicYear})`)
      .moveDown(1);

    // Bill breakdown
    doc.fontSize(12).text("FEE ITEMS:", { underline: true });
    doc.moveDown(0.3);
    doc.text("Description", 50)
       .text("Amount", 250)
       .text("Paid", 350)
       .text("Balance", 450)
       .moveDown(0.5);

    transformed.items.forEach(item => {
      const itemPaid = item.paid || 0;
      const itemBalance = item.balance ?? (item.amount - itemPaid);

      doc.text(item.name, 50)
        .text(formatCurrency(item.amount), 250)
        .text(formatCurrency(itemPaid), 350)
        .text(formatCurrency(itemBalance), 450)
        .moveDown(0.3);
    });

    doc.moveDown(1);
    doc.text(`Total: ${formatCurrency(totalAmount)}`);
    doc.text(`Total Paid: ${formatCurrency(paidAmount)}`);
    doc.text(`Outstanding Balance: ${formatCurrency(balance)}`);
    doc.moveDown(1.5);

    // Payment history
    if (payments.length > 0) {
      doc.fontSize(12).text("PAYMENT HISTORY:", { underline: true }).moveDown(0.3);
      doc.text("Date", 50).text("Amount", 250).text("Method", 400).moveDown(0.5);

      payments.forEach(p => {
        doc.text(new Date(p.paymentDate || p.createdAt).toLocaleDateString(), 50)
          .text(formatCurrency(p.amount), 250)
          .text(p.method || "N/A", 400)
          .moveDown(0.3);
      });
    }

    // Footer
    doc.moveDown(2)
       .fontSize(10)
       .text("This is a computer-generated fee statement", { align: "center" });

    // End doc
    doc.end();

  } catch (error) {
    console.error("Fee statement generation error:", error);
    res.status(500).json({ message: "Error generating fee statement", error: error.message });
  }
},

// Add this to your backend controller - get receipt data for mobile app
async getReceiptData(req, res) {
  try {
    const { paymentId } = req.params;

    if (!req.user?._id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    // Find the student record for the logged in user
    const student = await Student.findOne({ user: req.user._id, school: req.user.school });
    if (!student) {
      return res.status(404).json({ message: 'Student record not found' });
    }

    // Fetch payment (only if it belongs to this student)
    const payment = await Payment.findOne({
      _id: paymentId,
      student: student._id,
      school: req.user.school
    })
      .populate({
        path: 'bill',
        populate: [
          { path: 'template', select: 'name' },
          {
            path: 'student',
            populate: [
              { path: 'user', select: 'name' },
              // 🟦 STEP 1 — UPDATED: Added stream and displayName
              { path: 'class', select: 'name stream displayName' }
            ]
          }
        ]
      });

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found or not yours' });
    }

    const transformedBill = transformBill(payment.bill);
    
    // Calculate balance if not present
    if (!transformedBill.balance && payment.amount) {
      transformedBill.balance = transformedBill.totalAmount - (transformedBill.totalPaid || 0);
    }

    // Return JSON data instead of PDF
    res.json({
      success: true,
      data: {
        payment: {
          _id: payment._id,
          amount: payment.amount,
          method: payment.method,
          date: payment.date || payment.createdAt,
          createdAt: payment.createdAt
        },
        bill: transformedBill
      }
    });

  } catch (error) {
    console.error('Receipt data error:', error);
    res.status(500).json({
      message: 'Error fetching receipt data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
};