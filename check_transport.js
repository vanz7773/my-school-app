const mongoose = require('mongoose');
const TransportFeeRecord = require('./models/TransportFeeRecord');

mongoose.connect('mongodb://localhost:27017/sms-mobile', { useNewUrlParser: true, useUnifiedTopology: true })
.then(async () => {
  const records = await TransportFeeRecord.find().sort({createdAt: -1}).limit(5);
  console.log("Found records:", records.length);
  records.forEach(r => {
    console.log(`Term: ${r.termId}, Week: ${r.week}, Breakdown length: ${r.breakdown.length}`);
    if (r.breakdown.length > 0) {
      console.log(`Student 1: M=${r.breakdown[0].days.M}, T=${r.breakdown[0].days.T}, W=${r.breakdown[0].days.W}, TH=${r.breakdown[0].days.TH}, F=${r.breakdown[0].days.F}`);
    }
  });
  mongoose.disconnect();
})
.catch(err => console.error(err));
