import re

with open('middlewares/geofenceValidator.js', 'r') as f:
    content = f.read()

# Add imports
imports_target = "const School = require('../models/School');"
imports_replacement = """const School = require('../models/School');
const Teacher = require('../models/Teacher');
const { getTeacherLocationCache, isNearCachedLocation } = require('../utils/locationCache');"""
content = content.replace(imports_target, imports_replacement)

# Add fallback logic
logic_target = """    // ✅ Enforce validation
    if (!isWithinGeofence) {
      console.warn(`[GEOFENCE] Out-of-zone clock attempt for ${name}.`);
      return res.status(403).json({
        status: 'fail',
        message: `You must be within the school compound to clock in or out. 
        You're approximately ${Math.round(distanceFromCenter)} meters away.`,
      });
    }

    // ✅ Attach metadata to request
    req.geofenceStatus = polygon.length >= 3 ? 'inside' : 'radius';"""

logic_replacement = """    // ✅ Enforce validation
    if (!isWithinGeofence) {
      console.warn(`[GEOFENCE] Out-of-zone clock attempt for ${name}.`);

      // 🛡️ PHASE 2: ADAPTIVE CACHE FALLBACK 🛡️
      let teacherId = req.body.teacherId;
      if (!teacherId && req.user) {
        const teacher = await Teacher.findOne({ user: req.user.id }).lean();
        if (teacher) teacherId = teacher._id;
      }

      let passedViaCache = false;
      if (teacherId) {
        const cachedLocations = await getTeacherLocationCache(teacherId, schoolId);
        passedViaCache = isNearCachedLocation({
          currentLat: lat,
          currentLng: lng,
          cachedLocations
        });
      }

      if (passedViaCache) {
        console.log(`[GEOFENCE] 🟢 ADAPTIVE VALIDATION PASSED: Teacher ${teacherId} is outside strict zone but within 100m of a trusted historical clock-in point.`);
        req.geofenceStatus = 'cache_fallback';
      } else {
        return res.status(403).json({
          status: 'fail',
          message: `You must be within the school compound to clock in or out. \\n        You're approximately ${Math.round(distanceFromCenter)} meters away.`,
        });
      }
    } else {
      req.geofenceStatus = polygon.length >= 3 ? 'inside' : 'radius';
    }

    // ✅ Attach metadata to request"""

content = content.replace(logic_target, logic_replacement)

with open('middlewares/geofenceValidator.js', 'w') as f:
    f.write(content)

print("Patch applied")
