const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

const serverPath = '/Users/mac/Documents/BACKUP/feedingduplication fix/server';
dotenv.config({ path: path.join(serverPath, '.env') });

const TransportEnrollment = require(path.join(serverPath, 'models/TransportEnrollment'));
const Student = require(path.join(serverPath, 'models/Student'));
const Term = require(path.join(serverPath, 'models/term'));

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');

  const studentId = '68b3be592ee6e15750827b45'; // AGYEIWAA
  const enrollment = await TransportEnrollment.findOne({ student: studentId }).populate('term').lean();
  console.log('Enrollment for AGYEIWAA:', JSON.stringify(enrollment, null, 2));

  // Also check attendance for Evans Osei from Log 1
  const evansId = '687989475414541cfff314d0';
  const attendance = await mongoose.connection.collection('transportattendances').find({ student: mongoose.Types.ObjectId(evansId), date: '2026-03-25' }).toArray();
  console.log('Attendance for Evans on 2026-03-25:', JSON.stringify(attendance, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);
