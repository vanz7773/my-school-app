function isWeekend(date) {
  const day = new Date(date).getDay();
  return day === 0 || day === 6; // Sunday (0) or Saturday (6)
}

module.exports = {
  isWeekend,
  formatDate: (date) => {
    return new Date(date).toLocaleDateString('en-US', { 
      weekday: 'short', 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  }
};