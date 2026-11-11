// Canvas layer for stops and events. Idle stops are faint dots that recede into the map; events are ripples:
// an arrival is a ring in the route's colour whose shape is the route's area (circle, hexagon, triangle, square);
// late arrivals break up, wobble, redden and linger, early ones implode. A turnaround is a broken square that jitters;
// a docking ferry sends out slow water rings.
class CanvasStopsLayer extends L.Layer {
  constructor(stops, options = {}) {
    super();
    this.stops = stops;
    this.stopsById = new Map(stops.map(s => [s.stop_id, s]));
    this.options = { stopColor: '#3a4456', ...options };
    this.canvas = null; // ripples, animated at up to 30 fps while there are any
    this.ctx = null;
    this.base = null; // idle stops, on their own canvas so ripple frames don't repaint them
    this.baseCtx = null;
    this.lastDraw = 0;
    this.pixelRatio = window.devicePixelRatio || 1;
    this.ripples = []; // { lat, lon, start, duration, size, color, kind }
    this.animationFrame = null;
    this.updateTimeout = null;
  }

  onAdd(map) {
    this.map = map;
    this.base = L.DomUtil.create('canvas', 'leaflet-canvas-stops-layer');
    Object.assign(this.base.style, { position: 'absolute', pointerEvents: 'none', zIndex: '200' });
    this.map.getPanes().overlayPane.appendChild(this.base);
    this.baseCtx = this.base.getContext('2d');
    this.canvas = L.DomUtil.create('canvas', 'leaflet-canvas-stops-layer');
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', zIndex: '201' });
    this.map.getPanes().overlayPane.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    map.on('zoom viewreset zoomend', this.reset, this);
    map.on('move moveend', this.updatePosition, this);
    map.on('resize', this.resize, this);
    return this;
  }

  onRemove(map) {
    map.off('zoom viewreset zoomend', this.reset, this);
    map.off('move moveend', this.updatePosition, this);
    map.off('resize', this.resize, this);
    clearTimeout(this.updateTimeout);
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.canvas?.remove();
    this.base?.remove();
    return this;
  }

  resize() {
    if (!this.canvas) return;
    const size = this.map.getSize();
    this.canvas.width = size.x * this.pixelRatio;
    this.canvas.height = size.y * this.pixelRatio;
    this.canvas.style.width = size.x + 'px';
    this.canvas.style.height = size.y + 'px';
    this.base.width = this.canvas.width;
    this.base.height = this.canvas.height;
    this.base.style.width = this.canvas.style.width;
    this.base.style.height = this.canvas.style.height;
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.baseCtx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.reset();
  }

