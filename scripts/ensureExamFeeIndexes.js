// Explicit opt-in, additive index creation only. No records or indexes are deleted.
require('dotenv').config();
const mongoose = require('mongoose');
const models = ['ExamFeeCampaign', 'ExamFeeCharge', 'ExamFeePayment', 'ExamFeeCollectorAssignment', 'ExamFeeRemittance', 'ExamFeeAudit'].map(name => require(`../models/${name}`));
async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Run with --apply after reviewing the target MONGO_URI.');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  try {
    for (const model of models) {
      await model.createCollection();
      await model.createIndexes();
      console.log(`Verified indexes: ${model.modelName}`);
    }
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error('Exam fee index setup failed:', error.message); process.exitCode = 1; });
