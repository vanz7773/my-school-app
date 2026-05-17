const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable');

console.log("autoTable type:", typeof autoTable);
console.log("autoTable default type:", typeof autoTable.default);
console.log("autoTable object:", autoTable);

const doc = new jsPDF();
if (typeof autoTable === 'function') {
  autoTable(doc, { head: [['Name', 'Email']], body: [['John', 'john@example.com']] });
} else if (typeof autoTable.default === 'function') {
  autoTable.default(doc, { head: [['Name', 'Email']], body: [['John', 'john@example.com']] });
} else {
  // Try doc.autoTable
  require('jspdf-autotable');
  if (typeof doc.autoTable === 'function') {
     console.log("doc.autoTable works after require!");
  } else {
     console.log("None works");
  }
}
