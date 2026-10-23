const Payroll = require('../models/Payroll');

const buildPayrollExpense = payroll => {
  const [year, month] = payroll.month.split('-').map(Number);
  const period = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  }).toUpperCase();
  return {
    _id: `payroll-${payroll._id}`,
    source: 'payroll',
    title: `Salary Payments - ${period}`,
    category: 'Salaries',
    amount: payroll.totalNet || 0,
    expenseDate: payroll.paidAt,
    periodType: 'monthly',
    paymentMethod: 'Payroll',
    vendor: 'Teachers and non-teaching staff',
    notes: 'Net salaries paid through payroll. Deductions are shown for reference and are not included in this expense. Record deduction remittances separately when paid.',
    recordedBy: payroll.paidBy || payroll.approvedBy || payroll.generatedBy,
    createdAt: payroll.paidAt,
    updatedAt: payroll.paidAt,
    payrollDetails: {
      id: payroll._id,
      month: period,
      totalGross: payroll.totalGross || 0,
      totalDeductions: payroll.totalDeductions || 0,
      totalNet: payroll.totalNet || 0,
      staff: (payroll.payslips || []).map(slip => ({
        id: slip._id,
        name: slip.teacherName || 'Unknown',
        staffType: slip.employeeModel === 'PayrollStaff' ? 'Non-Teaching' : 'Teacher',
        grossSalary: slip.grossSalary || 0,
        deductions: slip.totalDeductions || 0,
        netSalary: slip.netSalary || 0,
      })),
    },
  };
};

const getPayrollExpenses = async ({ schoolId, startDate, endDate }) => {
  // Derive one expense per paid batch: no second write or backfill can duplicate it.
  const payrolls = await Payroll.find({
    school: schoolId, status: 'Paid', paidAt: { $gte: startDate, $lte: endDate },
  }).select('month paidAt paidBy approvedBy generatedBy totalGross totalDeductions totalNet payslips._id payslips.teacherName payslips.employeeModel payslips.grossSalary payslips.totalDeductions payslips.netSalary')
    .populate('paidBy approvedBy generatedBy', 'name email role').lean();
  return payrolls.map(buildPayrollExpense);
};

module.exports = { buildPayrollExpense, getPayrollExpenses };
