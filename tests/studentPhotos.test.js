const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Jimp = require('jimp');

// Stub storage/database boundaries; image decoding and resizing use real Jimp.
function loadModule(path, dependencies) {
  const exports = {};
  const module = { exports };
  vm.runInNewContext(fs.readFileSync(require.resolve(path), 'utf8'), {
    module, exports, process, URL, setTimeout, setInterval() {},
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return module.exports;
}

function photoService(uploadFile) {
  return loadModule('../services/studentPhotos', {
    jimp: Jimp, crypto: require('node:crypto'), '../utils/firebaseStorage': { uploadFile },
  });
}

async function picture() {
  const buffer = await new Jimp(640, 480, 0x557799ff).getBufferAsync(Jimp.MIME_PNG);
  return { buffer, originalname: 'student.png', mimetype: Jimp.MIME_PNG, size: buffer.length };
}

test('student upload retains the original and produces a separate 160px JPEG thumbnail', async () => {
  const calls = [];
  const { uploadStudentPhoto } = photoService(async (...args) => {
    calls.push(args);
    return `https://photos.example/${calls.length}`;
  });
  const original = await picture();
  const photo = await uploadStudentPhoto(original, 'school-a');
  assert.equal(photo.profilePicture, 'https://photos.example/1');
  assert.equal(photo.profilePictureThumbnail, 'https://photos.example/2');
  assert.equal(calls[0][0], original);
  assert.equal(calls.length, 2);
  for (const [, folder, school] of calls) {
    assert.equal(folder, 'profiles');
    assert.equal(school, 'school-a');
  }
  const thumb = await Jimp.read(calls[1][0].buffer);
  assert.equal(thumb.bitmap.width, 160);
  assert.equal(thumb.bitmap.height, 160);
  assert.equal(calls[1][0].mimetype, Jimp.MIME_JPEG);
  const full = await Jimp.read(original.buffer);
  assert.equal(full.bitmap.width, 640);
  assert.equal(full.bitmap.height, 480);
});

test('thumbnail storage failure still returns the uploaded original', async () => {
  let calls = 0;
  const { uploadStudentPhoto } = photoService(async () => {
    if (++calls === 2) throw new Error('Storage unavailable');
    return 'https://photos.example/original';
  });
  const photo = await uploadStudentPhoto(await picture(), 'school-a');
  assert.equal(photo.profilePicture, 'https://photos.example/original');
  assert.equal(photo.profilePictureThumbnail, '');
});

test('an unsupported thumbnail format keeps the original, while an original upload failure rejects', async () => {
  const file = { buffer: Buffer.from('unsupported image decoder format'), originalname: 'student.webp' };
  const service = photoService(async () => 'https://photos.example/original');
  assert.equal((await service.uploadStudentPhoto(file, 'school-a')).profilePictureThumbnail, '');
  const failed = photoService(async () => { throw new Error('Original upload failed'); });
  await assert.rejects(failed.uploadStudentPhoto(file, 'school-a'), /Original upload failed/);
});

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

function profileController(User, Student, extra = {}) {
  return loadModule('../controllers/profileController', {
    '../models/User': User,
    '../models/Student': Student,
    '../services/studentPhotos': {},
    '../utils/firebaseStorage': {},
    'firebase-admin': {},
    ...extra,
  });
}

test('cached student profiles pick up the current admin photo without waiting for user cache expiry', async () => {
  let userReads = 0;
  let currentPhoto = 'https://photos.example/first';
  const user = { _id: 'student-user', role: 'student', school: { _id: 'school-a' }, profilePicture: 'https://photos.example/legacy' };
  const controller = profileController({ findById() {
    userReads++;
    return { select() { return this; }, populate() { return this; }, lean() { return this; }, exec: async () => user };
  } }, { findOne(filter) {
    assert.equal(filter.user, 'student-user');
    assert.equal(filter.school, 'school-a');
    return { select() { return this; }, populate() { return this; }, lean: async () => ({
      profilePicture: currentPhoto, profilePictureThumbnail: `${currentPhoto}/thumb`,
      admissionNumber: 'A123', class: { name: 'Basic 4', displayName: 'Basic 4 A' },
    }) };
  } });
  const first = response();
  await controller.getProfile({ user: { id: user._id } }, first);
  assert.equal(first.body.profilePicture, currentPhoto);
  assert.equal(first.body.studentClass, 'Basic 4 A');
  currentPhoto = 'https://photos.example/replaced';
  const second = response();
  await controller.getProfile({ user: { id: user._id } }, second);
  assert.equal(second.body.profilePicture, currentPhoto);
  assert.equal(second.body.profilePictureThumbnail, `${currentPhoto}/thumb`);
  assert.equal(second.body.admissionNumber, 'A123');
  assert.equal(userReads, 1);
});

test('a user save failure never deletes a new photo already linked to the student', async () => {
  let storageDeletes = 0;
  let savedPhoto;
  const controller = profileController({ findById: async () => ({
    _id: 'student-user', role: 'student', school: 'school-a',
    save: async () => { throw new Error('Temporary database error'); },
  }) }, { updateOne: async (filter, update) => {
    assert.equal(filter.school, 'school-a');
    savedPhoto = update.$set;
    return { matchedCount: 1 };
  } }, {
    '../services/studentPhotos': { uploadStudentPhoto: async () => ({ profilePicture: 'https://photos.example/new', profilePictureThumbnail: 'https://photos.example/new/thumb' }) },
    'firebase-admin': { storage() { storageDeletes++; throw new Error('Must not delete linked photo'); } },
  });
  const res = response();
  await controller.updateProfilePicture({ user: { id: 'student-user' }, file: await picture() }, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.statusCode, 500);
  assert.equal(savedPhoto.profilePicture, 'https://photos.example/new');
  assert.equal(storageDeletes, 0);
});
