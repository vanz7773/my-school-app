const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs/promises');
const School = require('../models/School');
const User = require('../models/User');
const Teacher = require('../models/Teacher');
const Student = require('../models/Student');
const Class = require('../models/Class');
const Term = require('../models/term');
const Campaign = require('../models/ExamFeeCampaign');
const Charge = require('../models/ExamFeeCharge');
const Payment = require('../models/ExamFeePayment');
const Assignment = require('../models/ExamFeeCollectorAssignment');
const Remittance = require('../models/ExamFeeRemittance');
const Audit = require('../models/ExamFeeAudit');
const routes = require('../routes/examFeeRoutes');
const id = () => new mongoose.Types.ObjectId();
const uri = process.env.EXAM_FEES_TEST_URI;

test('exam fees integration on an isolated replica set', { skip: !uri, timeout: 180000 }, async t => {
  // Existing auth middleware logs every request; keep TAP output bounded.
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  // Deliberately refuse remote hosts and require a unique disposable database name.
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27183\//);
  const dbName = `exam_fees_test_${process.pid}_${Date.now()}`;
  process.env.JWT_SECRET = 'exam-fees-local-integration-only';
  let server;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000, autoIndex: false });
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  // Existing Student's legacy partial index uses unsupported $ne; do not alter unrelated schemas.
  // Create only this module's indexes, which are the ones under concurrency test.
  await Promise.all([School, User, Teacher, Student, Class, Term, Campaign, Charge, Payment, Assignment, Remittance, Audit].map(model => model.createCollection()));
  await Promise.all([Campaign, Charge, Payment, Assignment, Remittance, Audit].map(model => model.createIndexes()));
  const app = express(); app.use(express.json()); app.use('/api/exam-fees', routes);
  server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}/api/exam-fees`;
  async function call(user, method, path, body, expected = 200) {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`;
    const response = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (path.endsWith('/receipt') && response.status === 200) {
      assert.equal(response.headers.get('content-type'), 'application/pdf'); return Buffer.from(await response.arrayBuffer());
    }
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function fixture(type) {
    const school = await School.create({ name: `${type} School`, schoolType: type, lockedFeatures: ['feeding_fee', 'billing'] });
    const user = role => ({ _id: id(), school: school._id, role, name: `${role} Test`, email: `${id()}@test.invalid`, password: 'unused', isActive: true });
    const admin = user('admin'), teacherUser = user('teacher'), otherTeacherUser = user('teacher'), pupil = user('student'), pupil2 = user('student'), parent = user('parent');
    await User.collection.insertMany([admin, teacherUser, otherTeacherUser, pupil, pupil2, parent]);
    const teacher = await Teacher.create({ school: school._id, user: teacherUser._id, assignedClasses: [] });
    const otherTeacher = await Teacher.create({ school: school._id, user: otherTeacherUser._id });
    const cls = await Class.create({ school: school._id, name: 'BASIC 7' });
    const cls2 = await Class.create({ school: school._id, name: 'BASIC 8' });
    const term = await Term.create({ school: school._id, academicYear: '2026-2027', term: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-20', weekStartDate: '2026-09-01', weekNumber: 1, weeks: 16 });
    const students = await Student.create([{ school: school._id, user: pupil._id, class: cls._id, gender: 'Male', academicYear: '2026-2027', admissionNumber: '001' },
      { school: school._id, user: pupil2._id, class: cls2._id, gender: 'Female', academicYear: '2026 to 2027', admissionNumber: '002' }]);
    return { school, admin, teacherUser, otherTeacherUser, teacher, otherTeacher, cls, cls2, term, students, pupil, parent };
  }
  const f = await fixture('Government'), privateSchool = await fixture('Private');
  let campaign, charges, firstPayment, assignment;
  const draft = (name = 'BECE Mock 1', type = 'mock') => ({ name, examinationType: type, academicYear: '2026-2027', termId: String(f.term._id),
    classFees: [{ classId: String(f.cls._id), amountPesewas: 5000 }, { classId: String(f.cls2._id), amountPesewas: 7000 }] });
  const pay = (charge, amount, key, method = 'cash') => ({ chargeId: String(charge._id), amountPesewas: amount, method, clientRequestId: key });
  await t.test('JWT, roles, disabled flag and independent activation for both school types', async () => {
    await call(null, 'GET', '/campaigns', null, 401);
    await call(f.parent, 'GET', '/settings', null, 403);
    await call(f.teacherUser, 'PATCH', '/settings', { examFeesEnabled: true }, 403);
    assert.equal((await call(f.admin, 'GET', '/settings')).examFeesEnabled, false);
    await call(f.admin, 'GET', '/campaigns', null, 403);
    for (const fixture of [f, privateSchool]) {
      await call(fixture.admin, 'PATCH', '/settings', { examFeesEnabled: true });
      const school = await School.findById(fixture.school._id);
      assert.equal(school.features.examFeesEnabled, true);
      assert.deepEqual([...school.lockedFeatures], ['feeding_fee', 'billing']);
      assert.equal(school.schoolType, fixture.school.schoolType);
    }
  });
  await t.test('rejects cross-school classes/terms and unsafe amounts, supports editable drafts', async () => {
    await call(f.admin, 'POST', '/campaigns', { ...draft(), termId: String(privateSchool.term._id) }, 404);
    await call(f.admin, 'POST', '/campaigns', { ...draft(), classFees: [{ classId: String(privateSchool.cls._id), amountPesewas: 5000 }] }, 404);
    await call(f.admin, 'POST', '/campaigns', { ...draft(), classFees: [{ classId: String(f.cls._id), amountPesewas: 1.25 }] }, 400);
    campaign = (await call(f.admin, 'POST', '/campaigns', draft())).campaign;
    assert.equal(campaign.status, 'draft');
    await call(f.admin, 'PATCH', `/campaigns/${campaign._id}`, draft('BECE Mock 1 revised'));
  });
  await t.test('activation is concurrent-safe and snapshots class and obligations', async () => {
    await Promise.all([call(f.admin, 'POST', `/campaigns/${campaign._id}/activate`, {}), call(f.admin, 'POST', `/campaigns/${campaign._id}/activate`, {})]);
    charges = await Charge.find({ school: f.school._id, campaign: campaign._id }).sort({ amountDuePesewas: 1 }).lean();
    assert.equal(charges.length, 2); assert.deepEqual(charges.map(c => c.amountDuePesewas), [5000, 7000]);
    await call(f.admin, 'PATCH', `/campaigns/${campaign._id}`, draft(), 409);
    await Student.updateOne({ _id: charges[0].student }, { $set: { class: f.cls2._id } });
    assert.equal(String((await Charge.findById(charges[0]._id)).class), String(f.cls._id));
  });
  await t.test('multiple mocks and end-of-term campaigns have independent charges', async () => {
    for (const [name, type] of [['Mock 2', 'mock'], ['End of Term 1', 'end_of_term']]) {
      const another = (await call(f.admin, 'POST', '/campaigns', draft(name, type))).campaign;
      await call(f.admin, 'POST', `/campaigns/${another._id}/activate`, {});
      assert.equal(await Charge.countDocuments({ school: f.school._id, campaign: another._id }), 2);
    }
    await Student.updateOne({ _id: charges[0].student }, { $set: { class: f.cls._id } });
  });
  await t.test('teacher needs explicit campaign/class authorization and can collect multiple non-teaching classes', async () => {
    await call(f.teacherUser, 'GET', `/charges?campaignId=${campaign._id}&classId=${f.cls._id}`, null, 403);
    await call(f.admin, 'POST', `/campaigns/${campaign._id}/assignments`, { teacherId: String(privateSchool.teacher._id), classId: String(f.cls._id) }, 404);
    assignment = (await call(f.admin, 'POST', `/campaigns/${campaign._id}/assignments`, { teacherId: String(f.teacher._id), classId: String(f.cls._id) })).assignment;
    await call(f.admin, 'POST', `/campaigns/${campaign._id}/assignments`, { teacherId: String(f.teacher._id), classId: String(f.cls2._id) });
    assert.equal((await call(f.teacherUser, 'GET', `/charges?campaignId=${campaign._id}&classId=${f.cls._id}`)).total, 1);
    assert.equal((await call(f.teacherUser, 'GET', '/assignments')).total, 2);
    await call(f.otherTeacherUser, 'POST', '/payments', pay(charges[0], 100, 'unauthorized-01'), 403);
    await call(privateSchool.admin, 'POST', '/payments', pay(charges[0], 100, 'cross-school-01'), 404);
  });
  await t.test('partial payments calculate balances and reject client financial identities', async () => {
    await call(f.teacherUser, 'POST', '/payments', { ...pay(charges[0], 100, 'fake-collector-01'), school: String(privateSchool.school._id) }, 400);
    for (const amount of [0, -1, 0.1, '2000']) await call(f.teacherUser, 'POST', '/payments', pay(charges[0], amount, 'invalid-amount-01'), 400);
    const result = await call(f.teacherUser, 'POST', '/payments', pay(charges[0], 2000, 'partial-payment-01'));
    firstPayment = result.payment;
    assert.equal(result.charge.balancePesewas, 3000); assert.equal(result.charge.paymentStatus, 'partial');
    assert.equal(firstPayment.collectedBy, String(f.teacherUser._id));
    assert.equal(firstPayment.teacher, String(f.teacher._id));
  });
  await t.test('simultaneous identical requests are processed once; key reuse with another amount is rejected', async () => {
    const results = await Promise.all([1, 2, 3].map(() => call(f.teacherUser, 'POST', '/payments', pay(charges[0], 2000, 'partial-payment-01'))));
    assert.ok(results.every(r => r.duplicate));
    assert.equal(await Payment.countDocuments({ school: f.school._id, charge: charges[0]._id }), 1);
    await call(f.teacherUser, 'POST', '/payments', pay(charges[0], 1000, 'partial-payment-01'), 409);
  });
  await t.test('concurrent different requests cannot overpay and a full payment closes the balance', async () => {
    const results = await Promise.all(['race-payment-01', 'race-payment-02'].map(async key => {
      const response = await fetch(base + '/payments', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: String(f.teacherUser._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify(pay(charges[0], 3000, key)) });
      return response.status;
    }));
    assert.deepEqual(results.sort(), [200, 409]);
    assert.equal((await Charge.findById(charges[0]._id)).netPaidPesewas, 5000);
    await call(f.teacherUser, 'POST', '/payments', pay(charges[0], 1, 'overpayment-01'), 409);
    const history = await call(f.teacherUser, 'GET', `/payments?chargeId=${charges[0]._id}`);
    assert.equal(history.total, 2);
    assert.equal(new Set(history.items.map(p => p.receiptNumber)).size, 2);
  });
  await t.test('receipt download is protected and contains a real PDF', async () => {
    await call(privateSchool.admin, 'GET', `/payments/${firstPayment._id}/receipt`, null, 404);
    await call(f.otherTeacherUser, 'GET', `/payments/${firstPayment._id}/receipt`, null, 403);
    const pdf = await call(f.teacherUser, 'GET', `/payments/${firstPayment._id}/receipt`);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    await fs.writeFile('/tmp/exam-fees-receipt-test.pdf', pdf);
  });
  let remit;
  await t.test('handover reserves actual collections, supports partial amounts and cannot be submitted twice', async () => {
    const body = { campaignId: campaign._id, amountPesewas: 2500, method: 'cash', clientRequestId: 'handover-request-01', notes: 'Cash envelope' };
    const results = await Promise.all([call(f.teacherUser, 'POST', '/remittances', body), call(f.teacherUser, 'POST', '/remittances', body)]);
    assert.equal(results[0].remittance._id, results[1].remittance._id); remit = results[0].remittance;
    assert.equal(remit.allocations.reduce((sum, a) => sum + a.amountPesewas, 0), 2500);
    await call(f.teacherUser, 'POST', '/remittances', { ...body, amountPesewas: 5000, clientRequestId: 'handover-request-02' }, 409);
    await call(f.admin, 'POST', `/payments/${firstPayment._id}/reverse`, { reason: 'Incorrect entry' }, 409);
  });
  await t.test('only school admin confirms; repeated confirmation does not double count', async () => {
    await call(f.teacherUser, 'POST', `/remittances/${remit._id}/confirm`, {}, 403);
    await call(privateSchool.admin, 'POST', `/remittances/${remit._id}/confirm`, {}, 404);
    await Promise.all([call(f.admin, 'POST', `/remittances/${remit._id}/confirm`, {}), call(f.admin, 'POST', `/remittances/${remit._id}/confirm`, {})]);
    const summary = (await call(f.teacherUser, 'GET', `/collector-summary?campaignId=${campaign._id}`)).items[0];
    assert.equal(summary.confirmedPesewas, 2500); assert.equal(summary.outstandingPesewas, 2500);
  });
  await t.test('mandatory-reason reversals retain history and update net balances exactly once', async () => {
    await call(f.admin, 'POST', `/payments/${firstPayment._id}/reverse`, {}, 400);
    await call(f.teacherUser, 'POST', `/payments/${firstPayment._id}/reverse`, { reason: 'Bad entry' }, 403);
    await Promise.all([call(f.admin, 'POST', `/payments/${firstPayment._id}/reverse`, { reason: 'Duplicate handwritten receipt' }), call(f.admin, 'POST', `/payments/${firstPayment._id}/reverse`, { reason: 'Duplicate handwritten receipt' })]);
    assert.equal((await Charge.findById(charges[0]._id)).netPaidPesewas, 3000);
    assert.equal(await Payment.countDocuments({ school: f.school._id, charge: charges[0]._id }), 2);
    assert.equal((await Payment.findById(firstPayment._id)).status, 'reversed');
  });
  await t.test('adjustments are explicit, audited and cannot reduce below net paid', async () => {
    await call(f.admin, 'POST', `/charges/${charges[0]._id}/adjustments`, { amountDuePesewas: 2000, reason: 'Discount' }, 409);
    await call(f.admin, 'POST', `/charges/${charges[0]._id}/adjustments`, { amountDuePesewas: 4000, reason: 'Approved concession' });
    assert.equal((await Charge.findById(charges[0]._id)).adjustments.length, 1);
    assert.equal(await Audit.countDocuments({ school: f.school._id, action: 'charge.adjusted' }), 1);
  });
  await t.test('reports distinguish expected, net collections, reversals, handovers and balances', async () => {
    const report = await call(f.admin, 'GET', `/reports?campaignId=${campaign._id}&groupBy=teacher&limit=1`);
    assert.equal(report.summary.expectedPesewas, 11000);
    assert.equal(report.summary.collectedPesewas, 3000);
    assert.equal(report.summary.outstandingPesewas, 8000);
    assert.equal(report.summary.confirmedPesewas, 2500);
    assert.equal(report.summary.reversedPesewas, 2000);
    assert.equal(report.summary.partialStudents, 1); assert.equal(report.summary.unpaidStudents, 1);
    assert.equal(report.summary.outstandingTeacherRemittancesPesewas, 500);
    for (const groupBy of ['class', 'campaign', 'examinationType', 'academicYear', 'term', 'method']) {
      assert.equal((await call(f.admin, 'GET', `/reports?campaignId=${campaign._id}&groupBy=${groupBy}`)).summary.collectedPesewas, 3000);
    }
    assert.equal((await call(privateSchool.admin, 'GET', `/reports?campaignId=${campaign._id}`)).summary.collectedPesewas, 0);
    await call(f.teacherUser, 'GET', '/reports', null, 403);
  });
  await t.test('revocation takes immediate effect on reads, payments and receipts', async () => {
    await call(f.admin, 'POST', `/assignments/${assignment._id}/revoke`, {});
    await call(f.teacherUser, 'GET', `/payments?chargeId=${charges[0]._id}`, null, 403);
    await call(f.teacherUser, 'GET', `/payments/${firstPayment._id}/receipt`, null, 403);
    await call(f.teacherUser, 'POST', '/payments', pay(charges[0], 500, 'revoked-request-01'), 403);
    // Still accountable for previously collected funds, independently of future collection rights.
    assert.equal((await call(f.teacherUser, 'GET', `/collector-summary?campaignId=${campaign._id}`)).items[0].collectedPesewas, 3000);
  });
  await t.test('closed campaigns reject new collections, preserve history and permit handover reconciliation', async () => {
    await call(f.admin, 'POST', `/campaigns/${campaign._id}/close`, {});
    await call(f.admin, 'POST', '/payments', pay(charges[0], 500, 'closed-request-01'), 409);
    await call(f.admin, 'POST', `/campaigns/${campaign._id}/activate`, {}, 409);
    const pending = (await call(f.teacherUser, 'POST', '/remittances', { campaignId: campaign._id, amountPesewas: 500, method: 'bank_transfer', clientRequestId: 'closed-handover-01' })).remittance;
    await call(f.admin, 'POST', `/remittances/${pending._id}/reject`, { reason: 'No transfer received' });
    assert.equal((await call(f.teacherUser, 'GET', `/collector-summary?campaignId=${campaign._id}`)).items[0].pendingPesewas, 0);
  });
  await t.test('confirmed handover remains historical after reversal and surfaces an over-remittance credit', async () => {
    const remaining = await Payment.findOne({ school: f.school._id, campaign: campaign._id, status: 'recorded' });
    await call(f.admin, 'POST', `/payments/${remaining._id}/reverse`, { reason: 'Wrong student receipt corrected after handover' });
    const report = await call(f.admin, 'GET', `/reports?campaignId=${campaign._id}`);
    assert.equal(report.summary.collectedPesewas, 0);
    assert.equal(report.summary.confirmedPesewas, 2500);
    assert.equal(report.summary.overRemittedPesewas, 2500);
    assert.equal(report.summary.outstandingTeacherRemittancesPesewas, 0);
    assert.equal(report.items.length, 2); // Include classes with no successful collections.
    assert.equal(report.items.reduce((sum, item) => sum + item.outstandingPesewas, 0), 11000);
    await call(f.teacherUser, 'POST', '/remittances', { campaignId: campaign._id, amountPesewas: 1, method: 'cash', clientRequestId: 'overremitted-handover' }, 409);
  });
  let methodsCampaign, methodsCharge;
  await t.test('all four recorded payment methods work and simultaneous new duplicate requests create one receipt', async () => {
    methodsCampaign = (await call(f.admin, 'POST', '/campaigns', draft('Method verification'))).campaign;
    await call(f.admin, 'POST', `/campaigns/${methodsCampaign._id}/activate`, {});
    methodsCharge = await Charge.findOne({ school: f.school._id, campaign: methodsCampaign._id, class: f.cls._id }).lean();
    const results = await Promise.all([1, 2, 3].map(() => call(f.admin, 'POST', '/payments', pay(methodsCharge, 100, 'new-duplicate-payment'))));
    assert.equal(new Set(results.map(result => result.payment._id)).size, 1);
    assert.equal(results.filter(result => !result.duplicate).length, 1);
    for (const method of ['mobile_money', 'bank_transfer', 'cheque']) await call(f.admin, 'POST', '/payments', pay(methodsCharge, 100, `method-${method}`, method));
    assert.equal((await Charge.findById(methodsCharge._id)).netPaidPesewas, 400);
    assert.equal(await Payment.countDocuments({ school: f.school._id, campaign: methodsCampaign._id }), 4);
  });
  await t.test('an audit failure rolls back both payment and balance', async st => {
    st.mock.method(Audit, 'create', async () => { throw new Error('Injected audit failure'); });
    await call(f.admin, 'POST', '/payments', pay(methodsCharge, 100, 'rollback-payment-01'), 500);
    assert.equal((await Charge.findById(methodsCharge._id)).netPaidPesewas, 400);
    assert.equal(await Payment.countDocuments({ school: f.school._id, clientRequestId: 'rollback-payment-01' }), 0);
  });
  await t.test('concurrent handovers cannot reserve the same funds; rejection releases reservations', async () => {
    await call(f.admin, 'POST', `/campaigns/${methodsCampaign._id}/assignments`, { teacherId: String(f.teacher._id), classId: String(f.cls._id) });
    await call(f.teacherUser, 'POST', '/payments', pay(methodsCharge, 4000, 'remittance-concurrency-payment'));
    const requests = ['remit-concurrent-01', 'remit-concurrent-02'].map(clientRequestId => ({ campaignId: methodsCampaign._id, amountPesewas: 3000, method: 'cash', clientRequestId }));
    const results = await Promise.all(requests.map(async body => {
      const response = await fetch(base + '/remittances', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: String(f.teacherUser._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    }));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const pending = results.find(result => result.status === 200).data.remittance;
    await call(f.admin, 'POST', `/remittances/${pending._id}/reject`, { reason: 'Count again' });
    const summary = (await call(f.teacherUser, 'GET', `/collector-summary?campaignId=${methodsCampaign._id}`)).items[0];
    assert.equal(summary.availableToSubmitPesewas, 4000);
    assert.equal(summary.pendingPesewas, 0);
  });
  await t.test('audit trail and student histories are paginated and role protected', async () => {
    const audits = await call(f.admin, 'GET', `/audit?campaignId=${campaign._id}&limit=2&page=1`);
    assert.equal(audits.items.length, 2); assert.ok(audits.total > 2);
    await call(f.teacherUser, 'GET', '/audit', null, 403);
    const history = await call(f.admin, 'GET', `/payments?studentId=${charges[0].student}&limit=1`);
    assert.equal(history.items.length, 1); assert.ok(history.total > 1);
    await call(f.admin, 'GET', '/campaigns?limit=10000', null, 400);
  });
  await t.test('Mid-Term has independent charges, authorized collections and correctly filtered reports', async () => {
    const midDraft = { name: 'Mid-Term Examination', examinationType: 'mid_term', academicYear: '2026-2027', termId: String(privateSchool.term._id),
      classFees: [{ classId: String(privateSchool.cls._id), amountPesewas: 5000 }, { classId: String(privateSchool.cls2._id), amountPesewas: 7000 }] };
    const mid = (await call(privateSchool.admin, 'POST', '/campaigns', midDraft)).campaign;
    assert.equal(mid.examinationType, 'mid_term');
    await call(privateSchool.admin, 'PATCH', `/campaigns/${mid._id}`, { ...midDraft, name: 'Mid-Term Examination revised' });
    await call(privateSchool.admin, 'POST', `/campaigns/${mid._id}/activate`, {});
    await call(privateSchool.teacherUser, 'GET', `/charges?campaignId=${mid._id}&classId=${privateSchool.cls._id}`, null, 403);
    await call(privateSchool.admin, 'POST', `/campaigns/${mid._id}/assignments`, { teacherId: String(privateSchool.teacher._id), classId: String(privateSchool.cls._id) });
    const roster = await call(privateSchool.teacherUser, 'GET', `/charges?campaignId=${mid._id}&classId=${privateSchool.cls._id}`);
    assert.equal(roster.total, 1);
    const body = pay(roster.items[0], 2000, 'mid-term-payment-01');
    const first = await call(privateSchool.teacherUser, 'POST', '/payments', body);
    const retry = await call(privateSchool.teacherUser, 'POST', '/payments', body);
    assert.equal(first.charge.balancePesewas, 3000);
    assert.equal(retry.duplicate, true); assert.equal(retry.payment._id, first.payment._id);
    const filtered = await call(privateSchool.teacherUser, 'GET', '/campaigns?examinationType=mid_term');
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0]._id, mid._id);
    const report = await call(privateSchool.admin, 'GET', `/reports?campaignId=${mid._id}&examinationType=mid_term&groupBy=examinationType`);
    assert.equal(report.summary.expectedPesewas, 12000); assert.equal(report.summary.collectedPesewas, 2000);
    assert.equal(report.summary.outstandingPesewas, 10000); assert.equal(report.items[0]._id, 'mid_term');
    assert.equal((await call(f.admin, 'GET', '/campaigns?examinationType=mid_term')).total, 0);
    await call(f.admin, 'POST', '/campaigns', draft('Invalid examination', 'unknown'), 400);
  });
  await t.test('disabling blocks every feature path without deleting financial history; settings can re-enable', async () => {
    const count = await Payment.countDocuments({ school: f.school._id });
    await call(f.admin, 'PATCH', '/settings', { examFeesEnabled: false });
    for (const path of ['/campaigns', '/charges', '/payments', '/remittances', '/collector-summary', '/reports', '/audit', `/payments/${firstPayment._id}/receipt`]) await call(f.admin, 'GET', path, null, 403);
    assert.equal((await call(f.admin, 'GET', '/settings')).examFeesEnabled, false);
    assert.equal(await Payment.countDocuments({ school: f.school._id }), count);
    await call(f.admin, 'PATCH', '/settings', { examFeesEnabled: true });
  });
});
