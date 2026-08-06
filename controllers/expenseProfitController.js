const mongoose = require('mongoose');
const SchoolExpense = require('../models/SchoolExpense');
const FeedingFeeRecord = require('../models/FeedingFeeRecord');
const Term = require('../models/term');
const { Payment } = require('../models/allModels');

const DAY_KEYS = ['M', 'T', 'W', 'TH', 'F'];
const DAY_OFFSETS = { M: 0, T: 1, W: 2, TH: 3, F: 4 };

const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const normalizeWeek = (week) => {
  const parsed = parseInt(String(week || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const normalizeMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

const getSchoolId = (req) => req.user?.school;

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const serializeUser = (user) => {
  if (!user) return null;
  if (typeof user !== 'object' || user instanceof mongoose.Types.ObjectId) return user;

  const name = user.name || [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    _id: user._id,
    name: name || '',
    email: user.email || '',
    role: user.role || '',
  };
};

const serializeExpense = (expense) => ({
  _id: expense._id,
  title: expense.title,
  category: expense.category,
  amount: normalizeMoney(expense.amount),
  expenseDate: expense.expenseDate,
  periodType: expense.periodType,
  paymentMethod: expense.paymentMethod,
  vendor: expense.vendor || '',
  notes: expense.notes || '',
  termId: expense.termId || null,
  week: expense.week || null,
  recordedBy: serializeUser(expense.recordedBy),
  updatedBy: serializeUser(expense.updatedBy),
  createdAt: expense.createdAt,
  updatedAt: expense.updatedAt,
});

const getTermWeekRange = (term, weekNumber) => {
  const termStart = startOfDay(term.startDate);
  const termEnd = endOfDay(term.endDate);
  let currentStart = new Date(termStart);
  let currentWeek = 1;

  while (currentWeek < weekNumber && currentStart <= termEnd) {
    const dayOfWeek = currentStart.getDay();
    const daysToFriday = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 6 : 5 - dayOfWeek;
    const friday = addDays(currentStart, daysToFriday);
    currentStart = startOfDay(addDays(friday, 3));
    currentWeek += 1;
  }

  const dayOfWeek = currentStart.getDay();
  const daysToFriday = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 6 : 5 - dayOfWeek;
  const weekEnd = endOfDay(addDays(currentStart, daysToFriday));

  return {
    startDate: currentStart < termStart ? termStart : currentStart,
    endDate: weekEnd > termEnd ? termEnd : weekEnd,
  };
};

const getWeekDayDate = (term, week, dayKey) => {
  const { startDate } = getTermWeekRange(term, week);
  return startOfDay(addDays(startDate, DAY_OFFSETS[dayKey] || 0));
};

const resolvePeriodRange = async (req) => {
  const schoolId = getSchoolId(req);
  const periodType = String(req.query.periodType || 'weekly').toLowerCase();
  const termId = req.query.termId;
  const week = normalizeWeek(req.query.week);
  const month = Number(req.query.month);
  const year = Number(req.query.year);

  if (req.query.startDate && req.query.endDate) {
    return {
      periodType,
      term: termId && isObjectId(termId)
        ? await Term.findOne({ _id: termId, school: schoolId }).lean()
        : null,
      week,
      startDate: startOfDay(req.query.startDate),
      endDate: endOfDay(req.query.endDate),
    };
  }

  if (periodType === 'termly') {
    if (!termId || !isObjectId(termId)) {
      const err = new Error('Please select a valid term.');
      err.statusCode = 400;
      throw err;
    }

    const term = await Term.findOne({ _id: termId, school: schoolId }).lean();
    if (!term) {
      const err = new Error('Term not found.');
      err.statusCode = 404;
      throw err;
    }

    return {
      periodType,
      term,
      week: null,
      startDate: startOfDay(term.startDate),
      endDate: endOfDay(term.endDate),
    };
  }

  if (periodType === 'monthly') {
    if (!month || !year) {
      const err = new Error('Please select a valid month and year.');
      err.statusCode = 400;
      throw err;
    }

    return {
      periodType,
      term: termId && isObjectId(termId)
        ? await Term.findOne({ _id: termId, school: schoolId }).lean()
        : null,
      week: null,
      startDate: startOfDay(new Date(year, month - 1, 1)),
      endDate: endOfDay(new Date(year, month, 0)),
    };
  }

  if (!termId || !isObjectId(termId)) {
    const err = new Error('Please select a valid term for the week.');
    err.statusCode = 400;
    throw err;
  }

  const term = await Term.findOne({ _id: termId, school: schoolId }).lean();
  if (!term) {
    const err = new Error('Term not found.');
    err.statusCode = 404;
    throw err;
  }

  const range = getTermWeekRange(term, week);
  return {
    periodType: 'weekly',
    term,
    week,
    startDate: range.startDate,
    endDate: range.endDate,
  };
};

const getPaymentSummary = async ({ schoolId, startDate, endDate }) => {
  const [summary] = await Payment.aggregate([
    {
      $match: {
        school: new mongoose.Types.ObjectId(String(schoolId)),
        paymentDate: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    total: normalizeMoney(summary?.total),
    count: Number(summary?.count) || 0,
  };
};

const getFeedingIncomeSummary = async ({ schoolId, term, startDate, endDate }) => {
  const query = {
    school: schoolId,
  };

  if (term?._id) {
    query.termId = term._id;
  }

  const records = await FeedingFeeRecord.find(query).lean();
  const termIds = [...new Set(records.map((record) => String(record.termId)).filter(Boolean))];
  const termDocs = await Term.find({ _id: { $in: termIds } }).lean();
  const termMap = new Map(termDocs.map((termDoc) => [String(termDoc._id), termDoc]));

  let total = 0;
  let count = 0;

  records.forEach((record) => {
    const recordTerm = termMap.get(String(record.termId));

    (record.breakdown || []).forEach((entry) => {
      DAY_KEYS.forEach((dayKey) => {
        if (entry.days?.[dayKey] !== 'present') return;

        const paidAt = entry.paidAt?.[dayKey] ? new Date(entry.paidAt[dayKey]) : null;
        const fallbackDate = recordTerm ? getWeekDayDate(recordTerm, record.week, dayKey) : null;
        const collectionDate = paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : fallbackDate;

        if (!collectionDate || collectionDate < startDate || collectionDate > endDate) return;

        total += normalizeMoney(entry.perDayFee?.[dayKey] || entry.classFeeAmount || record.classFeeAmount);
        count += 1;
      });
    });
  });

  return { total, count };
};

const getExpenseSummary = async ({ schoolId, startDate, endDate }) => {
  const expenses = await SchoolExpense.find({
    school: schoolId,
    expenseDate: { $gte: startDate, $lte: endDate },
  })
    .populate('recordedBy updatedBy', 'name firstName lastName email role')
    .sort({ expenseDate: -1, createdAt: -1 })
    .lean();

  const total = expenses.reduce((sum, expense) => sum + normalizeMoney(expense.amount), 0);
  const byCategory = expenses.reduce((acc, expense) => {
    const category = expense.category || 'General';
    acc[category] = (acc[category] || 0) + normalizeMoney(expense.amount);
    return acc;
  }, {});

  return {
    expenses,
    total,
    count: expenses.length,
    byCategory: Object.entries(byCategory)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
};

exports.getExpenseProfitSummary = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const period = await resolvePeriodRange(req);
    const [schoolFees, feedingFees, expenses] = await Promise.all([
      getPaymentSummary({ schoolId, startDate: period.startDate, endDate: period.endDate }),
      getFeedingIncomeSummary({
        schoolId,
        term: period.term,
        startDate: period.startDate,
        endDate: period.endDate,
      }),
      getExpenseSummary({ schoolId, startDate: period.startDate, endDate: period.endDate }),
    ]);

    const totalIncome = schoolFees.total + feedingFees.total;
    const totalExpenses = expenses.total;

    res.json({
      success: true,
      period: {
        type: period.periodType,
        week: period.week,
        startDate: period.startDate,
        endDate: period.endDate,
        term: period.term ? {
          _id: period.term._id,
          term: period.term.term,
          academicYear: period.term.academicYear,
          startDate: period.term.startDate,
          endDate: period.term.endDate,
        } : null,
      },
      income: {
        schoolFees: schoolFees.total,
        feedingFees: feedingFees.total,
        total: totalIncome,
        schoolFeePayments: schoolFees.count,
        feedingPaidDays: feedingFees.count,
      },
      expenses: {
        total: totalExpenses,
        count: expenses.count,
        byCategory: expenses.byCategory,
        records: expenses.expenses.map(serializeExpense),
      },
      profit: totalIncome - totalExpenses,
    });
  } catch (error) {
    console.error('getExpenseProfitSummary error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to load expense and profit summary.',
    });
  }
};

exports.createExpense = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const {
      title,
      category = 'General',
      amount,
      expenseDate,
      periodType = 'weekly',
      paymentMethod = 'Cash',
      vendor = '',
      notes = '',
      termId = null,
      week = null,
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: 'Expense title is required.' });
    }

    const parsedAmount = normalizeMoney(amount);
    if (parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Expense amount must be greater than zero.' });
    }

    const parsedDate = expenseDate ? new Date(expenseDate) : new Date();
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Expense date is invalid.' });
    }

    const expense = await SchoolExpense.create({
      school: schoolId,
      title: String(title).trim(),
      category: String(category || 'General').trim(),
      amount: parsedAmount,
      expenseDate: parsedDate,
      periodType,
      paymentMethod,
      vendor: String(vendor || '').trim(),
      notes: String(notes || '').trim(),
      termId: termId && isObjectId(termId) ? termId : null,
      week: week ? normalizeWeek(week) : null,
      recordedBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: 'Expense recorded successfully.',
      expense: serializeExpense(expense),
    });
  } catch (error) {
    console.error('createExpense error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record expense.',
    });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const { id } = req.params;

    const updates = {};
    ['title', 'category', 'paymentMethod', 'vendor', 'notes', 'periodType'].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    if (req.body.amount !== undefined) {
      const amount = normalizeMoney(req.body.amount);
      if (amount <= 0) {
        return res.status(400).json({ success: false, message: 'Expense amount must be greater than zero.' });
      }
      updates.amount = amount;
    }

    if (req.body.expenseDate !== undefined) {
      const date = new Date(req.body.expenseDate);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ success: false, message: 'Expense date is invalid.' });
      }
      updates.expenseDate = date;
    }

    if (req.body.termId !== undefined) {
      updates.termId = req.body.termId && isObjectId(req.body.termId) ? req.body.termId : null;
    }

    if (req.body.week !== undefined) {
      updates.week = req.body.week ? normalizeWeek(req.body.week) : null;
    }

    updates.updatedBy = req.user._id;

    const expense = await SchoolExpense.findOneAndUpdate(
      { _id: id, school: schoolId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found.' });
    }

    res.json({
      success: true,
      message: 'Expense updated successfully.',
      expense: serializeExpense(expense),
    });
  } catch (error) {
    console.error('updateExpense error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update expense.',
    });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const expense = await SchoolExpense.findOneAndDelete({
      _id: req.params.id,
      school: getSchoolId(req),
    });

    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found.' });
    }

    res.json({
      success: true,
      message: 'Expense deleted successfully.',
    });
  } catch (error) {
    console.error('deleteExpense error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete expense.',
    });
  }
};