  reset() {
    if (!this.canvas) return;
    const origin = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, origin);
    L.DomUtil.setPosition(this.base, origin);
    this.drawStops();
    this.redraw();
  }

  // Idle stops: barely there, a little firmer as you zoom in. Drawn only when the view changes.
  drawStops() {
    const ctx = this.baseCtx;
    const size = this.map.getSize();
    const zoom = this.map.getZoom();
    const r = zoom >= 15 ? 2 : zoom >= 13 ? 1.4 : 1;
    const bounds = this.map.getBounds().pad(0.05);
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.fillStyle = this.options.stopColor;
    ctx.globalAlpha = zoom >= 13 ? 0.8 : 0.5;
    ctx.beginPath();
    for (const stop of this.stops) {
      if (!bounds.contains([stop.stop_lat, stop.stop_lon])) continue;
      const p = this.map.latLngToContainerPoint([stop.stop_lat, stop.stop_lon]);
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  updatePosition() {
    clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(() => this.reset(), 16);
  }

  forceRedraw() {
    this.reset();
  }

  redraw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const size = this.map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    const zoom = this.map.getZoom();

    const now = performance.now();
    this.lastDraw = now;
    const scale = Math.max(0.7, Math.min(1.7, 1 + 0.18 * (zoom - 13))); // same zoom scaling as vehicles
    this.ripples = this.ripples.filter(rp => now - rp.start < rp.duration);
    for (const rp of this.ripples) {
      const p = this.map.latLngToContainerPoint([rp.lat, rp.lon]);
      const t = (now - rp.start) / rp.duration;
      const ease = 1 - (1 - t) ** 3;
      ctx.strokeStyle = rp.color;
      ctx.fillStyle = rp.color;
      if (rp.kind === 'ferry') {
        // Ferry docking: three slow water rings, a little wobbly, one after another
        ctx.lineWidth = 1.6 * Math.min(scale, 1.3);
        for (let k = 0; k < 3; k++) {
          const tk = t - k * 0.18;
          if (tk <= 0) continue;
          ctx.globalAlpha = Math.max(0, 1 - tk) * 0.85;
          this.shape(p.x, p.y, (5 + 36 * (1 - (1 - tk) ** 2)) * scale, 0, 0, 0.05, rp.seed + tk * 6 + k);
          ctx.stroke();
        }
        continue;
      }
      if (rp.kind === 'turnaround') {
        // Broken square that jitters and grows: the glitch bus is replaying this route
        const s = (6 + rp.size * 18 * ease) * scale;
        const j = () => (Math.random() - 0.5) * 3 * (1 - t);
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(p.x - s / 2 + j(), p.y - s / 2 + j(), s, s);
        ctx.setLineDash([]);
        continue;
      }
      // Arrival: expands from the stop (early ones implode onto it), with a fainter echo ring and a core flash
      const max = (6 + rp.size * 20) * scale;
      const radius = rp.early > 0.2 ? max * (1 - 0.8 * ease) : 3 * scale + (max - 3 * scale) * ease;
      const jitter = 0.22 * rp.late * (1 - 0.5 * t);
      const wobble = rp.seed + t * 12 * rp.late;
      ctx.lineWidth = (2.2 * (1 - t) + 0.4) * Math.min(scale, 1.3);
      if (rp.late > 0.1) ctx.setLineDash([Math.max(2, 10 - 8 * rp.late) * scale, (2 + 6 * rp.late) * scale]);
      ctx.globalAlpha = (1 - t) * 0.95;
      this.shape(p.x, p.y, radius, rp.sides, rp.rot, jitter, wobble);
      ctx.stroke();
      ctx.globalAlpha = (1 - t) * 0.35;
      this.shape(p.x, p.y, radius * 0.6, rp.sides, rp.rot, jitter, wobble + 1.7);
      ctx.stroke();
      ctx.setLineDash([]);
      if (t < 0.25) {
        ctx.globalAlpha = 1 - t / 0.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (2.5 + rp.size) * Math.min(scale, 1.3), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    if (this.ripples.length && !this.animationFrame) this.nextFrame();
  }

  nextFrame() { // ripples at up to 30 fps: they're slow enough, and it halves the repaints
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      if (performance.now() - this.lastDraw < 30) this.nextFrame();
      else this.redraw();
    });
  }

  // Polygon ring (sides 0 = circle) with optional per-vertex wobble, for ripples
  shape(x, y, r, sides, rot, jitter, phase) {
    const n = sides || 40;
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const k = 1 + jitter * Math.sin(phase + i * 2.3);
      if (i) ctx.lineTo(x + Math.cos(a) * r * k, y + Math.sin(a) * r * k);
      else ctx.moveTo(x + Math.cos(a) * r * k, y + Math.sin(a) * r * k);
    }
    ctx.closePath();
  }

  // Arrival at a stop. size ~1 for a bus, larger for a train
  animateStopPulse(stopId, size = 1, color = '#ffffff') {
    const stop = this.stopsById.get(stopId);
    if (stop) this.pulseAt(stop.stop_lat, stop.stop_lon, { size, color });
  }

  // opts: size, color, kind ('arrival' | 'turnaround'), duration (ms), sides (0 = circle), rot, late 0..1, early 0..1
  pulseAt(lat, lon, { size = 1, color = '#ffffff', kind = 'arrival', duration = 1600, sides = 0, rot = 0, late = 0, early = 0 } = {}) {
    if (this.ripples.length > 150) this.ripples.shift(); // busy CBD at peak: keep the newest
    this.ripples.push({ lat, lon, start: performance.now(), duration, size, color, kind, sides, rot, late, early, seed: Math.random() * 10 });
    if (!this.animationFrame) this.redraw();
  }
}

window.CanvasStopsLayer = CanvasStopsLayer;
