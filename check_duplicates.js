const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

const serverPath = '/Users/mac/Documents/BACKUP/feedingduplication fix/server';
dotenv.config({ path: path.join(serverPath, '.env') });

const Term = require(path.join(serverPath, 'models/term'));

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');

  const duplicateTerms = await Term.aggregate([
    {
      $group: {
        _id: { school: '$school', academicYear: '$academicYear', term: '$term' },
        count: { $sum: 1 },
        ids: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]);

  if (duplicateTerms.length > 0) {
    console.log('Found duplicate terms:');
    duplicateTerms.forEach(dup => {
      console.log(`School ${dup._id.school}, Year ${dup._id.academicYear}, Term ${dup._id.term}: ${dup.count} entries found. IDs: ${dup.ids.join(', ')}`);
    });
  } else {
    console.log('No duplicate terms found.');
  }

  await mongoose.disconnect();
}

run().catch(console.error);
