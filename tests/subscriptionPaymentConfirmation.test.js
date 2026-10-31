const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Transaction = require('../models/SchoolTransaction');
const { acknowledgePaymentConfirmation } = require('../controllers/subscriptionPaymentConfirmationController');
const id = () => new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('acknowledgement is atomic, school scoped, admin scoped and does not reorder payments', async t => {
  const user = { _id: id(), school: id(), role: 'admin' }, paymentId = String(id());
  let seen = false;
  t.mock.method(Transaction, 'findOneAndUpdate', async (filter, update, options) => {
    assert.deepEqual(filter, { _id: paymentId, school: user.school, status: 'paid', confirmationSeenBy: { $ne: user._id } });
    assert.deepEqual(update, { $addToSet: { confirmationSeenBy: user._id } });
    assert.equal(options.timestamps, false);
    if (seen) return null;
    seen = true; return { _id: paymentId };
  });
  const first = response(), second = response();
  await Promise.all([first, second].map(res => acknowledgePaymentConfirmation({ user, params: { paymentId } }, res)));
  assert.equal(first.body.shouldShow, true);
  assert.equal(second.body.shouldShow, false);
});

test('non-admins and users without a school cannot acknowledge payments', async t => {
  t.mock.method(Transaction, 'findOneAndUpdate', () => { throw new Error('Should not query'); });
  for (const user of [{ role: 'teacher', school: id(), _id: id() }, { role: 'admin', _id: id() }]) {
    const res = response();
    await acknowledgePaymentConfirmation({ user, params: { paymentId: String(id()) } }, res);
    assert.equal(res.statusCode, 403);
  }
});

test('invalid IDs are rejected and missing/unpaid/other-school records never show a dialog', async t => {
  t.mock.method(Transaction, 'findOneAndUpdate', async () => null);
  const user = { _id: id(), school: id(), role: 'admin' };
  const invalid = response();
  await acknowledgePaymentConfirmation({ user, params: { paymentId: 'bad' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const missing = response();
  await acknowledgePaymentConfirmation({ user, params: { paymentId: String(id()) } }, missing);
  assert.equal(missing.body.shouldShow, false);
});
