// Colour = sound: a bus takes the colour of its note (D pentatonic degrees), a train the colour of its line
const NOTE_COLORS = { 0: '#5eead4', 2: '#7dd3fc', 4: '#a5b4fc', 7: '#86efac', 9: '#d8b4fe' }; // D E F# A B
const LINE_COLORS = { KPL: '#fbbf24', HVL: '#fb923c', MEL: '#fdba74', JVL: '#facc15', WRL: '#f87171' };
const FERRY_COLOR = '#4f9dff';
const OCCUPANCY = ['empty', 'many seats', 'few seats', 'standing room', 'packed', 'full']; // GTFS-RT occupancy_status
const RIPPLE_SHAPES = { city: [0, 0], hutt: [6, 0], north: [3, -Math.PI / 2], rail: [4, Math.PI / 4], special: [4, 0] }; // [sides, rotation]
const mixHex = (a, b, t) => '#' + [1, 3, 5].map(i =>
  Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`); // API text into innerHTML

class BusSynthApp {
  constructor() {
    this.wsClient = null;
    this.audio = null;
    this.mapManager = null;
    this.isAudioStarted = false;
    this.bounds = null;
    this.stops = [];
    this.stopsById = new Map();
    this.sortedStopLons = []; // for rank-based panning
    this.routeBusData = new Map(); // route -> lagged buses
    this.routeStates = new Map(); // route -> { n, delay, kmh, bunched, lon }
    this.seenStops = new Map(); // trip_id -> last stop_sequence played
    this.vehicleTrip = new Map(); // vehicle id -> trip_id from positions, to spot turnarounds
    this.docked = new Set(); // ferry ids currently at a wharf
    this.wharves = Object.values(window.ROUTE_META || {}).filter(m => m.type === 4).flatMap(m => m.stops || []); // [lat, lon, name]
    this.vehicleDelay = new Map(); // vehicle id -> signed delay (s)
    this.vehicleOccupancy = new Map(); // vehicle id -> GTFS-RT occupancy_status
    this.lastStatePositions = new Map(); // bus id -> { lat, lon, t, kmh } for speed
    this.arrivalTimes = []; // recent arrival times, for the city arrival rate
    this.listenerPos = null; // map view centre + radius: where you're listening from

    // UI elements
    this.audioToggleBtn = document.getElementById('audio-toggle-btn');
    this.volumeSlider = document.getElementById('volume-slider');
    this.volumeValue = document.getElementById('volume-value');
    this.modes = { pitch: 'length', drone: 'emergent' };
    this.connectionStatus = document.getElementById('connection-status');
    this.connectionDot = document.getElementById('connection-dot');
    this.audioStatus = document.getElementById('audio-status');
    this.countBuses = document.getElementById('count-buses');
    this.countTrains = document.getElementById('count-trains');
    this.countFerries = document.getElementById('count-ferries');
    this.followPill = document.getElementById('follow-pill');
    this.routesCount = document.getElementById('routes-count');
    this.arrivalsCount = document.getElementById('arrivals-count');
    this.delaysCount = document.getElementById('delays-count');
    this.reticle = document.getElementById('reticle');
    this.listening = document.getElementById('listening');

    // Audio events display elements
    this.activeRoutesDisplay = document.getElementById('active-routes');
    this.recentArrivalsDisplay = document.getElementById('recent-arrivals');
    this.delayEventsDisplay = document.getElementById('delay-events');
    this.clearEventsBtn = document.getElementById('clear-events');

    this.maxEventHistory = 12;

    this.bindEvents();
    this.clearAudioEvents();
    this.updateActiveRoutesDisplay();
  }

  bindEvents() {
    this.audioToggleBtn.addEventListener('click', () => this.toggleAudio());

    this.volumeSlider.addEventListener('input', (e) => {
      const volume = parseInt(e.target.value);
      this.volumeValue.textContent = `${volume}%`;
      if (this.audio) {
        this.audio.setVolume(volume / 100);
      }
    });

    const checked = name => document.querySelector(`input[name="${name}"]:checked`).value;
    document.querySelectorAll('input[name="pitch-mode"], input[name="drone-mode"]').forEach(input =>
      input.addEventListener('change', () => {
        this.modes = { pitch: checked('pitch-mode'), drone: checked('drone-mode') };
        this.audio?.setModes(this.modes);
        this.updateActiveRoutesDisplay();
      }));

    this.clearEventsBtn.addEventListener('click', () => this.clearAudioEvents());
    document.getElementById('follow-stop').addEventListener('click', () => this.mapManager?.unfollow());

    const panel = document.getElementById('panel');
    const toggle = document.getElementById('toggle-events');
    const setOpen = open => {
      panel.classList.toggle('collapsed', !open);
      toggle.setAttribute('aria-expanded', open);
      toggle.title = open ? 'Hide panel' : 'Show panel';
      if (open) this.updateActiveRoutesDisplay();
    };
    toggle.addEventListener('click', () => setOpen(panel.classList.contains('collapsed')));
    if (window.matchMedia('(max-width: 640px)').matches) setOpen(false); // phones: start with the map

    // Intro popup on start. "Start listening" is also the click browsers need before audio may play.
    const intro = document.getElementById('intro');
    const showIntro = () => { intro.showModal(); intro.scrollTop = 0; }; // focus lands on the button; start at the top
    showIntro();
    document.getElementById('intro-listen').addEventListener('click', () => { intro.close(); this.startAudio(); });
    intro.addEventListener('click', e => { // a click on the backdrop, outside the card, closes it
      const r = intro.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) intro.close();
    });
    document.getElementById('about-btn').addEventListener('click', showIntro);
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(btn => btn.addEventListener('click', () => {
      tabs.forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', b === btn); });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `${btn.dataset.tab}-tab`));
    }));
  }

  async initialize() {
    try {
      // Fetch initial data
      const stopsResponse = await fetch('api/stops');
      if (!stopsResponse.ok) throw new Error('Failed to fetch stops');

      this.stops = await stopsResponse.json();
      this.stopsById = new Map(this.stops.map(s => [s.stop_id, s]));
      this.sortedStopLons = this.stops.map(s => s.stop_lon).sort((a, b) => a - b);
      this.calculateBounds();

      // Initialize map
      this.mapManager = new InterpolatedMapManager('map-container', {
        colorFor: route => this.colorFor(route),
        describe: (id, route) => this.describe(id, route),
        onFollow: (id, route) => this.showFollowing(id, route)
      });
      await this.mapManager.initialize(this.stops, this.bounds);

      // Handle window resize for map
      window.addEventListener('resize', () => {
        if (this.mapManager) {
          this.mapManager.resize();
        }
      });

      this.audio = new RouteSynth({ place: (lat, lon) => this.place(lat, lon) });
      this.mapManager.map.on('moveend', () => this.updateRouteStates()); // re-place sound as soon as the view settles
      // ...and keep re-placing it while the camera moves (about 8 times a second), not just when it stops
      this.mapManager.map.on('move', () => {
        this.moveTimer ??= setTimeout(() => { this.moveTimer = null; this.updateRouteStates(); }, 120);
      });
      this.mapManager.map.on('move zoom resize', () => this.updateReticle());
      this.audio.setModes(this.modes);
      this.updateReticle();

      // Initialize WebSocket
      this.wsClient = new WebSocketClient();
      this.wsClient.onMessage = (data) => this.handleWebSocketMessage(data);
      this.wsClient.onStatusChange = (status) => this.updateConnectionStatus(status);
      this.wsClient.connect();

      // Route states follow the map's interpolated (lagged) positions, so sample them continuously
      this.stateTimer = setInterval(() => this.updateRouteStates(), 2000);


    } catch (error) {
      console.error('Initialization failed:', error);
    }
  }

  // Initial view: Wellington, Porirua and the Hutt, where most service runs. Framing every stop reaches Masterton
  // and leaves Wellington in a corner; at this zoom the whole region (Kāpiti, Wairarapa) is still heard.
  calculateBounds() {
    this.bounds = [[-41.35, -41.05], [174.72, 175.08]];
  }

  // Pan by a longitude's rank among all stops, not its raw value: the region stretches east to
  // Masterton, so linear mapping pushed ~95% of activity hard left.
  panFor(lon) {
    const a = this.sortedStopLons;
    if (lon == null || a.length === 0) return 0;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < lon) lo = mid + 1; else hi = mid;
    }
    return (lo / a.length) * 2 - 1;
  }

  // The listener sits at the map view centre. Sound is at half strength at the crosshair ring, whose diameter is the
  // screen's shorter side (full height on a desktop); radius (view half-diagonal) sets how zoomed out the view is.
  listener() {
    const map = this.mapManager?.map;
    if (!map) return { lat: -41.28, lon: 174.78, radius: 40000, hear: 16000 };
    const c = map.getCenter(), ne = map.getBounds().getNorthEast(), size = map.getSize();
    const radius = Utils.calculateDistance(c.lat, c.lng, ne.lat, ne.lng);
    return { lat: c.lat, lon: c.lng, radius, hear: radius * Math.min(size.x, size.y) / Math.hypot(size.x, size.y) };
  }

  place(lat, lon) {
    return Utils.spatial(lat, lon, this.listenerPos || this.listener(), this.panFor(lon));
  }

  toggleAudio() {
    if (this.isAudioStarted) {
      this.stopAudio();
    } else {
      this.startAudio();
    }
  }

  async startAudio() {
    if (this.isAudioStarted) return;

    try {
      await this.audio.start(this.volumeSlider.value / 100);
      this.isAudioStarted = true;
      this.setPlaying(true);
      this.updateRouteStates();
    } catch (error) {
      console.error('Start audio failed:', error);
      this.setPlaying(false);
    }
  }

  stopAudio() {
    if (!this.isAudioStarted) return;

    this.audio.stop();
    this.isAudioStarted = false;
    this.setPlaying(false);
  }

  setPlaying(playing) {
    this.audioToggleBtn.setAttribute('aria-pressed', playing);
    this.audioStatus.textContent = playing ? 'Stop' : 'Listen';
  }

  handleWebSocketMessage(data) {
    if (data.type === 'bus_update') {
      this.processBusUpdate(data.buses, data.isHistorical);
      this.processTripUpdates(data.updates);
    }
  }

  processBusUpdate(buses, isHistorical = false) {
    this.mapManager.updateBuses(buses, isHistorical);

    const lag = SHARED_CONSTANTS.MAP.TIMING.DISPLAY_LAG_MS;
    buses.forEach(bus => {
      const v = bus.vehicle;
      const id = v?.vehicle?.id;
      if (!id) return;
      if (v.occupancy_status != null) this.vehicleOccupancy.set(id, v.occupancy_status);
      // Turnaround: the feed assigns the vehicle its next trip at the terminus (~2-5 a minute city-wide).
      // Played after the map's display lag, where the vehicle is on screen.
      const trip = v.trip?.trip_id;
      const prev = this.vehicleTrip.get(id);
      if (trip) this.vehicleTrip.set(id, trip);
      if (!isHistorical && prev && trip && prev !== trip && this.mapManager.validPosition(bus)) {
        const ev = { route: Utils.routeName(v.trip.route_id), lat: v.position.latitude, lon: v.position.longitude };
        setTimeout(() => {
          this.mapManager.pulseAt(ev.lat, ev.lon, { color: this.colorFor(ev.route), kind: 'turnaround', duration: 2400 });
          if (this.isAudioStarted) this.audio.turnaround(ev);
        }, lag);
      }
    });

    if (isHistorical) return;

    this.routeBusData = this.mapManager.getCurrentLaggedRouteData();
    this.updateCounts();
    this.updateActiveRoutesDisplay();
  }

  // Each newly confirmed stop arrival is replayed at its real time plus the map's display lag,
  // so the note, the stop pulse and the bus on the map line up.
  processTripUpdates(updates) {
    const now = Date.now();
    const lag = SHARED_CONSTANTS.MAP.TIMING.DISPLAY_LAG_MS;

    (updates || []).forEach(u => {
      const vid = u.trip_update?.vehicle?.id;
      const delay = u.trip_update?.stop_time_update?.arrival?.delay;
      if (vid && delay != null) this.vehicleDelay.set(vid, delay);
    });

    Utils.newArrivals(updates, this.seenStops, now).forEach(a => {
      const playIn = a.time + lag - now;
      if (playIn < -5000) return; // reported too late to line up with the map (~2% of arrivals)

      const stop = this.stopsById.get(a.stopId);
      const ev = {
        route: a.route,
        stopId: a.stopId,
        lat: stop?.stop_lat,
        lon: stop?.stop_lon,
        delay: a.delay,
        occupancy: this.vehicleOccupancy.get(a.vehicleId)
      };
      // Arrival times are whole seconds; spread each within its second so the dings don't lock to a 1 s grid
      setTimeout(() => this.playArrival(ev), Math.max(0, playIn) + Math.random() * 1000);
    });
    // ponytail: seenStops grows by ~4.5k trips a day; fine for a session, clear it if this runs for weeks
  }

  playArrival(ev) {
    this.arrivalTimes.push(Date.now());
    // Ripple: colour = route, shape = area, late = ragged/red/slow, early = implodes
    const late = Math.max(0, Math.min(1, (ev.delay - 60) / 540));
    const early = Math.max(0, Math.min(1, (-ev.delay - 60) / 240));
    const [sides, rot] = RIPPLE_SHAPES[routeFamily(ev.route)] || [0, 0];
    if (ev.lat != null) this.mapManager.pulseAt(ev.lat, ev.lon, {
      color: mixHex(this.colorFor(ev.route), '#fb7185', late), size: Utils.routeType(ev.route) === 2 ? 1.4 : 0.9,
      sides, rot, late, early, duration: 1600 * (1 + 0.8 * late)
    });
    this.addArrivalEvent(ev.route, ev.stopId, ev.delay);
    if (ev.delay > 180) this.addDelayEvent(ev.route, ev.delay, ev.stopId);
    if (this.isAudioStarted) this.audio.arrival(ev);
  }

  updateRouteStates() {
    if (!this.mapManager) return;
    this.listenerPos = this.listener();
    this.updateReticle();
    const overview = Utils.overviewWeight(this.listenerPos.radius);
    const routes = this.mapManager.getCurrentLaggedRouteData();
    const now = Date.now();
    const positions = new Map();
    const states = new Map();
    const trains = [];
    const ferries = [];
    const buses = [];
    let total = 0, bunchedTotal = 0, delaySum = 0, delayN = 0, early = 0;

    routes.forEach((list, route) => {
      const type = Utils.routeType(route);
      let kmh = 0, nk = 0, delay = 0, nd = 0, latSum = 0, lonSum = 0, bunched = 0, nearest = null;
      list.forEach((bus, i) => {
        const p = bus.position;
        // Speed over >=20 s: the map eases each 10 s report, so shorter windows pulse with the poll clock
        let pos = this.lastStatePositions.get(bus.id);
        if (!pos || now - pos.t >= 20000) {
          const v = pos ? Utils.calculateDistance(pos.lat, pos.lon, p.latitude, p.longitude) / ((now - pos.t) / 1000) * 3.6 : null;
          pos = { lat: p.latitude, lon: p.longitude, t: now, kmh: v > 130 ? null : v }; // >130: lagged position jumped (new trip / reappeared)
        }
        positions.set(bus.id, pos);
        if (pos.kmh != null) { kmh += pos.kmh; nk++; }
        const d = this.vehicleDelay.get(bus.id);
        if (d != null) { delay += d; nd++; delaySum += d; delayN++; if (d < -60) early++; }
        latSum += p.latitude;
        lonSum += p.longitude;
        const place = this.place(p.latitude, p.longitude);
        if (!nearest || place.near > nearest.near) nearest = { lat: p.latitude, lon: p.longitude, near: place.near };
        const vehicle = { id: bus.id, route, lat: p.latitude, lon: p.longitude, kmh: pos.kmh };
        if (type === 2) trains.push(vehicle);
        else if (type === 4) ferries.push(vehicle);
        else buses.push({ ...vehicle, place });
        // Bunched: another vehicle on the route within 300 m heading roughly the same way
        for (let j = i + 1; j < list.length; j++) {
          const q = list[j].position;
          const headingDiff = Math.abs(((p.bearing - q.bearing + 540) % 360) - 180);
          if (headingDiff < 60 && Utils.calculateDistance(p.latitude, p.longitude, q.latitude, q.longitude) < 300) bunched++;
        }
      });
      const n = list.length;
      total += n;
      bunchedTotal += bunched;
      // A route sounds from its bus nearest you when zoomed in, sliding to its centroid as you zoom out
      states.set(route, {
        n, kmh: nk ? kmh / nk : 0, delay: nd ? delay / nd : 0, bunched,
        lat: nearest.lat + (latSum / n - nearest.lat) * overview,
        lon: nearest.lon + (lonSum / n - nearest.lon) * overview,
        partner: null, contact: 0
      });
    });

    // Shared road: count bus pairs from different routes within 250 m of each other. A route's contact is
    // how much it's mixing with other routes right now; its partner is the route it's mixing with most.
    const pairs = new Map();
    const bump = (a, b) => {
      if (!pairs.has(a)) pairs.set(a, new Map());
      pairs.get(a).set(b, (pairs.get(a).get(b) || 0) + 1);
    };
    const mPerLon = 111320 * Math.cos(-41.3 * Math.PI / 180);
    for (let i = 0; i < buses.length; i++) {
      for (let j = i + 1; j < buses.length; j++) {
        const a = buses[i], b = buses[j];
        if (a.route === b.route || Math.abs(a.lat - b.lat) > 0.0023) continue;
        const dx = (a.lon - b.lon) * mPerLon, dy = (a.lat - b.lat) * 110540;
        if (dx * dx + dy * dy < 250 * 250) { bump(a.route, b.route); bump(b.route, a.route); }
      }
    }
    pairs.forEach((others, route) => {
      const s = states.get(route);
      let best = 0;
      others.forEach((count, other) => {
        s.contact += count;
        if (count > best) { best = count; s.partner = other; }
      });
    });

    // Traffic around the listener (zoomed in only): idling vs moving buses, weighted by closeness
    const traffic = { idle: 0, moving: 0, speed: 0, pan: 0 };
    let weight = 0, kmhSum = 0, kmhN = 0;
    buses.forEach(b => {
      if (b.kmh == null) return;
      kmhSum += b.kmh;
      kmhN++;
      const w = b.place.local;
      if (b.kmh < 3) traffic.idle += w; else { traffic.moving += w; traffic.speed += w * b.kmh; }
      traffic.pan += w * b.place.pan;
      weight += w;
    });
    if (traffic.moving) traffic.speed /= traffic.moving;
    if (weight) traffic.pan /= weight;

    this.detectDocking(ferries);
    this.arrivalTimes = this.arrivalTimes.filter(t => now - t < 60000);
    this.lastStatePositions = positions;
    this.routeStates = states;
    if (!this.isAudioStarted) return;
    this.audio.update({
      zoom: overview,
      routes: states,
      trains,
      ferries,
      traffic,
      city: {
        total,
        meanDelay: delayN ? delaySum / delayN : 0,
        earlyFrac: delayN ? early / delayN : 0,
        kmh: kmhN ? kmhSum / kmhN : 0,
        bunchedFrac: total ? bunchedTotal / total : 0,
        arrivalsPerMin: this.arrivalTimes.length
      }
    });
  }

  // Docking: a ferry within 150 m of a wharf and (nearly) stopped. It has to get 400 m away before it can dock again,
  // so bobbing at the wharf doesn't retrigger. Positions are the map's lagged ones, so this lines up with the picture.
  detectDocking(ferries) {
    for (const f of ferries) {
      let best = null;
      for (const [lat, lon, name] of this.wharves) {
        const d = Utils.calculateDistance(f.lat, f.lon, lat, lon);
        if (!best || d < best.d) best = { d, lat, lon, name };
      }
      if (!best) continue;
      if (!this.docked.has(f.id) && best.d < 150 && (f.kmh == null || f.kmh < 5)) {
        this.docked.add(f.id);
        this.arrivalTimes.push(Date.now());
        this.mapManager.pulseAt(best.lat, best.lon, { kind: 'ferry', color: FERRY_COLOR, duration: 3200 });
        this.addArrivalEvent(f.route, best.name, 0);
        if (this.isAudioStarted) this.audio.ferryArrival({ id: f.id, route: f.route, lat: best.lat, lon: best.lon });
      } else if (this.docked.has(f.id) && best.d > 400) {
        this.docked.delete(f.id);
      }
    }
  }

  // Hover tooltip: route chip, kind and note; then lateness, speed and how full it is (whatever the feed knows)
  describe(id, route) {
    const type = Utils.routeType(route);
    const kind = { 2: 'Train', 4: 'Ferry' }[type] ?? 'Bus';
    const delay = this.vehicleDelay.get(id);
    const kmh = this.lastStatePositions.get(id)?.kmh;
    const facts = [
      delay != null && type !== 4 ? this.delayTag(delay) : '',
      kmh != null ? `${Math.round(kmh)} km/h` : '',
      OCCUPANCY[this.vehicleOccupancy.get(id)] ?? ''
    ].filter(Boolean);
    return `<div class="tip-head"><span class="chip" style="--c:${this.colorFor(route)}">${esc(route)}</span><b>${kind}</b><span class="tip-note">${this.audio.noteName(route)}</span></div>` +
      (facts.length ? `<div class="tip-facts">${facts.join('<i>·</i>')}</div>` : '') +
      `<div class="tip-hint">${this.mapManager.following === id ? 'Following' : 'Click to follow'}</div>`;
  }

  showFollowing(id, route) {
    this.followPill.hidden = !id;
    if (id) this.followPill.querySelector('span').innerHTML = `Following <span class="chip" style="--c:${this.colorFor(route)}">${esc(route)}</span>`;
  }

  colorFor(route) {
    const type = Utils.routeType(route);
    if (type === 2) return LINE_COLORS[route] || '#fbbf24';
    if (type === 4) return FERRY_COLOR;
    const semis = Math.round(12 * Math.log2(routePitch(route, this.modes.pitch) / 73.42));
    return NOTE_COLORS[((semis % 12) + 12) % 12] || '#5eead4';
  }

  // Crosshair ring: where sound is at half strength. Fades out when zoomed right out (then everything is heard).
  updateReticle() {
    if (!this.mapManager?.map) return;
    const l = this.listener();
    const size = this.mapManager.map.getSize();
    this.reticle.style.setProperty('--ring', `${Math.min(size.x, size.y)}px`);
    this.reticle.style.setProperty('--ring-opacity', (1 - Utils.overviewWeight(l.radius)).toFixed(2));
    this.listening.textContent = `${(l.hear / 1000).toFixed(1)} km`;
  }

  updateCounts() {
    let buses = 0, trains = 0, ferries = 0;
    this.routeBusData.forEach((list, route) => {
      const type = Utils.routeType(route);
      if (type === 2) trains += list.length; else if (type === 4) ferries += list.length; else buses += list.length;
    });
    this.countBuses.textContent = buses;
    this.countTrains.textContent = trains;
    this.countFerries.textContent = ferries;
    this.countFerries.parentElement.hidden = !ferries;
    this.countFerries.nextSibling.textContent = ferries === 1 ? ' ferry' : ' ferries';
    this.routesCount.textContent = this.routeBusData.size;
  }

  updateActiveRoutesDisplay() {
    if (document.getElementById('panel').classList.contains('collapsed')) return;
    const routes = [...this.routeBusData].filter(([, list]) => list.length).sort((a, b) => b[1].length - a[1].length);
    if (!routes.length) {
      this.activeRoutesDisplay.innerHTML = '<div class="no-events">Waiting for vehicles…</div>';
      return;
    }
    const max = routes[0][1].length;
    this.activeRoutesDisplay.innerHTML = routes.map(([route, list]) => {
      const kind = { 2: 'train', 4: 'ferry' }[Utils.routeType(route)];
      const what = kind ? kind + (list.length > 1 ? 's' : '') : (list.length > 1 ? 'buses' : 'bus');
      return `<div class="row" style="--c:${this.colorFor(route)}">
        <span class="chip">${esc(route)}</span>
        <span class="main"><span class="sub">${list.length} ${what} · ${this.audio.noteName(route)}</span><span class="bar" style="--w:${(list.length / max).toFixed(3)}"></span></span>
        ${this.delayTag(this.routeStates.get(route)?.delay ?? 0)}
      </div>`;
    }).join('');
  }

  eventRow(route, stopId, delay) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `<div class="row fresh" style="--c:${this.colorFor(route)}">
      <span class="chip">${esc(route)}</span>
      <span class="main"><span class="name">${esc(this.stopsById.get(stopId)?.stop_name || stopId)}</span><span class="sub mono">${time}</span></span>
      ${this.delayTag(delay)}
    </div>`;
  }

  pushRow(list, html) {
    list.querySelector('.no-events')?.remove();
    list.insertAdjacentHTML('afterbegin', html);
    while (list.children.length > this.maxEventHistory) list.lastElementChild.remove();
  }

  addArrivalEvent(route, stopId, delay) {
    this.pushRow(this.recentArrivalsDisplay, this.eventRow(route, stopId, delay));
    this.arrivalsCount.textContent = `${this.arrivalTimes.length}/min`;
  }

  addDelayEvent(route, delay, stopId) {
    this.pushRow(this.delayEventsDisplay, this.eventRow(route, stopId, delay));
    this.delaysCount.textContent = Number(this.delaysCount.textContent) + 1;
  }

  delayTag(delay) {
    if (delay < -60) return `<span class="tag early">${Math.round(-delay / 60)}m early</span>`;
    if (delay <= 60) return '<span class="tag">on time</span>';
    return `<span class="tag ${delay > 300 ? 'very-late' : 'late'}">${Math.round(delay / 60)}m late</span>`;
  }

  clearAudioEvents() {
    this.recentArrivalsDisplay.innerHTML = '<div class="no-events">No arrivals yet</div>';
    this.delayEventsDisplay.innerHTML = '<div class="no-events">Nobody more than 3 minutes late</div>';
    this.delaysCount.textContent = 0;
  }

  updateConnectionStatus(status) {
    const state = status === 'Connected' ? 'connected' : /Error|Failed/.test(status) ? 'error' : 'connecting';
    this.connectionDot.className = `dot ${state}`;
    this.connectionDot.title = status;
    this.connectionStatus.textContent = status;
  }

  dispose() {
    clearInterval(this.stateTimer);
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
    if (this.isAudioStarted) {
      this.audio.stop();
    }
    if (this.mapManager) {
      this.mapManager.dispose();
    }

    this.seenStops.clear();
    this.vehicleTrip.clear();
    this.vehicleDelay.clear();
    this.vehicleOccupancy.clear();

    // Clear audio events display
    this.clearAudioEvents();
  }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
  window.app = new BusSynthApp();
  window.app.initialize();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (window.app) {
    window.app.dispose();
  }
});
