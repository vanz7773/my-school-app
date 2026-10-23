const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const Jimp = require('jimp');
const { getPayslipLogo } = require('../services/payslipLogo');
const Payroll = require('../models/Payroll');
const Teacher = require('../models/Teacher');
const SchoolInfo = require('../models/SchoolInfo');
const controller = require('../controllers/payrollController');

test('concurrent and repeated downloads share one resized logo conversion', async t => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  const source = await new Jimp(1024, 768, 0x336699ff).getBufferAsync(Jimp.MIME_PNG);
  let requests = 0;
  axios.get = async (url, options) => {
    requests++;
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxContentLength, 3 * 1024 * 1024);
    return { data: source };
  };
  const schoolInfo = { logo: 'https://example.test/logo.png', updatedAt: '2026-10-23' };
  const [first, second] = await Promise.all([getPayslipLogo(schoolInfo, 'school1'), getPayslipLogo(schoolInfo, 'school1')]);
  assert.equal(requests, 1);
  assert.equal(first, second);
  assert.equal(await getPayslipLogo(schoolInfo, 'school1'), first);
  const resized = await Jimp.read(Buffer.from(first.logoBase64.split(',')[1], 'base64'));
  assert.equal(resized.bitmap.width, 512);
  assert.equal(resized.bitmap.height, 384);
  assert.ok(first.logoBase64.length < source.toString('base64').length);
  await getPayslipLogo({ ...schoolInfo, updatedAt: '2026-10-24' }, 'school1');
  assert.equal(requests, 2);
  await getPayslipLogo(schoolInfo, 'school2');
  assert.equal(requests, 3);
});

test('failed logo downloads do not block PDFs or immediately repeat the failed request', async t => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  let requests = 0;
  axios.get = async () => { requests++; throw new Error('Logo timeout'); };
  const info = { logo: 'https://example.test/unavailable.png' };
  const first = await getPayslipLogo(info, 'slowSchool');
  const second = await getPayslipLogo(info, 'slowSchool');
  assert.equal(first.logoBase64, null);
  assert.equal(second.grayLogoBase64, null);
  assert.equal(requests, 1);
});

const response = () => ({ headers: {}, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader(key, value) { this.headers[key] = value; }, send(buffer) { this.buffer = buffer; return this; } });

test('PDF download is compressed and teacher authorization applies before any logo work', async t => {
  const originals = [Payroll.findOne, Teacher.findOne, SchoolInfo.findOne];
  t.after(() => { [Payroll.findOne, Teacher.findOne, SchoolInfo.findOne] = originals; });
  const payroll = { month: '2026-10', status: 'Paid', school: { name: 'Example School' }, payslips: [
    { teacher: 'ownTeacher', teacherName: 'Ama', baseSalary: 2000, grossSalary: 2000, netSalary: 1900, totalDeductions: 100, deductions: [{ name: 'SSNIT', amount: 100 }] }
  ] };
  Payroll.findOne = () => ({ populate: async () => payroll });
  Teacher.findOne = async filter => { assert.equal(filter.school, 'school1'); return { _id: 'ownTeacher' }; };
  let logoQueries = 0;
  SchoolInfo.findOne = async () => { logoQueries++; return null; };
  const request = { params: { id: 'batch1' }, query: {}, user: { _id: 'user1', role: 'teacher', school: 'school1' } };
  const forbidden = response();
  await controller.downloadPdf({ ...request, query: { teacherId: 'someoneElse' } }, forbidden);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(logoQueries, 0);
  const parent = response();
  await controller.downloadPdf({ ...request, user: { ...request.user, role: 'parent' } }, parent);
  assert.equal(parent.statusCode, 403);
  const result = response();
  await controller.downloadPdf(request, result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.buffer.subarray(0, 4).toString(), '%PDF');
  assert.ok(result.buffer.includes(Buffer.from('/FlateDecode')));
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.headers['Content-Type'], 'application/pdf');
});
