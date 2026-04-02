const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://vanz7773:XvG1kofE2H3u10E9@cluster0.p71bclx.mongodb.net/test?retryWrites=true&w=majority', { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const TransportFeeRecord = require('./models/TransportFeeRecord');
    const records = await TransportFeeRecord.find().sort({ _id: -1 }).limit(1).lean();
    console.log("DB RESULT:");
    console.log(JSON.stringify(records, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
