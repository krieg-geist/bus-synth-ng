// Canvas layer for vehicle trails. Each trail is a Catmull-Rom spline through the vehicle's recent GPS points, built
// once per new point (every ~10 s) and projected once per zoom level; a frame only offsets, culls and strokes it,
// fading from tail to head. Trails restart after a GPS jump (see InterpolatedMapManager.markJump).
class CanvasTrailsLayer extends L.Layer {
  constructor(options = {}) {
    super();
    this.options = { minOpacity: 0.04, maxOpacity: 0.75, resolution: 3, maxFps: 30, ...options };
    this.trails = new Map(); // busId -> { key, c0, c1, width, pts: [lat, lon, ...], proj, zoom, bbox, head }
    this.pixelRatio = window.devicePixelRatio || 1;
    this.lastDraw = 0;
  }

  onAdd(map) {
    this.map = map;
    this.canvas = L.DomUtil.create('canvas', 'leaflet-canvas-trails-layer');
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', zIndex: '150' });
    map.getPanes().overlayPane.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    map.on('move zoom viewreset zoomend moveend', this.forceRedraw, this);
    map.on('resize', this.resize, this);
    return this;
  }

  onRemove(map) {
    map.off('move zoom viewreset zoomend moveend', this.forceRedraw, this);
    map.off('resize', this.resize, this);
    this.canvas?.remove();
    this.ctx = null;
    return this;
  }

  resize() {
    const size = this.map.getSize();
    this.canvas.width = size.x * this.pixelRatio;
    this.canvas.height = size.y * this.pixelRatio;
    this.canvas.style.width = size.x + 'px';
    this.canvas.style.height = size.y + 'px';
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.forceRedraw();
  }

  // history[start..end) are the trail's points (oldest first); head is the vehicle's displayed position.
  // The spline is only rebuilt when that slice, the colour or the width changes.
  setTrail(busId, history, start, end, color, width, head) {
    const key = `${start}|${end}|${history[end - 1]?.timestamp}|${color}|${width}`;
    let t = this.trails.get(busId);
    if (!t || t.key !== key) {
      const points = history.slice(start, end).filter((p, i, a) =>
        i === 0 || Math.abs(p.lat - a[i - 1].lat) + Math.abs(p.lon - a[i - 1].lon) > 3e-5); // drop repeats (~3 m)
      t = { key, width, pts: this.spline(points), zoom: null, c0: this.rgba(color, this.options.minOpacity), c1: this.rgba(color, this.options.maxOpacity) };
      this.trails.set(busId, t);
    }
    t.head = head ? [head.lat, head.lon] : null;
  }

  removeBusTrail(busId) {
    this.trails.delete(busId);
  }

  clearAllTrails() {
    this.trails.clear();
    this.forceRedraw();
  }

  forceRedraw() {
    this.redraw(true);
  }

  redraw(force = false) {
    if (!this.ctx) return;
    const now = performance.now();
    if (!force && now - this.lastDraw < 1000 / this.options.maxFps) return;
    this.lastDraw = now;

    const map = this.map;
    const ctx = this.ctx;
    const size = map.getSize();
    const zoom = map.getZoom();
    ctx.clearRect(0, 0, size.x, size.y);
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));

    // container point = projected point - pixel origin + map pane offset; work out the offset once per frame
    const origin = map.getPixelOrigin();
    const pane = map.layerPointToContainerPoint([0, 0]);
    const ox = pane.x - origin.x, oy = pane.y - origin.y;
    const pad = 40;
    const s = Math.max(0.7, Math.min(1.7, 1 + 0.18 * (zoom - 13)));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const t of this.trails.values()) {
      if (t.pts.length / 2 + (t.head ? 1 : 0) < 2) continue;
      if (t.zoom !== zoom) this.project(t, zoom);
      const head = t.head && map.project(t.head, zoom);
      const [bx0, by0, bx1, by1] = t.bbox;
      const minX = Math.min(bx0, head ? head.x : Infinity) + ox, maxX = Math.max(bx1, head ? head.x : -Infinity) + ox;
      const minY = Math.min(by0, head ? head.y : Infinity) + oy, maxY = Math.max(by1, head ? head.y : -Infinity) + oy;
      if (maxX < -pad || minX > size.x + pad || maxY < -pad || minY > size.y + pad) continue;

      const p = t.proj;
      const x0 = p[0] + ox, y0 = p[1] + oy;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] + ox, p[i + 1] + oy);
      let xe = p[p.length - 2] + ox, ye = p[p.length - 1] + oy;
      if (head) {
        xe = head.x + ox;
        ye = head.y + oy;
        ctx.lineTo(xe, ye);
      }
      const g = ctx.createLinearGradient(x0, y0, xe, ye);
      g.addColorStop(0, t.c0);
      g.addColorStop(1, t.c1);
      ctx.strokeStyle = g;
      ctx.lineWidth = t.width * s;
      ctx.stroke();
    }
  }

  project(t, zoom) {
    const proj = new Float64Array(t.pts.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < t.pts.length; i += 2) {
      const q = this.map.project([t.pts[i], t.pts[i + 1]], zoom);
      proj[i] = q.x;
      proj[i + 1] = q.y;
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    t.proj = proj;
    t.bbox = [minX, minY, maxX, maxY];
    t.zoom = zoom;
  }

  // Catmull-Rom through the points in lat/lon (fine at city scale), as a flat [lat, lon, ...] array
  spline(points) {
    const out = [];
    const res = this.options.resolution;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
      for (let k = 0; k < res; k++) {
        const t = k / res, t2 = t * t, t3 = t2 * t;
        const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push(cr(p0.lat, p1.lat, p2.lat, p3.lat), cr(p0.lon, p1.lon, p2.lon, p3.lon));
      }
    }
    const last = points[points.length - 1];
    if (last) out.push(last.lat, last.lon);
    return out;
  }

  rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
}

window.CanvasTrailsLayer = CanvasTrailsLayer;
