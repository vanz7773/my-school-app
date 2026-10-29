// Keep SMS dates in Ghana time regardless of the backend host's timezone.
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Accra'
});

function formatSmsDate(value) {
  const date = new Date(value);
  if (value == null || Number.isNaN(date.getTime())) {
    throw new Error('A valid date is required for the SMS message');
  }
  return dateFormatter.format(date);
}

module.exports = { formatSmsDate };
