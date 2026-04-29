import re

with open('middlewares/geofenceValidator.js', 'r') as f:
    content = f.read()

# 1. Add Configuration constants
constants = """// 🧠 In-memory cache (resets on server restart)
const polygonCache = new Map();

// ⚙️ Configuration
const CACHE_FALLBACK_RADIUS_METERS = 100;
const MAX_CACHE_DISTANCE_FROM_CENTER_BUFFER = 75;
const MAX_CACHE_POINTS_TO_USE = 5; // Use most recent points only
"""
content = content.replace("// 🧠 In-memory cache (resets on server restart)\nconst polygonCache = new Map();\n", constants)

# 2. Replace the block from `if (!isWithinGeofence) {` to `} else {\n      req.geofenceStatus = polygon.length >= 3 ? 'inside' : 'radius';\n    }`
block_target = """    // ✅ Enforce validation
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
    }"""

block_replacement = """    // ✅ Enforce validation
    if (!isWithinGeofence) {
      console.log("[GEOFENCE] ❌ Strict validation failed");

      try {
        const teacher = await Teacher.findOne({ user: req.user.id }).select('_id');
        const teacherId = teacher?._id;

        if (!teacherId) {
          console.log("[CACHE] No teacher found");
        } else {
          let cachePoints = await getTeacherLocationCache(teacherId, schoolId);

          console.log(`[CACHE] Total stored points: ${cachePoints.length}`);

          if (cachePoints.length > 0) {
            // Use only most recent points (no deletion, just filtering)
            cachePoints = cachePoints
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
              .slice(0, MAX_CACHE_POINTS_TO_USE);

            const isNearCache = isNearCachedLocation(
              lat,
              lng,
              cachePoints,
              CACHE_FALLBACK_RADIUS_METERS
            );

            const maxAllowedDistance =
              radius + MAX_CACHE_DISTANCE_FROM_CENTER_BUFFER;

            const isStillNearSchool =
              distanceFromCenter <= maxAllowedDistance;

            console.log("[CACHE CHECK RESULT]", {
              isNearCache,
              isStillNearSchool,
              distanceFromCenter: Math.round(distanceFromCenter),
              maxAllowedDistance,
              fallbackPass: isNearCache && isStillNearSchool
            });

            if (isNearCache && isStillNearSchool) {
              console.log("✅ [CACHE FALLBACK] Accepted");

              req.geofenceStatus = 'cache_fallback';
              return next();
            }
          } else {
            console.log("🔵 [CACHE] No cache available");
          }
        }
      } catch (err) {
        console.error("[CACHE ERROR]", err.message);
      }

      // ❌ Reject if fallback fails
      return res.status(403).json({
        status: 'fail',
        message: `You must be within the school compound to clock in or out. \\n    You're approximately ${Math.round(distanceFromCenter)} meters away.`,
      });
    } else {
      req.geofenceStatus = polygon.length >= 3 ? 'inside' : 'radius';
    }"""

# ensure the replacement handles schoolId correctly, since getTeacherLocationCache has schoolId locally available
content = content.replace(block_target, block_replacement)

with open('middlewares/geofenceValidator.js', 'w') as f:
    f.write(content)

print("Patch applied to geofenceValidator.js")
