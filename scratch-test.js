const WEEK_DAY_KEYS = ['M', 'T', 'W', 'TH', 'F'];

const isSameCalendarDay = (left, right) => {
  if (!left || !right) return false;
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return (
    leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
  );
};

const getAccountedAmountForDay = (entry, targetDay, targetDate, amountPerDay = 0) => {
  const fallbackAmount = Number(entry?.perDayFee?.[targetDay]) || 0;
  const resolvedAmount = Number(amountPerDay) > 0 ? Number(amountPerDay) : fallbackAmount;
  
  if (resolvedAmount <= 0) return 0; // Quick exit safety
  
  let amountForTargetDay = 0;

  for (const dayKey of WEEK_DAY_KEYS) {
    // Only process days that are actually paid
    const isPaidDay = entry?.days?.[dayKey] === 'present';
    if (!isPaidDay) continue;

    const paidAt = entry.paidAt?.[dayKey];

    // Case 1: No timestamp tracking (e.g. from Student Attendance page or legacy records)
    if (!paidAt) {
      if (targetDay === dayKey) {
        amountForTargetDay += resolvedAmount;
      }
      continue;
    }

    // Case 2: Timestamp tracked. Does it physically map to this target targetDate?
    let matchesTarget = isSameCalendarDay(paidAt, targetDate);

    // Weekend Roll-over rule -> Map to Monday if adjacent
    if (!matchesTarget && targetDay === 'M') {
      const paymentDay = new Date(paidAt).getDay();
      if (paymentDay === 0 || paymentDay === 6) {
        const diffDays = Math.abs(new Date(paidAt) - new Date(targetDate)) / 86400000;
        if (diffDays <= 3) {
          matchesTarget = true;
        }
      }
    }

    // Out-of-bounds safety rule -> Keep on its indigenous feeding day if outside current visible week
    if (!matchesTarget) {
      const diffDays = Math.abs(new Date(paidAt) - new Date(targetDate)) / 86400000;
      if (diffDays > 6 && targetDay === dayKey) {
        matchesTarget = true;
      }
    }

    if (matchesTarget) {
      amountForTargetDay += resolvedAmount;
    }
  }

  return amountForTargetDay;
};

// SIMULATE
const amountPerDay = 15;
// Target Date: April 13, 2026 (Monday)
const mondayDate = new Date('2026-04-13T10:00:00.000Z');

// Scenario: Teacher marked Monday from Attendance Page (paidAt = null)
// Teacher marked Tue, Wed, Thu, Fri from Feeding Page ON Monday (paidAt = Monday)

const entry = {
  days: { M: 'present', T: 'present', W: 'present', TH: 'present', F: 'present' },
  paidAt: { 
    M: null, 
    T: mondayDate, 
    W: mondayDate, 
    TH: mondayDate, 
    F: mondayDate 
  },
  perDayFee: { M: 0, T: 0, W: 0, TH: 0, F: 0 }
};

console.log("Monday Report:", getAccountedAmountForDay(entry, 'M', mondayDate, amountPerDay));

// Target Date: April 14, 2026 (Tuesday)
const tuesdayDate = new Date('2026-04-14T10:00:00.000Z');
console.log("Tuesday Report:", getAccountedAmountForDay(entry, 'T', tuesdayDate, amountPerDay));

