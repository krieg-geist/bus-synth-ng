// Self-check for arrival extraction, route names and pitch mapping. Run: node scripts/check-arrivals.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {} };
vm.createContext(ctx);
for (const f of ['route-meta.js', 'utils.js', 'route-synth.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', f), 'utf8'), ctx);
}
const { Utils, routePitch } = ctx.window;
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); // vm arrays aren't deepStrictEqual across realms

// Route names: train lines no longer collide with the bus routes they used to be merged with
assert.strictEqual(Utils.routeName(20), '2');
assert.strictEqual(Utils.routeName(2), 'KPL');
assert.strictEqual(Utils.routeName(40), '4');
assert.strictEqual(Utils.routeName(4), 'WRL');
assert.strictEqual(Utils.routeName(123456), '123456');

// Arrivals: past times only, once per (trip, stop_sequence), signed delay kept
const upd = (trip, seq, time, delay, route = 20) => ({
  trip_update: { trip: { trip_id: trip, route_id: route }, vehicle: { id: 'v' + trip },
                 stop_time_update: { stop_id: 's' + seq, stop_sequence: seq, arrival: { time, delay } } }
});
const seen = new Map();
const now = 1_000_000_000;
let a = Utils.newArrivals([upd('a', 5, now / 1000 - 20, -90), upd('b', 3, now / 1000 + 30, 0)], seen, now);
same(a.map(x => [x.trip, x.stopId, x.route, x.delay]), [['a', 's5', '2', -90]]); // b is a prediction
a = Utils.newArrivals([upd('a', 5, now / 1000 - 10, -80), upd('a', 4, now / 1000, 0)], seen, now);
assert.strictEqual(a.length, 0); // repeat and older stop ignored
a = Utils.newArrivals([upd('a', 6, now / 1000, 10), upd('b', 3, now / 1000 - 1, 5, 2)], seen, now);
same(a.map(x => [x.trip, x.route]), [['a', '2'], ['b', 'KPL']]);

// Pitch by length: longer route = lower note
const byLen = r => routePitch(r, 'length');
assert.ok(byLen('WRL') < byLen('KPL') && byLen('KPL') < byLen('2') && byLen('2') < byLen('22'));
// Every pitch in either mode sits on the D pentatonic scale
const D = [0, 2, 4, 7, 9];
for (const r of ['1', '2', '110', '220', 'KPL', 'AX', 'CCL', 'WHF', 'N1', '737', 'unknown']) {
  for (const mode of ['length', 'family']) {
    const semis = Math.round(12 * Math.log2(routePitch(r, mode) / 73.42));
    assert.ok(D.includes(((semis % 12) + 12) % 12), `${r} ${mode}`);
  }
}
// Route types: trains get their own voice
assert.strictEqual(Utils.routeType('KPL'), 2);
assert.strictEqual(Utils.routeType('2'), 3);

// Spatial: the view centre is near and centred, east pans right, far away is quiet;
// zoomed right out it falls back to rank pan with no distance cue
const L = { lat: -41.29, lon: 174.78, radius: 3000 };
let sp = Utils.spatial(-41.29, 174.78, L, 0.5);
assert.ok(Math.abs(sp.pan) < 1e-9 && sp.near > 0.99 && sp.local > 0.99);
assert.ok(Utils.spatial(-41.29, 174.80, L, 0).pan > 0.5);
assert.ok(Utils.spatial(-41.0, 175.2, L, 0).near < 0.05);
// The hearing radius (crosshair ring) sets where sound is at half strength
assert.ok(Math.abs(Utils.spatial(-41.29 + 2000 / 110540, 174.78, { ...L, hear: 2000 }, 0).near - 0.5) < 1e-9);
sp = Utils.spatial(-41.0, 175.2, { ...L, radius: 40000 }, -0.3);
assert.ok(Math.abs(sp.pan + 0.3) < 1e-9 && Math.abs(sp.near - 1) < 1e-9 && sp.local === 0);
console.log('ok');
