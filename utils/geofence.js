/**
 * utils/geofence.js
 * ----------------------------------------------------------
 * Central geofence utility module for backend use.
 * Handles GeoJSON normalization, polygon validation,
 * and radius-based proximity checks.
 */

/////////////////////////////
// Normalize Polygon
/////////////////////////////

function normalizePolygon(rawPolygon) {
  if (!rawPolygon || !Array.isArray(rawPolygon)) {
    console.error('[GEOFENCE UTILS] Invalid polygon input:', rawPolygon);
    return [];
  }

  try {
    let coordinates = rawPolygon;

    // Handle nested GeoJSON format [[[lng, lat], ...]]
    if (Array.isArray(rawPolygon[0]) && Array.isArray(rawPolygon[0][0])) {
      coordinates = rawPolygon[0];
    }

    // Handle MongoDB numeric and $numberDouble formats
    return coordinates
      .map((point) => {
        let lng, lat;

        // Handle MongoDB $numberDouble format
        lng =
          point[0] && typeof point[0] === 'object' && point[0].$numberDouble
            ? Number(point[0].$numberDouble)
            : Number(point[0]);

        lat =
          point[1] && typeof point[1] === 'object' && point[1].$numberDouble
            ? Number(point[1].$numberDouble)
            : Number(point[1]);

        if (isNaN(lng) || isNaN(lat)) {
          throw new Error(`Invalid coordinate detected: [${point}]`);
        }

        return [lng, lat]; // Always return [longitude, latitude]
      })
      .filter(([lng, lat]) => !isNaN(lng) && !isNaN(lat));
  } catch (err) {
    console.error('[GEOFENCE UTILS] Error normalizing polygon:', err);
    return [];
  }
}

/////////////////////////////
// Point-in-Polygon
/////////////////////////////

function isInsidePolygon(lat, lng, polygon, tolerance = 1e-10) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    console.warn('[GEOFENCE UTILS] Invalid polygon for check.');
    return false;
  }

  const x = parseFloat(lng);
  const y = parseFloat(lat);

  if (isNaN(x) || isNaN(y)) {
    console.error('[GEOFENCE UTILS] Invalid coordinates for polygon check.');
    return false;
  }

  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    // Exact vertex match
    if (Math.abs(x - xi) < tolerance && Math.abs(y - yi) < tolerance) return true;

    // Edge segment check
    if (isPointOnLineSegment([x, y], [xi, yi], [xj, yj], tolerance)) return true;

    // Ray casting
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }

  return inside;
}

/////////////////////////////
// Point on Line Segment
/////////////////////////////

function isPointOnLineSegment(point, lineStart, lineEnd, tolerance = 1e-10) {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  const minX = Math.min(x1, x2) - tolerance;
  const maxX = Math.max(x1, x2) + tolerance;
  const minY = Math.min(y1, y2) - tolerance;
  const maxY = Math.max(y1, y2) + tolerance;

  if (x < minX || x > maxX || y < minY || y > maxY) return false;

  const cross = Math.abs((x - x1) * (y2 - y1) - (y - y1) * (x2 - x1));
  if (cross > tolerance) return false;

  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  const lenSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;

  return dot >= -tolerance && dot <= lenSq + tolerance;
}

/////////////////////////////
// Distance (Haversine)
/////////////////////////////

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/////////////////////////////
// Point Within Radius
/////////////////////////////

function isWithinRadius(lat, lng, polygonCoordinates, radiusMeters) {
  if (!Array.isArray(polygonCoordinates) || polygonCoordinates.length === 0)
    return false;

  const center = polygonCoordinates.reduce(
    (acc, [lngPoint, latPoint]) => {
      acc.lat += latPoint;
      acc.lng += lngPoint;
      return acc;
    },
    { lat: 0, lng: 0 }
  );

  center.lat /= polygonCoordinates.length;
  center.lng /= polygonCoordinates.length;

  const distance = calculateDistance(lat, lng, center.lat, center.lng);
  return distance <= radiusMeters;
}

/////////////////////////////
// Unified Validation
/////////////////////////////

function validateGeofence(lat, lng, rawPolygon, radiusMeters = 50) {
  if (!Array.isArray(rawPolygon)) {
    console.error('[GEOFENCE UTILS] Invalid polygon input for validation.');
    return false;
  }

  const polygon = normalizePolygon(rawPolygon);

  if (polygon.length < 3) {
    console.warn('[GEOFENCE UTILS] Polygon too small, falling back to radius check.');
  }

  const insidePoly = polygon.length >= 3 ? isInsidePolygon(lat, lng, polygon) : false;
  const withinRadius = isWithinRadius(lat, lng, polygon, radiusMeters);

  console.log(`[GEOFENCE UTILS] insidePolygon=${insidePoly}, withinRadius=${withinRadius}`);

  return insidePoly || withinRadius;
}

/////////////////////////////
// Exports
/////////////////////////////

module.exports = {
  normalizePolygon,
  isInsidePolygon,
  isPointOnLineSegment,
  calculateDistance,
  isWithinRadius,
  validateGeofence,
};
