const mongoose = require('mongoose');
const FeedingFeeRecord = require('../server/models/FeedingFeeRecord');
const FeedingFeeConfig = require('../server/models/FeedingFeeConfig');
const { getAmountPerDay } = require('../server/utils/feedingFeeUtils');

async function check() {
  mongoose.connect("mongodb://localhost:27017/sms");
  const config = await FeedingFeeConfig.findOne();
  const record = await FeedingFeeRecord.findOne().populate({
        path: 'breakdown.student',
        select: 'name class',
        populate: { path: 'class', select: 'name displayName' }
  }).lean();
  let entry = record.breakdown[0];
  console.log("student:", entry.student);
  const liveAmount = getAmountPerDay(entry.student, config);
  console.log("liveAmount:", liveAmount);
  process.exit();
}
check();
