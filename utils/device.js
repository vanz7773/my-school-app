exports.bindDevice = (teacher, deviceId) => {
  teacher.deviceId = deviceId;
  return teacher.save();
};

exports.isDeviceValid = (teacher, deviceId) => {
  return teacher.deviceId === deviceId;
};
