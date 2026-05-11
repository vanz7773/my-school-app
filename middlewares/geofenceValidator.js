/**
 * middleware/geofenceValidator.js
 * ---------------------------------------------------
 * Centralized geofence validation for teacher clock-in/out.
 * Ensures teachers can only clock within school boundaries.
 *
 * Features:
 * ✅ Uses utils/geofence.js for reusable validation
 * ✅ Admin/supervisor override support
 * ✅ Polygon caching to reduce DB load
 * ✅ Attaches geofence metadata including distance feedback
 */

const School = require('../models/School');
const Teacher = require('../models/Teacher');
const { getTeacherLocationCache, isNearCachedLocation } = require('../utils/locationCache');
const { normalizePolygon, validateGeofence, calculateDistance } = require('../utils/geofence');

// 🧠 In-memory cache (resets on server restart)
const polygonCache = new Map();

// ⚙️ Configuration
const CACHE_FALLBACK_RADIUS_METERS = 100;
const MAX_CACHE_DISTANCE_FROM_CENTER_BUFFER = 75;
const MAX_CACHE_POINTS_TO_USE = 5; // Use most recent points only

/**
 * Geofence validation middleware
 */
const geofenceValidator = async (req, res, next) => {
  try {
    // Extract coordinates from request
    const { latitude, longitude } = req.body;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      console.error('[GEOFENCE] Invalid coordinates:', { latitude, longitude });
      return res.status(400).json({
        status: 'fail',
        message: 'Unable to detect your location. Please ensure GPS is enabled and try again.',
      });
    }

    // ✅ Admin/supervisor bypass
    if (['admin', 'supervisor'].includes(req.user?.role)) {
      console.log(`[GEOFENCE] Bypass for role: ${req.user.role}`);
      req.geofenceStatus = 'override';
      req.geofenceData = { bypass: true };
      return next();
    }

    // ✅ Validate user & school context
    if (!req.user || !req.user.school) {
      console.error('[GEOFENCE] Missing school context for user:', req.user);
      return res.status(401).json({
        status: 'fail',
        message: 'Unauthorized: missing school context. Please log in again.',
      });
    }

    const schoolId = req.user.school._id || req.user.school.id || req.user.school;

    // ⚡ Fetch from cache (if available)
    let schoolData = polygonCache.get(schoolId);
    if (!schoolData) {
      const school = await School.findById(schoolId).lean();
      if (!school) {
        console.error('[GEOFENCE] School not found:', schoolId);
        return res.status(404).json({
          status: 'fail',
          message: 'School not found for current user.',
        });
      }

      schoolData = {
        id: school._id.toString(),
        name: school.name,
        location: school.location,
        radius: school.geofenceRadius || 50,
      };

      polygonCache.set(schoolId, schoolData);
      console.log(`[GEOFENCE CACHE] Cached polygon for: ${school.name}`);
    }

    const { location, radius, name } = schoolData;

    // ✅ Validate polygon existence
    if (!location || !Array.isArray(location.coordinates) || location.coordinates.length === 0) {
      console.error('[GEOFENCE] Missing polygon coordinates for school:', schoolId);
      return res.status(400).json({
        status: 'fail',
        message:
          'This school does not have a valid geofence configured. Contact your administrator.',
      });
    }

    // ✅ Normalize polygon coordinates
    const polygon = normalizePolygon(location.coordinates);

    // ✅ Calculate polygon center for distance feedback
    let centerLat = 0;
    let centerLng = 0;
    for (const [lngPoint, latPoint] of polygon) {
      centerLng += lngPoint;
      centerLat += latPoint;
    }
    centerLng /= polygon.length;
    centerLat /= polygon.length;

    // ✅ Perform geofence validation
    let isWithinGeofence = validateGeofence(lat, lng, polygon, radius);
    const distanceFromCenter = calculateDistance(lat, lng, centerLat, centerLng);

    console.log('\n[GEOFENCE CHECK] --------------------------------');
    console.log(`School: ${name}`);
    console.log(`Coordinates: lat=${lat}, lng=${lng}`);
    console.log(`Polygon points: ${polygon.length}`);
    console.log(`Radius allowed: ${radius}m`);
    console.log(`Distance from center: ${distanceFromCenter.toFixed(2)}m`);
    console.log(`Within geofence: ${isWithinGeofence}`);
    console.log('-----------------------------------------------\n');

    let clockInMethod = 'normal_gps';

    // 🚀 Custom Radius Override Logic
    let teacherId = null;
    if (!isWithinGeofence) {
      try {
        const teacher = await Teacher.findOne({ user: req.user.id }).select('_id');
        teacherId = teacher?._id;

        if (teacherId) {
          const ClockInException = require('../models/ClockInException');
          const exception = await ClockInException.findOne({ teacherId, isActive: true });
          
          if (exception && exception.customRadius) {
            console.log(`[GEOFENCE] 🔔 Exception found for teacher ${teacherId}. Custom radius: ${exception.customRadius}m`);
            if (distanceFromCenter <= exception.customRadius) {
              isWithinGeofence = true;
              clockInMethod = 'custom_radius_override';
              console.log(`[GEOFENCE] 🟢 Exception granted! Using custom radius.`);
            } else {
              console.log(`[GEOFENCE] 🔴 Outside custom radius.`);
            }
          }
        }
      } catch (err) {
        console.error("[GEOFENCE EXCEPTION ERROR]", err.message);
      }
    }

    // ✅ Enforce validation
    if (!isWithinGeofence) {
      console.log("[GEOFENCE] ❌ Strict validation failed");

      try {
        // Teacher may have been fetched during exception check
        if (!teacherId) {
          const teacher = await Teacher.findOne({ user: req.user.id }).select('_id');
          teacherId = teacher?._id;
        }

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
        message: `You must be within the school compound to clock in or out. \n    You're approximately ${Math.round(distanceFromCenter)} meters away.`,
      });
    } else {
      req.geofenceStatus = (clockInMethod === 'custom_radius_override') ? 'custom_radius' : (polygon.length >= 3 ? 'inside' : 'radius');
    }

    // ✅ Attach metadata to request
    req.geofenceData = {
      schoolId,
      schoolName: name,
      polygonPoints: polygon.length,
      radiusMeters: radius,
      distanceFromCenter,
      centerLat,
      centerLng,
      fromCache: polygonCache.has(schoolId),
      clockInMethod,
    };

    console.log(`[GEOFENCE PASS] ${name} | Status: ${req.geofenceStatus}`);
    next();
  } catch (error) {
    console.error('[GEOFENCE VALIDATOR ERROR]', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error during geofence validation.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

module.exports = geofenceValidator;
