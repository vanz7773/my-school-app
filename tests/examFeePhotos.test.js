const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Student = require('../models/Student');
const core = require('../services/examFees/core');
const { charges } = require('../services/examFees/payments');

test('charge photos are fetched only for authorized school/page and preserve historical records', async t => {
  const school = new mongoose.Types.ObjectId(), campaign = new mongoose.Types.ObjectId();
  const classId = new mongoose.Types.ObjectId(), student = new mongoose.Types.ObjectId();
  const user = { role: 'teacher', school };
  let authorized = false;
  t.mock.method(core, 'authorizeClass', async () => { authorized = true; });
  t.mock.method(core, 'paginated', async () => ({ items: [{ student, studentName: 'Historical name', className: 'Basic 4', amountDuePesewas: 5000, netPaidPesewas: 2000 }], total: 1 }));
  t.mock.method(Student, 'find', filter => {
    assert.equal(authorized, true);
    assert.deepEqual(filter, { school, _id: { $in: [student] } });
    return { select: fields => {
      assert.equal(fields, '_id profilePicture profilePictureThumbnail');
      return { lean: async () => [{ _id: student, profilePicture: '/photo.jpg', profilePictureThumbnail: '/thumb.jpg' }] };
    } };
  });
  const result = await charges(user, { campaignId: String(campaign), classId: String(classId) });
  assert.equal(result.items[0].profilePictureThumbnail, '/thumb.jpg');
  assert.equal(result.items[0].profilePicture, '/photo.jpg');
  assert.equal(result.items[0].studentName, 'Historical name');
  assert.equal(result.items[0].balancePesewas, 3000);
});

test('authorization denial prevents any student photo lookup', async t => {
  t.mock.method(core, 'authorizeClass', async () => { throw new Error('Not authorized'); });
  const lookup = t.mock.method(Student, 'find', () => { throw new Error('Unexpected lookup'); });
  await assert.rejects(charges({ role: 'teacher', school: new mongoose.Types.ObjectId() }, { campaignId: String(new mongoose.Types.ObjectId()), classId: String(new mongoose.Types.ObjectId()) }), /Not authorized/);
  assert.equal(lookup.mock.callCount(), 0);
});
