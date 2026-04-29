const TeacherLocationCache = require('../models/TeacherLocationCache');
const { calculateDistance } = require('./geofence');

/**
 * Validates and saves a teacher's strict GPS location to the cache.
 * Follows strict rules:
 * - accuracy <= 120 meters
 * - distanceToSchool <= schoolRadius
 * - strict GPS (checked by caller)
 * - Duplicate protection: skips if < 10m from latest cached point.
 * - Cleanup: keeps only latest 20 records.
 */
const saveTeacherLocationCache = async ({
  teacherId,
  schoolId,
  latitude,
  longitude,
  accuracy,
  distanceToSchool,
  schoolRadius,
}) => {
  try {
    // 1. Strict validation checks
    if (accuracy > 120) {
      console.log(`[CACHE] Skipping: Accuracy (${accuracy}m) is too poor (>120m).`);
      return;
    }

    if (distanceToSchool > schoolRadius) {
      console.log(
        `[CACHE] Skipping: Distance (${distanceToSchool}m) is outside school radius (${schoolRadius}m).`
      );
      return;
    }

    // 2. Duplicate Protection (fetch latest record)
    const latestRecord = await TeacherLocationCache.findOne({
      teacherId,
      schoolId,
    }).sort({ createdAt: -1 });

    if (latestRecord) {
      const distanceToLatest = calculateDistance(
        latitude,
        longitude,
        latestRecord.latitude,
        latestRecord.longitude
      );

      if (distanceToLatest < 10) {
        console.log(`[CACHE] Skipping: Duplicate point. Distance to latest cached point is ${distanceToLatest.toFixed(2)}m (< 10m).`);
        return;
      }
    }

    // 3. Save the new location
    await TeacherLocationCache.create({
      teacherId,
      schoolId,
      latitude,
      longitude,
      accuracy,
      source: 'strict',
    });
    console.log(`[CACHE] ✅ Successfully saved strict GPS cache for teacher ${teacherId}`);

    // 4. Enforce max 20 records per teacher per school
    const oldRecords = await TeacherLocationCache.find({
      teacherId,
      schoolId,
    })
      .sort({ createdAt: -1 })
      .skip(20)
      .select('_id');

    if (oldRecords.length > 0) {
      const idsToDelete = oldRecords.map(r => r._id);
      await TeacherLocationCache.deleteMany({
        _id: { $in: idsToDelete }
      });
      console.log(`[CACHE] 🧹 Trimmed ${idsToDelete.length} old records (kept latest 20)`);
    }
  } catch (error) {
    // Fail silently so it NEVER affects attendance
    console.error('[CACHE] ❌ Cache save failed (non-blocking):', error.message);
  }
};

/**
 * Retrieves the latest cached locations for a teacher at a school.
 */
const getTeacherLocationCache = async (teacherId, schoolId) => {
  try {
    return await TeacherLocationCache.find({ teacherId, schoolId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
  } catch (error) {
    console.error('[CACHE] Fetch failed:', error.message);
    return [];
  }
};

/**
 * PREP ONLY: Future fallback validation.
 * Checks if current coordinates are near any cached location (within 100m).
 */
const isNearCachedLocation = (currentLat, currentLng, cachedLocations, radiusMeters = 100) => {
  if (!cachedLocations || cachedLocations.length === 0) return false;

  for (const loc of cachedLocations) {
    const dist = calculateDistance(currentLat, currentLng, loc.latitude, loc.longitude);
    if (dist <= radiusMeters) {
      return true;
    }
  }

  return false;
};

module.exports = {
  saveTeacherLocationCache,
  getTeacherLocationCache,
  isNearCachedLocation,
};
