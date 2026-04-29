import re

with open('utils/locationCache.js', 'r') as f:
    content = f.read()

# 1. Remove deletion logic from saveTeacherLocationCache
cleanup_target = """    // 4. Cleanup old records (keep only latest 20)
    const recordsToKeep = await TeacherLocationCache.find({ teacherId, schoolId })
      .sort({ createdAt: -1 })
      .select('_id')
      .limit(20);

    const idsToKeep = recordsToKeep.map((r) => r._id);

    const deleteResult = await TeacherLocationCache.deleteMany({
      teacherId,
      schoolId,
      _id: { $nin: idsToKeep },
    });

    if (deleteResult.deletedCount > 0) {
      console.log(`[CACHE] Cleaned up ${deleteResult.deletedCount} old cache records.`);
    }"""
content = content.replace(cleanup_target, "")

# 2. Update getTeacherLocationCache
get_cache_target = """const getTeacherLocationCache = async (teacherId, schoolId) => {
  try {
    return await TeacherLocationCache.find({ teacherId, schoolId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
  } catch (error) {
    console.error('[CACHE] Fetch failed:', error.message);
    return [];
  }
};"""
get_cache_replacement = """const getTeacherLocationCache = async (teacherId, schoolId) => {
  try {
    const query = { teacherId };
    if (schoolId) query.schoolId = schoolId;
    return await TeacherLocationCache.find(query)
      .sort({ createdAt: -1 })
      .lean();
  } catch (error) {
    console.error('[CACHE] Fetch failed:', error.message);
    return [];
  }
};"""
content = content.replace(get_cache_target, get_cache_replacement)

# 3. Update isNearCachedLocation signature
is_near_target = """const isNearCachedLocation = ({ currentLat, currentLng, cachedLocations }) => {
  if (!cachedLocations || cachedLocations.length === 0) return false;

  for (const loc of cachedLocations) {
    const dist = calculateDistance(currentLat, currentLng, loc.latitude, loc.longitude);
    if (dist <= 100) {
      return true;
    }
  }

  return false;
};"""
is_near_replacement = """const isNearCachedLocation = (currentLat, currentLng, cachedLocations, radiusMeters = 100) => {
  if (!cachedLocations || cachedLocations.length === 0) return false;

  for (const loc of cachedLocations) {
    const dist = calculateDistance(currentLat, currentLng, loc.latitude, loc.longitude);
    if (dist <= radiusMeters) {
      return true;
    }
  }

  return false;
};"""
content = content.replace(is_near_target, is_near_replacement)

with open('utils/locationCache.js', 'w') as f:
    f.write(content)

print("Patch applied to locationCache.js")
