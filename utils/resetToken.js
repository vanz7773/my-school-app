// utils/resetToken.js
const crypto = require('crypto');

exports.generateResetToken = function (bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex'); // random token
};

exports.hashToken = function (token) {
  return crypto.createHash('sha256').update(token).digest('hex');
};
