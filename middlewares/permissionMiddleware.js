const User = require("../models/User");

const forbiddenMessage = "You are not allowed to perform this action";

const getEffectivePermissions = (user) => {
  const role = String(user?.role || "").toLowerCase();

  if (role === "superadmin") {
    return User.fullAdminPermissions();
  }

  if (role !== "admin") {
    return User.emptyPermissions();
  }

  const createdBy = user.audit?.createdBy;
  const isPrimarySchoolAdmin = !createdBy;

  if (isPrimarySchoolAdmin || !user.permissionsConfigured) {
    return User.fullAdminPermissions();
  }

  return User.normalizePermissions(user.permissions || {});
};

const checkPermission = (permissionName) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authorized" });
    }

    if (!User.permissionKeys.includes(permissionName)) {
      return res.status(500).json({
        message: `Unknown permission: ${permissionName}`,
      });
    }

    const permissions = getEffectivePermissions(req.user);
    req.permissions = permissions;

    if (!permissions[permissionName]) {
      return res.status(403).json({ message: forbiddenMessage });
    }

    next();
  };
};

const checkPermissionForAdmin = (permissionName) => {
  return (req, res, next) => {
    if (req.user?.role === "admin" || req.user?.role === "superadmin") {
      return checkPermission(permissionName)(req, res, next);
    }

    return next();
  };
};

module.exports = {
  checkPermission,
  checkPermissionForAdmin,
  getEffectivePermissions,
  forbiddenMessage,
};
