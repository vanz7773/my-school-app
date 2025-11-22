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
const { normalizePolygon, validateGeofence, calculateDistance } = require('../utils/geofence');

// 🧠 In-memory cache (resets on server restart)
const polygonCache = new Map();

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
        message: 'Valid latitude and longitude are required for location validation.',
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
        radius: school.geofenceRadius || 80,
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
    const isWithinGeofence = validateGeofence(lat, lng, polygon, radius);
    const distanceFromCenter = calculateDistance(lat, lng, centerLat, centerLng);

    console.log('\n[GEOFENCE CHECK] --------------------------------');
    console.log(`School: ${name}`);
    console.log(`Coordinates: lat=${lat}, lng=${lng}`);
    console.log(`Polygon points: ${polygon.length}`);
    console.log(`Radius allowed: ${radius}m`);
    console.log(`Distance from center: ${distanceFromCenter.toFixed(2)}m`);
    console.log(`Within geofence: ${isWithinGeofence}`);
    console.log('-----------------------------------------------\n');

    // ✅ Enforce validation
    if (!isWithinGeofence) {
      console.warn(`[GEOFENCE] Out-of-zone clock attempt for ${name}.`);
      return res.status(403).json({
        status: 'fail',
        message: `You must be within the school compound to clock in or out. 
                  You're approximately ${Math.round(distanceFromCenter)} meters away.`,
      });
    }

    // ✅ Attach metadata to request
    req.geofenceStatus = polygon.length >= 3 ? 'inside' : 'radius';
    req.geofenceData = {
      schoolId,
      schoolName: name,
      polygonPoints: polygon.length,
      radiusMeters: radius,
      distanceFromCenter,
      fromCache: polygonCache.has(schoolId),
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
