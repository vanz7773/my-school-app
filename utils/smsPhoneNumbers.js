const GHANA_MOBILE_PREFIXES = new Set([
  '20',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '50',
  '53',
  '54',
  '55',
  '56',
  '57',
  '59'
]);

// Format Ghana phone number to international format without + sign for Arkesel.
// Examples: 054xxxxxxx -> 23354xxxxxxx, +23354xxxxxxx -> 23354xxxxxxx
const formatPhoneNumber = (phone) => {
  if (!phone) return null;

  let formatted = String(phone).trim().replace(/\D/g, '');
  if (formatted.startsWith('00')) {
    formatted = formatted.substring(2);
  }
  if (formatted.startsWith('0') && formatted.length === 10) {
    formatted = `233${formatted.substring(1)}`;
  } else if (!formatted.startsWith('233') && formatted.length === 9) {
    formatted = `233${formatted}`;
  }

  if (!/^233\d{9}$/.test(formatted)) return null;

  const mobilePrefix = formatted.slice(3, 5);
  return GHANA_MOBILE_PREFIXES.has(mobilePrefix) ? formatted : null;
};

const normalizeRecipientsWithStats = (recipients) => {
  const rawRecipients = Array.isArray(recipients) ? recipients : [recipients];
  const formattedRecipients = [];
  const invalidRecipients = [];

  rawRecipients.forEach((recipient) => {
    const formatted = formatPhoneNumber(recipient);
    if (formatted) {
      formattedRecipients.push(formatted);
    } else if (recipient) {
      invalidRecipients.push(String(recipient).trim());
    }
  });

  return {
    formattedRecipients: [...new Set(formattedRecipients)],
    invalidRecipients: [...new Set(invalidRecipients)]
  };
};

const normalizeRecipients = (recipients) =>
  normalizeRecipientsWithStats(recipients).formattedRecipients;

module.exports = { formatPhoneNumber, normalizeRecipients, normalizeRecipientsWithStats };
