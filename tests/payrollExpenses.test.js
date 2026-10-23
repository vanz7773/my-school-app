const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');
const SchoolExpense = require('../models/SchoolExpense');
const Feeding = require('../models/FeedingFeeRecord');
const Term = require('../models/term');
const { Payment } = require('../models/allModels');
const { buildPayrollExpense, getPayrollExpenses } = require('../services/payrollExpenses');
const controller = require('../controllers/expenseProfitController');
const id = () => new mongoose.Types.ObjectId();
const batch = () => ({ _id: id(), month: '2026-10', paidAt: new Date('2026-11-02T12:00:00Z'),
  paidBy: { name: 'Admin' }, totalGross: 3000, totalDeductions: 300, totalNet: 2700,
  payslips: [{ _id: id(), teacherName: 'Ama', grossSalary: 2000, totalDeductions: 200, netSalary: 1800 },
    { _id: id(), teacherName: 'Cook', employeeModel: 'PayrollStaff', grossSalary: 1000, totalDeductions: 100, netSalary: 900 }] });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('paid payroll produces one net expense with staff breakdown and stable identity', () => {
  const payroll = batch();
  const expense = buildPayrollExpense(payroll);
  assert.equal(expense.amount, 2700);
  assert.equal(expense.expenseDate, payroll.paidAt);
  assert.match(expense.title, /OCTOBER 2026/);
  assert.equal(expense.payrollDetails.totalDeductions, 300);
  assert.deepEqual(expense.payrollDetails.staff.map(s => s.staffType), ['Teacher', 'Non-Teaching']);
  assert.equal(buildPayrollExpense(payroll)._id, expense._id);
  assert.equal(expense.payrollDetails.staff[1].netSalary, 900);
  assert.equal(expense.payrollDetails.staff[0].accountDetails, undefined);
});

test('reports query paid payroll by school and payment date, not salary month', async () => {
  const original = Payroll.find;
  const schoolId = id(), startDate = new Date('2026-11-01'), endDate = new Date('2026-11-30');
  Payroll.find = filter => {
    assert.deepEqual(filter, { school: schoolId, status: 'Paid', paidAt: { $gte: startDate, $lte: endDate } });
    return { select() { return this; }, populate() { return this; }, lean: async () => [batch()] };
  };
  try { assert.equal((await getPayrollExpenses({ schoolId, startDate, endDate })).length, 1); }
  finally { Payroll.find = original; }
});

test('expense totals and profit include payroll net once while exposing deductions separately', async () => {
  const originals = [Payroll.find, SchoolExpense.find, Feeding.find, Term.find, Payment.aggregate];
  const payroll = batch();
  Payroll.find = () => ({ select() { return this; }, populate() { return this; }, lean: async () => [payroll] });
  SchoolExpense.find = () => ({ populate() { return this; }, sort() { return this; }, lean: async () => [{ _id: id(), title: 'Supplies', amount: 100, category: 'General', expenseDate: new Date('2026-11-02') }] });
  Feeding.find = Term.find = () => ({ lean: async () => [] });
  Payment.aggregate = async () => [{ total: 5000, count: 1 }];
  try {
    for (let n = 0; n < 2; n++) {
      const res = response();
      await controller.getExpenseProfitSummary({ user: { school: id() }, query: { periodType: 'monthly', month: '11', year: '2026' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.expenses.total, 2800);
      assert.equal(res.body.expenses.count, 2);
      assert.equal(res.body.profit, 2200);
      assert.equal(res.body.expenses.records.filter(e => e.source === 'payroll').length, 1);
      assert.equal(res.body.expenses.byCategory.find(e => e.category === 'Salaries').amount, 2700);
    }
  } finally { [Payroll.find, SchoolExpense.find, Feeding.find, Term.find, Payment.aggregate] = originals; }
});

test('linked payroll expenses cannot be edited or deleted through manual expense routes', async () => {
  for (const action of [controller.updateExpense, controller.deleteExpense]) {
    const res = response();
    await action({ params: { id: `payroll-${id()}` }, user: { school: id() }, body: { amount: 1 } }, res);
    assert.equal(res.statusCode, 403);
  }
});
