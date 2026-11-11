
// Constants
const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculate distance between two geographical points using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point  
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = EARTH_RADIUS_METERS;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// Realtime route_id -> public route name (20 -> "2", 2 -> "KPL"). Stripping the trailing zero instead
// merged train lines with buses (KPL/2, MEL/3, WRL/4).
function routeName(routeId) {
    return window.ROUTE_META?.[routeId]?.name ?? String(routeId);
}

/**
 * Stop arrivals that happened (arrival time in the past) and haven't been seen yet.
 * Trip updates carry one stop per trip: the latest stop, or a prediction for the next one.
 * @param {Array} updates - GTFS-RT trip update entities
 * @param {Map} seen - trip_id -> last stop_sequence returned; updated in place
 * @param {number} nowMs
 */
function newArrivals(updates, seen, nowMs) {
    const out = [];
    for (const u of updates || []) {
        const tu = u.trip_update;
        const s = tu?.stop_time_update;
        const time = s?.arrival?.time * 1000;
        if (!time || s.stop_sequence == null || time > nowMs) continue;
        const trip = tu.trip.trip_id;
        if ((seen.get(trip) ?? -1) >= s.stop_sequence) continue;
        seen.set(trip, s.stop_sequence);
        out.push({ trip, vehicleId: tu.vehicle?.id, route: routeName(tu.trip.route_id), stopId: s.stop_id, time, delay: s.arrival.delay ?? 0 });
    }
    return out;
}

// Ferries report AIS-style vessel ids (9 digits, New Zealand prefix 512) and no route or trip; they run the ferry route
const isVessel = id => /^512\d{6}$/.test(String(id));
let ferryName = null;

// Route name for a GTFS-RT vehicle position (entity.vehicle)
function vehicleRoute(vehicle) {
    const routeId = vehicle?.trip?.route_id;
    if (routeId == null && isVessel(vehicle?.vehicle?.id)) {
        ferryName ??= Object.values(window.ROUTE_META || {}).find(m => m.type === 4)?.name ?? 'Ferry';
        return ferryName;
    }
    return routeName(routeId);
}

let metaByName = null;
// Route metadata by route name: { name, type, km, n (stops per trip), stops (ferries) }
function routeMeta(name) {
    metaByName ??= Object.fromEntries(Object.values(window.ROUTE_META || {}).map(m => [m.name, m]));
    return metaByName[name];
}

// GTFS route_type for a route name (2 rail, 3 bus, 4 ferry, 5 cable car, 712 school)
function routeType(name) {
    return routeMeta(name)?.type ?? 3;
}

/**
 * Where a sound sits relative to the listener (the map view centre): pan -1..1, near 0..1.
 * Zoomed in, sounds pan by direction and fade with distance. Zoomed out past ~25 km the view is the
 * whole region, so it falls back to rankPan (spreads the dense city evenly) with no distance cue.
 * local is the unblended distance cue, for sounds that should only exist when zoomed in.
 * @param {{lat:number, lon:number, radius:number, hw?:number, hh?:number}} listener - radius: view half-diagonal (m);
 *   hw, hh: half the view's width and height (m). The falloff has the screen's shape: sound fades towards its edges.
 */
// 0 zoomed in (view radius <= 5 km) .. 1 zoomed out to the region (>= 25 km); everything zoom-dependent blends on this
function overviewWeight(radius) {
    return Math.max(0, Math.min(1, (radius - 5000) / 20000));
}

// Offset from the listener in metres (dx east, dy north), and e: distance in screen units, 1 at the middle of each edge
function viewOffset(lat, lon, listener) {
    const dx = (lon - listener.lon) * 111320 * Math.cos(listener.lat * Math.PI / 180);
    const dy = (lat - listener.lat) * 110540;
    const hw = listener.hw ?? 0.7 * listener.radius, hh = listener.hh ?? 0.7 * listener.radius;
    return { dx, dy, hw, hh, e: Math.hypot(dx / hw, dy / hh) };
}

function spatial(lat, lon, listener, rankPan) {
    if (lat == null || lon == null) return { pan: 0, near: 0.5, local: 0 };
    const { dx, hw, e } = viewOffset(lat, lon, listener);
    const localPan = dx / Math.sqrt(dx * dx + (0.6 * hw) ** 2); // ~0.86 at the screen's side edge
    const localNear = 1 / (1 + (e / 0.7) ** 2); // half strength 70% of the way to the edge, a third at the edge
    const w = overviewWeight(listener.radius);
    return { pan: localPan + (rankPan - localPan) * w, near: localNear + (1 - localNear) * w, local: localNear * (1 - w) };
}

window.Utils = {
    calculateDistance,
    routeName,
    vehicleRoute,
    routeType,
    routeMeta,
    newArrivals,
    spatial,
    viewOffset,
    overviewWeight
};
