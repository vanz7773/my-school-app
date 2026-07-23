const mongoose = require('mongoose');
const { FeeTemplate, TermBill, Parent, Payment } = require('../models/allModels');
const currency = require('currency-formatter');
const PDFDocument = require('pdfkit');
const User = require('../models/User');
const Student = require('../models/Student');

const FIXED_BILLING_MODE = 'fixed';
const DAILY_VARIABLE_BILLING_MODE = 'daily-variable';
const DEFAULT_DAILY_FEE_LABEL = 'Daily School Fees';

const normalizeBillingMode = (mode) =>
  mode === DAILY_VARIABLE_BILLING_MODE ? DAILY_VARIABLE_BILLING_MODE : FIXED_BILLING_MODE;

const isDailyVariableMode = (mode) => normalizeBillingMode(mode) === DAILY_VARIABLE_BILLING_MODE;

const buildDailyVariableItems = (label = DEFAULT_DAILY_FEE_LABEL, amount = 0) => ([{
  name: label || DEFAULT_DAILY_FEE_LABEL,
  amount: Number(amount) || 0,
  paid: Number(amount) || 0,
  balance: 0,
  isVariable: true,
}]);

const toIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'object') {
    return String(value._id || value.id || value);
  }
  return String(value);
};

const getAcademicYearStart = (academicYear) => {
  const match = String(academicYear || '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
};

const getTermNumber = (term) => {
  const match = String(term || '').match(/\d+/);
  return match ? Number(match[0]) : null;
};

const getFeePeriodOrder = (term, academicYear) => {
  const yearStart = getAcademicYearStart(academicYear);
  const termNumber = getTermNumber(term);
  if (!yearStart || !termNumber) return null;
  return (yearStart * 10) + termNumber;
};

const getPreviousFeePeriod = (term, academicYear) => {
  const yearStart = getAcademicYearStart(academicYear);
  const termNumber = getTermNumber(term);
  if (!yearStart || !termNumber) return null;

  if (termNumber === 1) {
    return {
      term: 'Term 3',
      academicYear: `${yearStart - 1}-${yearStart}`
    };
  }

  return {
    term: `Term ${termNumber - 1}`,
    academicYear: `${yearStart}-${yearStart + 1}`
  };
};

const getBillOutstandingBalance = (bill) => {
  if (isDailyVariableMode(bill?.billingMode || bill?.termFeeBillingMode)) {
    return 0;
  }

  const totalAmount = Number(bill?.totalAmount) || 0;
  const hasPaymentRows = Array.isArray(bill?.payments) && bill.payments.length > 0;
  const totalPaid = hasPaymentRows
    ? bill.payments.reduce((sum, payment) => sum + (Number(payment?.amount) || 0), 0)
    : Number(bill?.totalPaid) || 0;
  const calculatedBalance = Math.max(0, totalAmount - totalPaid);
  const storedBalance = Number(bill?.balance);

  if (hasPaymentRows) {
    return calculatedBalance;
  }

  if (Number.isFinite(storedBalance) && storedBalance > 0) {
    return Math.max(0, storedBalance);
  }

  return calculatedBalance;
};

const buildPreviousArrearsMap = async ({
  schoolId,
  studentIds,
  currentTerm,
  currentAcademicYear
}) => {
  const previousPeriod = getPreviousFeePeriod(currentTerm, currentAcademicYear);
  const normalizedStudentIds = [...new Set((studentIds || []).map(toIdString).filter(Boolean))];
  const arrearsMap = new Map();

  if (!schoolId || !previousPeriod || normalizedStudentIds.length === 0) {
    return arrearsMap;
  }

  const previousBills = await TermBill.find({
    school: schoolId,
    student: { $in: normalizedStudentIds },
    term: previousPeriod.term,
    academicYear: previousPeriod.academicYear
  })
    .select('student term academicYear totalAmount totalPaid balance billingMode payments status')
    .lean();

  previousBills.forEach((bill) => {
    const amount = getBillOutstandingBalance(bill);
    if (amount <= 0) return;

    const studentId = toIdString(bill.student);
    const existing = arrearsMap.get(studentId) || [];
    existing.push({
      _id: toIdString(bill._id),
      term: bill.term,
      academicYear: bill.academicYear,
      name: `PREVIOUS ARREARS [${bill.term || 'Term'} | ${bill.academicYear || 'Year'}]`,
      amount,
      balance: amount,
      totalAmount: Number(bill.totalAmount) || 0,
      totalPaid: Number(bill.totalPaid) || 0,
      status: bill.status || 'Unpaid'
    });
    arrearsMap.set(studentId, existing);
  });

  const normalizedMap = new Map();
  arrearsMap.forEach((items, studentId) => {
    const sortedItems = items.sort((a, b) => toIdString(a._id).localeCompare(toIdString(b._id)));
    const previousArrearsAmount = sortedItems.reduce(
      (sum, item) => sum + (Number(item.amount) || 0),
      0
    );
    const latestArrears = sortedItems[sortedItems.length - 1] || null;

    normalizedMap.set(studentId, {
      previousArrears: sortedItems,
      previousArrearsAmount,
      previousArrearsSubtotal: previousArrearsAmount,
      previousArrearsTerm: latestArrears?.term || '',
      previousArrearsAcademicYear: latestArrears?.academicYear || ''
    });
  });

  return normalizedMap;
};

const attachPreviousArrears = (bill, arrearsMap, studentIdOverride) => {
  const studentId = toIdString(
    studentIdOverride ||
    bill?.studentId ||
    bill?.student?._id ||
    bill?.student
  );
  const arrears = arrearsMap?.get(studentId);

  return {
    ...bill,
    previousArrears: arrears?.previousArrears || [],
    previousArrearsAmount: arrears?.previousArrearsAmount || 0,
    previousArrearsSubtotal: arrears?.previousArrearsSubtotal || 0,
    previousArrearsTerm: arrears?.previousArrearsTerm || '',
    previousArrearsAcademicYear: arrears?.previousArrearsAcademicYear || ''
  };
};

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

  // 🟦 STEP 2 — FINAL (feeding-fee-style)
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
    balance: isDailyVariableMode(bill.billingMode)
      ? 0
      : transformNumber(bill.balance) || Math.max(0, transformNumber(bill.totalAmount) - transformNumber(bill.totalPaid)),
    billingMode: normalizeBillingMode(bill.billingMode),
    dailyFeeLabel: bill.dailyFeeLabel || DEFAULT_DAILY_FEE_LABEL,

    student: {
      ...(typeof bill.student === "object"
        ? bill.student
        : { _id: bill.student }),
      name: getStudentName(bill.student),
    },

    class: {
      ...(bill.student?.class || {}),
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
          .select('_id user class admissionNumber termFeeBillingMode');
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
          .select('_id user class admissionNumber termFeeBillingMode');
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
        const billingMode = normalizeBillingMode(student.termFeeBillingMode);
        const isDailyVariable = isDailyVariableMode(billingMode);
        const items = isDailyVariable
          ? buildDailyVariableItems()
          : template.items.map(item => ({
            name: item.name,
            amount: item.amount,
            isMandatory: item.isMandatory
          }));

        return {
          studentId: student._id,
          studentName: student.user?.name || student.admissionNumber || 'Unknown',
          className,
          classDisplayName,
          billingMode,
          isDailyVariable,
          items,
          totalAmount: isDailyVariable ? 0 : template.items.reduce((sum, item) => sum + item.amount, 0),
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
        .select('_id user class admissionNumber isExemptFromTermFees termFeeBillingMode')
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
          // Skip bill generation for students exempt from term fees
          if (student.isExemptFromTermFees === true) continue;

          const studentId = student._id.toString();
          const billingMode = normalizeBillingMode(student.termFeeBillingMode);
          const isDailyVariable = isDailyVariableMode(billingMode);
          const manualBill = manualBillsMap.get(studentId);
          const existingBill = existingBillsMap.get(studentId);
          let billToReturn;

          if (isDailyVariable) {
            const existingTotal = isDailyVariableMode(existingBill?.billingMode)
              ? Number(existingBill?.totalPaid ?? existingBill?.totalAmount) || 0
              : Number(existingBill?.totalPaid) || 0;
            const dailyItems = buildDailyVariableItems(DEFAULT_DAILY_FEE_LABEL, existingTotal);

            if (existingBill) {
              billToReturn = await TermBill.findByIdAndUpdate(
                existingBill._id,
                {
                  billingMode,
                  dailyFeeLabel: DEFAULT_DAILY_FEE_LABEL,
                  items: dailyItems,
                  totalAmount: existingTotal,
                  totalPaid: existingTotal,
                  balance: 0,
                  status: existingTotal > 0 ? 'Paid' : 'Pending',
                  template: templateId,
                  class: student.class || null,
                  term,
                  academicYear
                },
                { new: true, session }
              );
            } else {
              billToReturn = await TermBill.create([{
                school: req.user.school,
                student: student._id,
                class: student.class || null,
                template: templateId,
                term,
                academicYear,
                billingMode,
                dailyFeeLabel: DEFAULT_DAILY_FEE_LABEL,
                items: buildDailyVariableItems(),
                totalAmount: 0,
                totalPaid: 0,
                balance: 0,
                status: 'Pending',
                isManualUpdate: false
              }], { session });
              billToReturn = billToReturn[0];
            }
          } else if (manualBill) {
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
                  billingMode,
                  balance: Math.max(0, (Number(manualBill.totalAmount) || 0) - (Number(manualBill.totalPaid) || 0)),
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
                balance: Math.max(0, (Number(manualBill.totalAmount) || 0) - (Number(manualBill.totalPaid) || 0)),
                status: manualBill.status,
                billingMode,
                isManualUpdate: true
              }], { session });
              billToReturn = billToReturn[0];
            }
          } else if (existingBill) {
            const total = template.items.reduce((sum, item) => sum + item.amount, 0);

            // Distribute existing payments across the new template items
            let amountLeft = Number(existingBill.totalPaid) || 0;
            const updatedItems = template.items.map(item => {
              if (amountLeft <= 0) {
                return {
                  name: item.name,
                  amount: item.amount,
                  paid: 0,
                  balance: item.amount
                };
              }
              const paymentApplied = Math.min(amountLeft, item.amount);
              amountLeft -= paymentApplied;
              return {
                name: item.name,
                amount: item.amount,
                paid: paymentApplied,
                balance: item.amount - paymentApplied
              };
            });

            const newTotalPaid = Math.min(total, Number(existingBill.totalPaid) || 0);
            const newBalance = Math.max(0, total - newTotalPaid);
            const newStatus = newTotalPaid >= total ? 'Paid' : newTotalPaid > 0 ? 'Partial' : 'Unpaid';

            billToReturn = await TermBill.findByIdAndUpdate(
              existingBill._id,
              {
                template: templateId,
                items: updatedItems,
                totalAmount: total,
                totalPaid: newTotalPaid,
                balance: newBalance,
                status: newStatus,
                billingMode,
                isManualUpdate: false,
                class: student.class || null,
                term,
                academicYear
              },
              { new: true, session }
            );
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
              balance: total,
              status: 'Unpaid',
              billingMode,
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

      const previousArrearsMap = await buildPreviousArrearsMap({
        schoolId: req.user.school,
        studentIds: bills.map(bill => bill.studentId || bill.student?._id || bill.student),
        currentTerm: term,
        currentAcademicYear: academicYear
      });
      const billsWithArrears = bills.map(bill => attachPreviousArrears(bill, previousArrearsMap));

      if (errors.length === 0) {
        await session.commitTransaction();
      } else {
        await session.abortTransaction();
        return res.status(207).json({
          success: true,
          count: bills.length,
          errorCount: errors.length,
          message: `Processed ${bills.length} bills with ${errors.length} errors`,
          bills: billsWithArrears.map(bill => ({
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
        bills: billsWithArrears.map(bill => ({
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
        const billingMode = normalizeBillingMode(transformed.billingMode || transformed.student?.termFeeBillingMode);
        const isDailyVariable = isDailyVariableMode(billingMode);
        const effectivePaidAmount = isDailyVariable ? transformed.totalPaid : paidAmount;
        const balance = isDailyVariable ? 0 : totalAmount - effectivePaidAmount;

        let paymentStatus;
        if (isDailyVariable) paymentStatus = 'Daily Payer';
        else if (balance <= 0) paymentStatus = 'Paid';
        else if (effectivePaidAmount > 0) paymentStatus = 'Partial';
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
          totalPaid: effectivePaidAmount,
          paidAmount: effectivePaidAmount,
          balance,
          formattedTotal: formatCurrency(totalAmount),
          formattedPaid: formatCurrency(effectivePaidAmount),
          formattedBalance: formatCurrency(balance),
          paymentStatus,
          billingMode,
          dailyFeeLabel: transformed.dailyFeeLabel || DEFAULT_DAILY_FEE_LABEL,
          isDailyVariable,
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
          doc.image(schoolInfo.logo, 250, 30, {
            fit: [40, 40],
            align: 'center',
            valign: 'center',
          });
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
      const shortReceiptNo = payment._id.toString().slice(-6).toUpperCase();

      doc.fontSize(12)
        .text('Receipt No:', col1).text(shortReceiptNo, col2).moveDown(0.5)
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

      // 1. Fetch ALL active students in this class
      const students = await Student.find({
        class: classObjectId,
        school: req.user.school,
        status: { $ne: 'Withdrawn' } // Ensure all non-withdrawn students are retrieved, matching frontend logic
      })
        .populate({ path: 'user', select: 'name' })
        .populate({ path: 'class', select: 'name stream displayName' })
        .lean();

      // 2. Fetch existing bills for this class, term, and year
      const existingBills = await TermBill.find({
        school: req.user.school,
        term: cleanTerm,
        academicYear: cleanAcademicYear
      })
        .populate({
          path: 'student',
          match: { class: classObjectId },
          populate: [
            { path: 'user', select: 'name' },
            { path: 'class', select: 'name stream displayName' }
          ]
        })
        .populate('class', 'name stream displayName')
        .populate('template', 'name description items')
        .populate('payments')
        .lean();

      // Filter bills to only include those whose students are in this class (due to path match)
      const classBills = existingBills.filter(bill => bill.student);

      // Create a map for quick lookup
      const billsMap = new Map();
      classBills.forEach(bill => {
        billsMap.set(bill.student._id.toString(), bill);
      });

      const previousArrearsMap = await buildPreviousArrearsMap({
        schoolId: req.user.school,
        studentIds: students.map(student => student._id),
        currentTerm: cleanTerm,
        currentAcademicYear: cleanAcademicYear
      });

      // 3. Merge Students with Bills
      const processedBills = students.map(student => {
        const existingBill = billsMap.get(student._id.toString());

        if (existingBill) {
          const transformedBill = transformBill(existingBill);
          const totalAmount = transformedBill.totalAmount;
          const payments = transformedBill.payments || [];
          const paidAmount = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
          const billingMode = normalizeBillingMode(transformedBill.billingMode || student.termFeeBillingMode);
          const isDailyVariable = isDailyVariableMode(billingMode);
          const effectivePaidAmount = isDailyVariable ? transformedBill.totalPaid : paidAmount;
          const balance = isDailyVariable ? 0 : totalAmount - effectivePaidAmount;

          let paymentStatus;
          if (isDailyVariable) paymentStatus = 'Daily Payer';
          else if (balance <= 0) paymentStatus = 'Paid';
          else if (effectivePaidAmount > 0) paymentStatus = 'Partial';
          else paymentStatus = 'Unpaid';

          const { className, classDisplayName } = resolveClassNames(student.class);

          return attachPreviousArrears({
            ...transformedBill,
            studentName: student.user?.name || student.admissionNumber || 'Unknown',
            className,
            classDisplayName,
            studentId: student._id,
            totalAmount,
            totalPaid: effectivePaidAmount,
            paidAmount: effectivePaidAmount,
            balance,
            formattedTotal: formatCurrency(totalAmount),
            formattedPaid: formatCurrency(effectivePaidAmount),
            formattedBalance: formatCurrency(balance),
            paymentStatus,
            lastPayment: payments.length > 0 ? payments[payments.length - 1] : null,
            isPlaceholder: false,
            isExemptFromTermFees: student.isExemptFromTermFees || false,
            termFeeBillingMode: normalizeBillingMode(student.termFeeBillingMode),
            billingMode,
            dailyFeeLabel: transformedBill.dailyFeeLabel || DEFAULT_DAILY_FEE_LABEL,
            isDailyVariable
          }, previousArrearsMap, student._id);
        } else {
          // No bill exists for this student yet
          const { className, classDisplayName } = resolveClassNames(student.class);
          const studentName = student.user?.name || student.admissionNumber || 'Unknown';

          return attachPreviousArrears({
            _id: `temp-${student._id}`,
            student: {
              ...student,
              name: studentName,
            },
            class: {
              ...(student.class || {}),
              name: className,
              displayName: classDisplayName,
            },
            studentName,
            className,
            classDisplayName,
            studentId: student._id,
            totalAmount: 0,
            totalPaid: 0,
            balance: 0,
            status: 'Unpaid',
            paymentStatus: 'Unpaid',
            items: [],
            payments: [],
            isPlaceholder: true,
            term: cleanTerm,
            academicYear: cleanAcademicYear,
            isExemptFromTermFees: student.isExemptFromTermFees || false,
            termFeeBillingMode: normalizeBillingMode(student.termFeeBillingMode),
            billingMode: normalizeBillingMode(student.termFeeBillingMode),
            dailyFeeLabel: DEFAULT_DAILY_FEE_LABEL,
            isDailyVariable: isDailyVariableMode(student.termFeeBillingMode)
          }, previousArrearsMap, student._id);
        }
      });

      return res.status(200).json({
        success: true,
        count: processedBills.length,
        data: processedBills
      });
    } catch (error) {
      console.error('getTermBills error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch term bills',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  async getSchoolWideTermBillingSummary(req, res) {
    try {
      const { term, academicYear } = req.query;

      if (!term || !academicYear) {
        return res.status(400).json({
          success: false,
          message: 'Both term and academicYear are required'
        });
      }

      const cleanTerm = term.trim();
      const cleanAcademicYear = academicYear.trim();

      const bills = await TermBill.find({
        school: req.user.school,
        term: cleanTerm,
        academicYear: cleanAcademicYear
      })
        .populate('student', 'isExemptFromTermFees')
        .lean();

      let totalExpected = 0;
      let totalPaid = 0;
      let totalBalance = 0;
      let studentsBilled = 0;
      let fullyPaidCount = 0;
      let partialPaidCount = 0;

      const processedStudentIds = new Set();

      bills.forEach(bill => {
        // Skip orphaned bills where student was deleted
        if (!bill.student) {
          return;
        }

        // Prevent counting the same student twice if they have duplicate bills
        const studentIdStr = bill.student._id.toString();
        if (processedStudentIds.has(studentIdStr)) {
          return;
        }
        processedStudentIds.add(studentIdStr);

        studentsBilled++;

        // Skip exempt students from school-wide accounting totals
        if (bill.student.isExemptFromTermFees) {
          return;
        }

        const transformNumber = (value) => {
          if (!value) return 0;
          if (typeof value === 'object') {
            return value.$numberInt ? parseInt(value.$numberInt) :
              value.$numberDouble ? parseFloat(value.$numberDouble) : 0;
          }
          return typeof value === 'number' ? value : 0;
        };

        const billingMode = normalizeBillingMode(bill.billingMode);
        const isDailyVariable = isDailyVariableMode(billingMode);
        const paid = transformNumber(bill.totalPaid);
        const expected = isDailyVariable ? paid : transformNumber(bill.totalAmount);
        const actualBalance = isDailyVariable ? 0 : Math.max(0, expected - paid);

        totalExpected += expected;
        totalPaid += paid;
        totalBalance += actualBalance;

        if (actualBalance <= 0 && expected > 0) fullyPaidCount++;
        else if (paid > 0 && actualBalance > 0) partialPaidCount++;
      });

      return res.status(200).json({
        success: true,
        summary: {
          totalExpected,
          totalPaid,
          totalBalance,
          studentsBilled,
          fullyPaidCount,
          partialPaidCount
        }
      });
    } catch (error) {
      console.error('getSchoolWideTermBillingSummary error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch school-wide term billing summary',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  // Add this to your controllers
  async recordPayment(req, res) {
    const session = await mongoose.startSession();
    let transactionCommitted = false;

    try {
      await session.startTransaction();

      const { billId, amount, method, term, academicYear, studentId, itemsToPay, note } = req.body;

      if (!billId || !amount || amount <= 0 || !method || !term || !academicYear || !studentId) {
        throw new Error(
          'Missing required fields: billId, amount, method, term, academicYear, studentId'
        );
      }

      // 🔍 Fetch bill
      const bill = await TermBill.findOne({
        _id: billId,
        student: studentId,
        term,
        academicYear,
        school: req.user.school
      }).session(session);

      if (!bill) throw new Error('Bill not found');

      const billingMode = normalizeBillingMode(bill.billingMode);
      const isDailyVariable = isDailyVariableMode(billingMode);
      const remainingBalance = bill.totalAmount - bill.totalPaid;
      if (!isDailyVariable && amount > remainingBalance) {
        throw new Error('Payment amount exceeds remaining balance');
      }

      // 💳 Create payment
      const payment = await Payment.create(
        [{
          bill: billId,
          amount,
          method,
          billingMode,
          note: note || '',
          term,
          academicYear,
          student: studentId,
          school: req.user.school,
          recordedBy: req.user._id
        }],
        { session }
      );

      let updatedItems;
      let totalAmount;
      let totalPaid;
      let newBalance;
      let status;

      if (isDailyVariable) {
        totalPaid = (Number(bill.totalPaid) || 0) + amount;
        totalAmount = totalPaid;
        newBalance = 0;
        status = 'Paid';
        updatedItems = buildDailyVariableItems(bill.dailyFeeLabel || DEFAULT_DAILY_FEE_LABEL, totalPaid);
      } else {
        // 💰 Apply payment to fixed bill items
        let amountLeft = amount;
        updatedItems = bill.items.map(item => {
          if (
            amountLeft <= 0 ||
            (itemsToPay?.length && !itemsToPay.includes(item._id.toString()))
          ) {
            return item;
          }

          const paymentApplied = Math.min(amountLeft, item.balance);
          amountLeft -= paymentApplied;

          return {
            ...item.toObject(),
            paid: item.paid + paymentApplied,
            balance: item.balance - paymentApplied
          };
        });

        totalAmount = bill.totalAmount;
        totalPaid = bill.totalPaid + amount;
        newBalance = bill.totalAmount - totalPaid;
        status = newBalance <= 0 ? 'Paid' : 'Partial';
      }

      // 🧾 Update bill
      await TermBill.findByIdAndUpdate(
        billId,
        {
          items: updatedItems,
          totalAmount,
          totalPaid,
          balance: newBalance,
          status,
          billingMode,
          class: bill.class || null, // ✅ ENSURE CLASS STAYS ON BILL
          $push: {
            payments: {
              _id: payment[0]._id,
              amount,
              method,
              billingMode,
              note: note || '',
              date: new Date()
            }
          }
        },
        { session }
      );

      // 🔄 Re-fetch populated + lean
      const updatedBill = await TermBill.findById(billId)
        .populate({
          path: 'student',
          populate: [
            { path: 'user', select: 'name' },
            { path: 'class', select: 'name stream displayName' }
          ]
        })
        .populate('class', 'name stream displayName')
        .populate('template', 'name')
        .session(session)
        .lean();

      await session.commitTransaction();
      transactionCommitted = true;

      // 🔔 Emit socket event
      const io = req.app.get('io');
      if (io) {
        io.to(req.user.school.toString()).emit('payment-recorded', {
          billId,
          amount,
          studentId,
          newBalance,
          billingMode
        });
      }

      // 🟦 Use EXISTING resolver
      const { className, classDisplayName } = resolveClassNames(
        updatedBill.class || updatedBill.student?.class
      );

      const previousArrearsMap = await buildPreviousArrearsMap({
        schoolId: req.user.school,
        studentIds: [updatedBill.student?._id || studentId],
        currentTerm: term,
        currentAcademicYear: academicYear
      });

      const responseData = attachPreviousArrears({
        ...transformBill(updatedBill),
        student: {
          _id: updatedBill.student?._id,
          name: updatedBill.student?.user?.name || 'N/A'
        },
        class: {
          _id: updatedBill.class?._id || null,
          name: className,
          displayName: classDisplayName
        },
        items: updatedBill.items.map(item => ({
          _id: item._id,
          name: item.name,
          amount: item.amount,
          paid: item.paid,
          balance: item.balance,
          isVariable: item.isVariable === true
        })),
        payments: updatedBill.payments.map(p => ({
          _id: p._id,
          amount: p.amount,
          method: p.method,
          billingMode: p.billingMode || billingMode,
          note: p.note || '',
          date: p.date
        }))
      }, previousArrearsMap, updatedBill.student?._id || studentId);

      const notificationController = require('../controllers/notificationController');

      // 🔔 Send Push Notification to Student/Parent
      if (updatedBill.student?.user?._id) {
        const studentUserId = updatedBill.student.user._id;
        const amountFormatted = formatCurrency(payment[0].amount);
        const shortReceiptNo = payment[0]._id.toString().slice(-6).toUpperCase();

        await notificationController.sendPushToUser(
          studentUserId,
          'Fees Payment Receipt',
          `Payment of ${amountFormatted} received successfully. Receipt #${shortReceiptNo}. Log in to the app to download receipt.`,
          { type: 'payment', paymentId: payment[0]._id }
        );

        // Also notify parents if linked
        if (updatedBill.student.parentIds && updatedBill.student.parentIds.length > 0) {
          const parentTokens = updatedBill.student.parentIds.filter(Boolean);
          if (parentTokens.length > 0) {
            const studentName = updatedBill.student.user?.name || "your child";
            await notificationController.sendPushNotifications(
              parentTokens,
              'Fees Payment Receipt',
              `Payment of ${amountFormatted} received for ${studentName}. Receipt #${shortReceiptNo}. Log in to the app to download receipt.`,
              { type: 'payment', paymentId: payment[0]._id }
            ).catch(e => console.error("Parent receipt push failed:", e));
          }
        }
      }

      // 💬 Auto-Trigger SMS for Fee Payment
      try {
        const smsService = require('../services/smsService');
        const settings = await smsService.getSchoolSettings(req.user.school);
        
        // Skip immediate SMS for Daily Variable payers (we send a weekly summary instead)
        if (settings.smsEnabled && settings.autoTriggers?.feePayments && !isDailyVariable) {
          const User = require('../models/User');
          const studentName = updatedBill.student?.user?.name || "your child";
          
          let phones = [];
          if (updatedBill.student?.parentIds && updatedBill.student.parentIds.length > 0) {
            const parents = await User.find({ _id: { $in: updatedBill.student.parentIds } }).select('phone').lean();
            phones = parents.map(p => p.phone).filter(Boolean);
          } else if (updatedBill.student?.parent) {
            const parent = await User.findById(updatedBill.student.parent).select('phone').lean();
            if (parent && parent.phone) phones.push(parent.phone);
          }
          
          phones = [...new Set(phones)]; // Unique phone numbers
          
          if (phones.length > 0) {
            const amountFormatted = formatCurrency(payment[0].amount);
            const shortReceiptNo = payment[0]._id.toString().slice(-6).toUpperCase();
            const smsMessage = `Payment of ${amountFormatted} received for ${studentName}. Receipt #${shortReceiptNo}. Balance: ${formatCurrency(newBalance)}. Log in to the app to download receipt.`;
            
            await smsService.sendSms({
              schoolId: req.user.school,
              recipients: phones,
              message: smsMessage,
              messageType: 'fees'
            });
          }
        }
      } catch (smsError) {
        console.error("Auto-SMS fee payment failed:", smsError.message);
      }

      res.status(201).json({
        success: true,
        message: 'Payment recorded successfully',
        payment: {
          _id: payment[0]._id,
          amount: payment[0].amount,
          method: payment[0].method,
          billingMode: payment[0].billingMode || billingMode,
          note: payment[0].note || '',
          date: payment[0].paymentDate || payment[0].createdAt
        },
        updatedBill: responseData
      });

    } catch (error) {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction();
      }

      console.error('Payment recording error:', error);

      const statusCode = error.message.includes('not found') ? 404 : 400;
      res.status(statusCode).json({
        message: error.message || 'Error recording payment',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      await session.endSession();
    }
  },
  async reversePayment(req, res) {
    const session = await mongoose.startSession();
    let transactionCommitted = false;

    try {
      await session.startTransaction();

      const { paymentId, billId } = req.params;

      if (!paymentId || !billId) {
        throw new Error('Missing paymentId or billId');
      }

      // 🔍 Fetch bill
      const bill = await TermBill.findOne({
        _id: billId,
        school: req.user.school
      }).session(session);

      if (!bill) throw new Error('Bill not found');

      // 🔍 Fetch payment
      const payment = await Payment.findOne({
        _id: paymentId,
        school: req.user.school
      }).session(session);

      if (!payment) throw new Error('Payment not found');

      const amountToReverse = payment.amount;

      // Ensure the payment belongs to this bill
      if (payment.bill.toString() !== billId) {
        throw new Error('Payment does not belong to this bill');
      }

      const billingMode = normalizeBillingMode(bill.billingMode);
      const isDailyVariable = isDailyVariableMode(billingMode);

      let updatedItems;
      let totalPaid;
      let newBalance;
      let status;

      if (isDailyVariable) {
        totalPaid = Math.max(0, (Number(bill.totalPaid) || 0) - amountToReverse);
        newBalance = 0;
        status = totalPaid > 0 ? 'Paid' : 'Unpaid';
        updatedItems = buildDailyVariableItems(bill.dailyFeeLabel || DEFAULT_DAILY_FEE_LABEL, totalPaid);
      } else {
        totalPaid = Math.max(0, bill.totalPaid - amountToReverse);
        newBalance = bill.totalAmount - totalPaid;
        status = totalPaid === 0 ? 'Unpaid' : (newBalance <= 0 ? 'Paid' : 'Partial');

        // 💰 Apply reverse logic to fixed bill items by redistributing the new totalPaid
        let remainingPaid = totalPaid;
        updatedItems = bill.items.map(item => {
          const itemAmount = item.amount;
          const paidForItem = Math.min(remainingPaid, itemAmount);
          remainingPaid = Math.max(0, remainingPaid - paidForItem);
          return {
            ...item.toObject(),
            paid: paidForItem,
            balance: itemAmount - paidForItem
          };
        });
      }

      // 🧾 Update bill: remove payment from array and update numbers
      await TermBill.findByIdAndUpdate(
        billId,
        {
          items: updatedItems,
          totalPaid,
          balance: newBalance,
          status,
          $pull: {
            payments: { _id: paymentId }
          }
        },
        { session }
      );

      // Delete payment record
      await Payment.findByIdAndDelete(paymentId).session(session);

      // 🔄 Re-fetch populated + lean
      const updatedBill = await TermBill.findById(billId)
        .populate({
          path: 'student',
          populate: [
            { path: 'user', select: 'name' },
            { path: 'class', select: 'name stream displayName' }
          ]
        })
        .populate('class', 'name stream displayName')
        .populate('template', 'name')
        .session(session)
        .lean();

      await session.commitTransaction();
      transactionCommitted = true;

      // 🟦 Use EXISTING resolver
      const { className, classDisplayName } = resolveClassNames(
        updatedBill.class || updatedBill.student?.class
      );

      const previousArrearsMap = await buildPreviousArrearsMap({
        schoolId: req.user.school,
        studentIds: [updatedBill.student?._id || bill.student],
        currentTerm: updatedBill.term || bill.term,
        currentAcademicYear: updatedBill.academicYear || bill.academicYear
      });

      const responseData = attachPreviousArrears({
        ...transformBill(updatedBill),
        student: {
          _id: updatedBill.student?._id,
          name: updatedBill.student?.user?.name || 'N/A'
        },
        class: {
          _id: updatedBill.class?._id || null,
          name: className,
          displayName: classDisplayName
        },
        items: updatedBill.items.map(item => ({
          _id: item._id,
          name: item.name,
          amount: item.amount,
          paid: item.paid,
          balance: item.balance,
          isVariable: item.isVariable === true
        })),
        payments: updatedBill.payments.map(p => ({
          _id: p._id,
          amount: p.amount,
          method: p.method,
          billingMode: p.billingMode || billingMode,
          note: p.note || '',
          date: p.date
        }))
      }, previousArrearsMap, updatedBill.student?._id || bill.student);

      res.status(200).json({
        success: true,
        message: 'Payment reversed successfully',
        updatedBill: responseData
      });

    } catch (error) {
      if (!transactionCommitted && session.inTransaction()) {
        await session.abortTransaction();
      }

      console.error('Payment reversal error:', error);

      const statusCode = error.message.includes('not found') ? 404 : 400;
      res.status(statusCode).json({
        message: error.message || 'Error reversing payment',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      await session.endSession();
    }
  },
  async updateOrCreateBill(req, res) {
    const session = await mongoose.startSession();
    let committed = false;

    try {
      await session.startTransaction();

      if (!req.user?.school) {
        throw new Error('Unauthorized');
      }

      const { studentId, templateId, items, term, academicYear, billId } = req.body;

      if (!studentId || !templateId || !Array.isArray(items) || !term || !academicYear) {
        throw new Error('Missing required fields');
      }

      const student = await Student.findOne({
        _id: studentId,
        school: req.user.school
      })
        .populate({ path: 'user', select: 'name' })
        .populate('class', 'name stream displayName')
        .session(session);

      if (!student) throw new Error('Student not found');

      const template = await FeeTemplate.findOne({
        _id: templateId,
        school: req.user.school
      }).session(session);

      if (!template) throw new Error('Fee template not found');

      const totalAmount = items.reduce((s, i) => s + i.amount, 0);
      const totalPaid = items.reduce((s, i) => s + (i.paid || 0), 0);

      const status =
        totalPaid >= totalAmount ? 'Paid' : totalPaid > 0 ? 'Partial' : 'Unpaid';

      const billItems = items.map(item => ({
        name: item.name,
        amount: item.amount,
        paid: item.paid || 0,
        balance: item.amount - (item.paid || 0)
      }));

      let bill;

      if (billId) {
        bill = await TermBill.findByIdAndUpdate(
          billId,
          {
            items: billItems,
            totalAmount,
            totalPaid,
            balance: Math.max(0, totalAmount - totalPaid),
            status,
            class: student.class?._id || null,
            billingMode: FIXED_BILLING_MODE,
            isManualUpdate: true
          },
          { new: true, session }
        );
      } else {
        const newBill = await TermBill.create(
          [{
            school: req.user.school,
            student: student._id,
            class: student.class?._id || null,
            template: template._id,
            items: billItems,
            totalAmount,
            totalPaid,
            balance: Math.max(0, totalAmount - totalPaid),
            term,
            academicYear,
            status,
            billingMode: FIXED_BILLING_MODE,
            isManualUpdate: true
          }],
          { session }
        );

        bill = newBill[0];
      }

      bill = await TermBill.findById(bill._id)
        .populate({
          path: 'student',
          populate: [
            { path: 'user', select: 'name' },
            { path: 'class', select: 'name stream displayName' }
          ]
        })
        .populate('class', 'name stream displayName')
        .populate('template', 'name')
        .session(session)
        .lean();

      // ✅ USE EXISTING resolver (NO safeResolveClassNames)
      const { className, classDisplayName } = resolveClassNames(
        bill.class || student.class
      );

      const responseBill = {
        ...transformBill(bill),
        student: {
          _id: student._id,
          name: student.user?.name || 'N/A'
        },
        class: {
          _id: bill.class?._id || student.class?._id || null,
          name: className,
          displayName: classDisplayName
        }
      };

      await session.commitTransaction();
      committed = true;

      // 🔔 Send Push Notification for Statement
      try {
        const notificationController = require('../controllers/notificationController');
        const amountFormatted = typeof formatCurrency === 'function' ? formatCurrency(totalAmount) : `GHS ${totalAmount}`;

        // Student push
        if (student.user?._id) {
          await notificationController.sendPushToUser(
            student.user._id,
            'New Fee Statement',
            `Your fee statement for Term ${term} has been posted. Total: ${amountFormatted}`,
            { type: 'bill', billId: bill._id }
          ).catch(e => console.error("Student bill push failed:", e));
        }

        // Parent push
        if (student.parentIds && student.parentIds.length > 0) {
          const parentTokens = student.parentIds.filter(Boolean);
          if (parentTokens.length > 0) {
            const studentName = student.user?.name || student.name || "your child";
            await notificationController.sendPushNotifications(
              parentTokens,
              'New Fee Statement',
              `A fee statement for ${studentName} (Term ${term}) has been posted. Total: ${amountFormatted}`,
              { type: 'bill', billId: bill._id }
            ).catch(e => console.error("Parent bill push failed:", e));
          }
        }
      } catch (pushErr) {
        console.error('Push notification error in updateOrCreateBill:', pushErr);
      }

      const previousArrearsMap = await buildPreviousArrearsMap({
        schoolId: req.user.school,
        studentIds: [student._id],
        currentTerm: term,
        currentAcademicYear: academicYear
      });
      const responseBillWithArrears = attachPreviousArrears(
        responseBill,
        previousArrearsMap,
        student._id
      );

      res.status(billId ? 200 : 201).json({
        success: true,
        bill: responseBillWithArrears
      });

    } catch (error) {
      if (!committed && session.inTransaction()) {
        await session.abortTransaction();
      }

      console.error('❌ updateOrCreateBill:', error);

      res.status(500).json({
        message: 'Error processing bill',
        error: error.message
      });
    } finally {
      await session.endSession();
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

      const previousArrearsMapsByPeriod = new Map();
      for (const bill of bills) {
        const periodKey = `${bill.term || ''}__${bill.academicYear || ''}`;
        if (!previousArrearsMapsByPeriod.has(periodKey)) {
          previousArrearsMapsByPeriod.set(
            periodKey,
            await buildPreviousArrearsMap({
              schoolId: user.school,
              studentIds,
              currentTerm: bill.term,
              currentAcademicYear: bill.academicYear
            })
          );
        }
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
        const billingMode = normalizeBillingMode(transformed.billingMode || transformed.student?.termFeeBillingMode);
        const isDailyVariable = isDailyVariableMode(billingMode);
        const effectivePaidAmount = isDailyVariable ? transformed.totalPaid : paidAmount;
        const balance = isDailyVariable ? 0 : totalAmount - effectivePaidAmount;

        let paymentStatus;
        if (isDailyVariable) paymentStatus = "Daily Payer";
        else if (balance <= 0) paymentStatus = "Paid";
        else if (effectivePaidAmount > 0) paymentStatus = "Partial";
        else paymentStatus = "Unpaid";

        // 🟦 STEP 6 — UPDATED getStudentBills
        const { className, classDisplayName } = resolveClassNames(
          transformed.student?.class || transformed.class
        );

        const responseBill = {
          ...transformed,
          studentName:
            transformed.student?.user?.name ||
            transformed.student?.name ||
            "Unknown",
          className,
          classDisplayName,
          studentId: transformed.student?._id?.toString(),
          totalAmount,
          totalPaid: effectivePaidAmount,
          paidAmount: effectivePaidAmount,
          balance,
          formattedTotal: formatCurrency(totalAmount),
          formattedPaid: formatCurrency(effectivePaidAmount),
          formattedBalance: formatCurrency(balance),
          paymentStatus,
          billingMode,
          dailyFeeLabel: transformed.dailyFeeLabel || DEFAULT_DAILY_FEE_LABEL,
          isDailyVariable,
          isExempt: !!transformed.student?.isExemptFromTermFees,
          lastPayment:
            payments.length > 0
              ? payments[payments.length - 1].paymentDate
              : null,
        };

        const periodKey = `${bill.term || ''}__${bill.academicYear || ''}`;
        return attachPreviousArrears(
          responseBill,
          previousArrearsMapsByPeriod.get(periodKey),
          transformed.student?._id
        );
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
          doc.image(schoolInfo.logo, 250, 30, {
            fit: [40, 40],
            align: 'center',
            valign: 'center',
          });
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
          doc.image(schoolInfo.logo, 250, 30, {
            fit: [40, 40],
            align: 'center',
            valign: 'center',
          });
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
        transformed.student?.class
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
  },

  // Get daily term billing audit report
  async getTermBillingAuditReport(req, res) {
    try {
      const { date, term, academicYear } = req.query;
      const schoolId = req.user.school;

      if (!date) {
        return res.status(400).json({ success: false, message: 'Date is required' });
      }

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      // Fetch payments for the given day
      const paymentQuery = {
        school: schoolId,
        paymentDate: { $gte: startOfDay, $lte: endOfDay }
      };

      if (term) paymentQuery.term = term.trim();
      if (academicYear) paymentQuery.academicYear = academicYear.trim();

      const payments = await Payment.find(paymentQuery)
        .populate({
          path: 'student',
          populate: [
            { path: 'user', select: 'name' },
            { path: 'class', select: 'name stream displayName' }
          ]
        })
        .populate('recordedBy', 'name')
        .lean();

      const dailyTotalsQuery = { school: schoolId };
      if (term) dailyTotalsQuery.term = term.trim();
      if (academicYear) dailyTotalsQuery.academicYear = academicYear.trim();

      const termPayments = await Payment.find(dailyTotalsQuery)
        .select('amount paymentDate')
        .sort({ paymentDate: 1 })
        .lean();

      const dailyTotalsMap = new Map();
      termPayments.forEach(payment => {
        const paymentDate = new Date(payment.paymentDate);
        const paymentDateKey = paymentDate.toISOString().slice(0, 10);
        const current = dailyTotalsMap.get(paymentDateKey) || {
          date: paymentDateKey,
          totalAmount: 0,
          paidCount: 0
        };

        current.totalAmount += Number(payment.amount) || 0;
        current.paidCount += 1;
        dailyTotalsMap.set(paymentDateKey, current);
      });

      const dailyTotals = Array.from(dailyTotalsMap.values());
      const termGrandTotal = dailyTotals.reduce((sum, day) => sum + day.totalAmount, 0);

      let grandTotal = 0;
      let totalPaid = payments.length;
      const auditReport = [];
      const classMap = new Map();

      // Group payments by class
      for (const payment of payments) {
        const student = payment.student;
        if (!student) continue;

        const { className, classDisplayName } = resolveClassNames(student.class);
        const classId = student.class?._id?.toString() || 'unassigned';
        const display = classDisplayName || className;

        if (!classMap.has(classId)) {
          classMap.set(classId, {
            classId,
            className: display,
            totalAmount: 0,
            paidCount: 0,
            students: []
          });
        }

        const classData = classMap.get(classId);
        const amount = Number(payment.amount) || 0;

        classData.totalAmount += amount;
        classData.paidCount += 1;
        grandTotal += amount;

        const studentName = student.user?.name || student.name || student.admissionNumber || 'Unknown Student';

        classData.students.push({
          studentId: student._id,
          studentName,
          amount,
          method: payment.method || 'Cash',
          status: 'paid',
          time: new Date(payment.paymentDate).toLocaleTimeString()
        });
      }

      classMap.forEach(classData => {
        classData.students.sort((a, b) => a.studentName.localeCompare(b.studentName));
        auditReport.push(classData);
      });

      auditReport.sort((a, b) => a.className.localeCompare(b.className));

      res.json({
        success: true,
        date,
        term: term?.trim(),
        academicYear: academicYear?.trim(),
        grandTotal,
        totalPaid,
        dailyTotals,
        termGrandTotal,
        report: auditReport
      });

    } catch (error) {
      console.error('Term billing audit report error:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching audit report',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  async toggleTermFeeExemption(req, res) {
    try {
      if (!req.user || !req.user.school) {
        return res.status(403).json({ message: 'Unauthorized' });
      }

      const { studentId } = req.params;
      const student = await Student.findOne({ _id: studentId, school: req.user.school });

      if (!student) {
        return res.status(404).json({ message: 'Student not found' });
      }

      student.isExemptFromTermFees = !student.isExemptFromTermFees;
      await student.save();

      res.json({
        success: true,
        isExemptFromTermFees: student.isExemptFromTermFees,
        message: `Student is now ${student.isExemptFromTermFees ? 'exempt from' : 'liable for'} term fees`
      });

    } catch (error) {
      console.error('Toggle Term Fee Exemption Error:', error);
      res.status(500).json({ message: 'Failed to toggle exemption status' });
    }
  },

  async setTermFeeBillingMode(req, res) {
    try {
      if (!req.user || !req.user.school) {
        return res.status(403).json({ message: 'Unauthorized' });
      }

      const { studentId } = req.params;
      const { billingMode, term, academicYear, templateId } = req.body;
      const mode = normalizeBillingMode(billingMode);

      const student = await Student.findOne({ _id: studentId, school: req.user.school })
        .populate('class', 'name stream displayName')
        .populate('user', 'name');

      if (!student) {
        return res.status(404).json({ message: 'Student not found' });
      }

      student.termFeeBillingMode = mode;
      await student.save();

      let bill = null;
      const cleanTerm = term?.trim();
      const cleanAcademicYear = academicYear?.trim();

      if (cleanTerm && cleanAcademicYear) {
        bill = await TermBill.findOne({
          student: student._id,
          term: cleanTerm,
          academicYear: cleanAcademicYear,
          school: req.user.school
        });

        if (isDailyVariableMode(mode)) {
          const paidToPreserve = bill
            ? (isDailyVariableMode(bill.billingMode)
              ? Number(bill.totalPaid ?? bill.totalAmount) || 0
              : Number(bill.totalPaid) || 0)
            : 0;

          const dailyBillPayload = {
            school: req.user.school,
            student: student._id,
            class: student.class?._id || student.class || null,
            template: templateId || bill?.template || undefined,
            term: cleanTerm,
            academicYear: cleanAcademicYear,
            billingMode: DAILY_VARIABLE_BILLING_MODE,
            dailyFeeLabel: DEFAULT_DAILY_FEE_LABEL,
            items: buildDailyVariableItems(DEFAULT_DAILY_FEE_LABEL, paidToPreserve),
            totalAmount: paidToPreserve,
            totalPaid: paidToPreserve,
            balance: 0,
            status: paidToPreserve > 0 ? 'Paid' : 'Pending',
            isManualUpdate: false
          };

          bill = bill
            ? await TermBill.findByIdAndUpdate(bill._id, dailyBillPayload, { new: true })
            : await TermBill.create(dailyBillPayload);
        } else if (bill && isDailyVariableMode(bill.billingMode) && templateId) {
          const template = await FeeTemplate.findOne({ _id: templateId, school: req.user.school });
          if (template) {
            const total = template.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
            
            // Distribute existing payments across the new template items
            let remainingPaid = Number(bill.totalPaid) || 0;
            const newItems = template.items.map(item => {
              const amt = Number(item.amount) || 0;
              let itemPaid = 0;
              if (remainingPaid > 0) {
                itemPaid = Math.min(amt, remainingPaid);
                remainingPaid -= itemPaid;
              }
              return {
                name: item.name,
                amount: amt,
                paid: itemPaid,
                balance: amt - itemPaid,
                isVariable: false
              };
            });

            const currentPaid = Number(bill.totalPaid) || 0;
            const newBalance = Math.max(0, total - currentPaid);

            bill = await TermBill.findByIdAndUpdate(
              bill._id,
              {
                template: template._id,
                billingMode: FIXED_BILLING_MODE,
                items: newItems,
                totalAmount: total,
                totalPaid: currentPaid,
                balance: newBalance,
                status: currentPaid >= total ? 'Paid' : (currentPaid > 0 ? 'Partial' : 'Unpaid'),
                isManualUpdate: false
              },
              { new: true }
            );
          }
        }
      }

      const populatedBill = bill
        ? await TermBill.findById(bill._id)
          .populate({
            path: 'student',
            populate: [
              { path: 'user', select: 'name' },
              { path: 'class', select: 'name stream displayName' }
            ]
          })
          .populate('class', 'name stream displayName')
          .populate('template', 'name')
          .lean()
        : null;

      res.json({
        success: true,
        billingMode: mode,
        termFeeBillingMode: student.termFeeBillingMode,
        bill: populatedBill ? transformBill(populatedBill) : null,
        message: `Student billing mode set to ${isDailyVariableMode(mode) ? 'daily variable' : 'fixed'}`
      });

    } catch (error) {
      console.error('Set Term Fee Billing Mode Error:', error);
      res.status(500).json({ message: 'Failed to update billing mode', error: error.message });
    }
  }
};
