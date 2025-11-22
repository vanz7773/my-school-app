// utils/feeUtils.js
const currency = require('currency-formatter');

/**
 * Transforms raw bill data into a standardized format
 * Optimized for performance with minimal operations
 */
exports.transformBill = (bill) => {
  // Handle Mongoose documents and plain objects
  const billData = bill._doc ? bill._doc : bill;
  
  // Fast number transformation
  const transformNumber = (value) => {
    if (value == null) return 0;
    if (typeof value === 'object') {
      return value.$numberInt ? parseInt(value.$numberInt, 10) : 
             value.$numberDouble ? parseFloat(value.$numberDouble) : 0;
    }
    return typeof value === 'number' ? value : 0;
  };

  // Efficient student name extraction
  const getStudentName = (student) => {
    if (!student) return 'Unknown';
    if (typeof student === 'object') {
      return student.user?.name || student.name || student.admissionNumber || 'Unknown';
    }
    return 'Unknown';
  };

  // Process items in bulk
  const items = (billData.items || []).map(item => ({
    ...item,
    amount: transformNumber(item.amount),
    paid: transformNumber(item.paid),
    balance: transformNumber(item.balance)
  }));

  // Calculate totals once
  const totalAmount = transformNumber(billData.totalAmount);
  const totalPaid = transformNumber(billData.totalPaid);
  const balance = totalAmount - totalPaid;

  // Determine student information
  const student = typeof billData.student === 'object' 
    ? { 
        ...billData.student, 
        name: getStudentName(billData.student) 
      }
    : { _id: billData.student };

  // Determine class information
  const classInfo = typeof billData.class === 'object'
    ? billData.class
    : { _id: billData.class };

  return {
    ...billData,
    items,
    totalAmount,
    totalPaid,
    balance,
    student,
    class: {
      ...classInfo,
      name: classInfo.name || student.class?.name || 'Unassigned'
    },
    paymentStatus: balance <= 0 ? 'Paid' : totalPaid > 0 ? 'Partial' : 'Unpaid'
  };
};

/**
 * Formats currency with error protection
 * Optimized for GHS (Ghanaian Cedi) with fallback
 */
exports.formatCurrency = (amount) => {
  try {
    return currency.format(Number(amount) || 0, { 
      code: 'GHS',
      precision: 2,
      thousand: ',',
      decimal: '.',
      format: '%s %v'  // Format: "₵ 1,234.56"
    });
  } catch (e) {
    return '₵ 0.00';
  }
};

/**
 * Prepares bill data for API responses
 * Combines transformation with currency formatting
 */
exports.prepareBillResponse = (bill) => {
  const transformed = exports.transformBill(bill);
  return {
    ...transformed,
    formattedTotal: exports.formatCurrency(transformed.totalAmount),
    formattedPaid: exports.formatCurrency(transformed.totalPaid),
    formattedBalance: exports.formatCurrency(transformed.balance)
  };
};

/**
 * Fast student name resolver for bulk operations
 */
exports.resolveStudentName = (student) => {
  if (!student) return 'Unknown';
  return student.user?.name || student.name || student.admissionNumber || 'Unknown';
};

/**
 * Efficient class name resolver
 */
exports.resolveClassName = (classInfo) => {
  return classInfo?.name || 'Unassigned';
};

/**
 * Bulk transform bills with optimized iteration
 */
exports.transformBills = (bills) => {
  const transformed = new Array(bills.length);
  for (let i = 0; i < bills.length; i++) {
    transformed[i] = exports.transformBill(bills[i]);
  }
  return transformed;
};