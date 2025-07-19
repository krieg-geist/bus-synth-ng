// Canvas-based trails layer with Catmull-Rom splines and smooth gradients
class CanvasTrailsLayer extends L.Layer {
  constructor(options = {}) {
    super();

    this.options = {
      trailLength: options.trailLength || 10,
      minOpacity: options.minOpacity || 0.1,
      maxOpacity: options.maxOpacity || 0.8,
      trailWidth: options.trailWidth || 4,
      splineResolution: options.splineResolution || 10, // Points per spline segment
      ...options
    };

    this.canvas = null;
    this.context = null;
    this._bounds = null;
    this._map = null;

    // Trail data storage: busId -> trail data
    this.trails = new Map();
    this.lastUpdateTime = new Map();

    // Performance tracking
    this.lastRedraw = 0;
    this.frameCount = 0;
  }

  onAdd(map) {
    this._map = map;
    this.createCanvas();
    this.setupEventHandlers();
    return this;
  }

  onRemove() {
    this.removeEventHandlers();
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.canvas = null;
    this.context = null;
    this._map = null;
  }

  createCanvas() {
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);

    this.canvas = document.createElement('canvas');
    this.canvas.width = size.x;
    this.canvas.height = size.y;
    this.canvas.style.position = 'absolute';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = 200; // Above map tiles, below markers

    // Use Leaflet's positioning utility for proper alignment
    L.DomUtil.setPosition(this.canvas, topLeft);

    this.context = this.canvas.getContext('2d');
    this.context.imageSmoothingEnabled = false;
    // this.context.imageSmoothingQuality = 'high';

    this._map.getPanes().overlayPane.appendChild(this.canvas);
  }

  setupEventHandlers() {
    this._map.on('viewreset', this.reset, this);
    this._map.on('zoom', this.reset, this);
    this._map.on('zoomstart', this.reset, this);
    this._map.on('zoomend', this.reset, this);
    this._map.on('moveend', this.redraw, this);
    this._map.on('move', this.updateCanvasPosition, this);
  }

  removeEventHandlers() {
    if (this._map) {
      this._map.off('viewreset', this.reset, this);
      this._map.off('zoom', this.reset, this);
      this._map.off('zoomstart', this.reset, this);
      this._map.off('zoomend', this.reset, this);
      this._map.off('moveend', this.redraw, this);
      this._map.off('move', this.updateCanvasPosition, this);
    }
  }

  reset() {
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);

    // Update canvas size
    this.canvas.width = size.x;
    this.canvas.height = size.y;

    // Update canvas position
    L.DomUtil.setPosition(this.canvas, topLeft);

    // Restore context settings after canvas resize
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = 'high';

    this.redraw();
  }

  updateCanvasPosition() {
    if (!this.canvas || !this._map) return;

    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    const currentPosition = L.DomUtil.getPosition(this.canvas);

    // Only update if position has actually changed to avoid unnecessary redraws
    if (!currentPosition || currentPosition.x !== topLeft.x || currentPosition.y !== topLeft.y) {
      L.DomUtil.setPosition(this.canvas, topLeft);
    }
  }

  // Update trail for a specific bus
  updateBusTrail(busId, routeColor, trailPoints, currentPosition) {
    // Combine trail points with current position for seamless rendering
    const now = Date.now();
    const lastUpdate = this.lastUpdateTime.get(busId) || 0;
    if (now - lastUpdate < 100) return;
    this.lastUpdateTime.set(busId, now);

    const allPoints = [...trailPoints];
    if (currentPosition) {
      allPoints.push({
        lat: currentPosition.lat,
        lon: currentPosition.lon,
        timestamp: Date.now(),
        routeId: currentPosition.routeId
      });
    }

    // Only keep recent points and ensure minimum points for spline
    const recentPoints = allPoints
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.options.trailLength);

    if (recentPoints.length < 2) {
      // Not enough points for a trail
      this.trails.delete(busId);
      return;
    }

    // Filter out points that are too close to avoid rendering artifacts
    const filteredPoints = this.filterClosePoints(recentPoints);

    if (filteredPoints.length < 2) {
      this.trails.delete(busId);
      return;
    }

    // Store trail data
    this.trails.set(busId, {
      points: filteredPoints,
      color: routeColor,
      lastUpdate: Date.now()
    });

    // Redraw canvas to show updated trail immediately (throttled)
    if (now - this.lastRedraw > 200) { // Throttle to ~60fps max
      this.redraw();
    }
  }

  // Remove duplicate or very close points to avoid spline artifacts
  filterClosePoints(points) {
    if (points.length < 2) return points;

    const filtered = [points[0]];
    const minDistance = 0.0001; // ~10 meters in decimal degrees
    const maxDistance = 0.008;  // ~400 meters in decimal degrees - prevent huge jumps

    for (let i = 1; i < points.length; i++) {
      const current = points[i];
      const last = filtered[filtered.length - 1];

      const distance = Math.sqrt(
        Math.pow(current.lat - last.lat, 2) +
        Math.pow(current.lon - last.lon, 2)
      );

      // Skip points that are too close or too far
      if (distance >= minDistance && distance <= maxDistance) {
        filtered.push(current);
      }
    }

    return filtered;
  }

  // Remove trail for a bus
  removeBusTrail(busId) {
    this.trails.delete(busId);
  }

  // Clear all trails
  clearAllTrails() {
    this.trails.clear();
    if (this.canvas && this.context) {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  redraw() {
    if (!this.canvas || !this.context || !this._map) return;

    const now = Date.now();
    this.frameCount++;

    // Ensure canvas is properly positioned before drawing
    this.updateCanvasPosition();

    // Clear canvas
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Get current map bounds for viewport culling
    const bounds = this._map.getBounds();
    const viewportPadding = 0.01; // Small padding to avoid edge clipping

    // Draw all trails
    this.trails.forEach((trail, busId) => {
      try {
        this.drawTrail(trail, bounds, viewportPadding);
      } catch (error) {
        console.warn(`Error drawing trail for bus ${busId}:`, error);
      }
    });

    this.lastRedraw = now;
  }

  drawTrail(trail, bounds, padding) {
    const { points, color } = trail;

    if (points.length < 2) return;

    // Check if trail is in viewport (with padding)
    const inViewport = points.some(point =>
      point.lat >= bounds.getSouth() - padding &&
      point.lat <= bounds.getNorth() + padding &&
      point.lon >= bounds.getWest() - padding &&
      point.lon <= bounds.getEast() + padding
    );

    if (!inViewport) return;

    // Convert points to screen coordinates
    const screenPoints = points.map(point => {
      const screenPoint = this._map.latLngToContainerPoint([point.lat, point.lon]);
      return {
        x: screenPoint.x,
        y: screenPoint.y,
        timestamp: point.timestamp
      };
    });

    // Filter out points that are outside the canvas bounds (with some padding)
    const canvasBounds = {
      left: -50,
      top: -50,
      right: this.canvas.width + 50,
      bottom: this.canvas.height + 50
    };

    const visiblePoints = screenPoints.filter(point =>
      point.x >= canvasBounds.left && point.x <= canvasBounds.right &&
      point.y >= canvasBounds.top && point.y <= canvasBounds.bottom
    );

    if (visiblePoints.length < 2) return;

    if (visiblePoints.length < 2) return;

    // Generate Catmull-Rom spline
    const splinePoints = this.generateCatmullRomSpline(visiblePoints);

    if (splinePoints.length < 2) return;

    // Draw trail with gradient
    this.drawSplineWithGradient(splinePoints, color);
  }

  // Generate Catmull-Rom spline through points
  generateCatmullRomSpline(points) {
    if (points.length <= 3) {
      // For short trails, return points directly instead of generating spline
      return points.map((point, i) => ({
        ...point,
        progress: i / (points.length - 1)
      }));
    }
    if (points.length < 2) return points;
    if (points.length === 2) return points;

    const splinePoints = [];
    const resolution = this.options.splineResolution;

    // For Catmull-Rom, we need to add control points at the ends
    const controlPoints = [
      points[0], // Duplicate first point
      ...points,
      points[points.length - 1] // Duplicate last point
    ];

    // Generate spline segments between actual points
    for (let i = 1; i < controlPoints.length - 2; i++) {
      const p0 = controlPoints[i - 1];
      const p1 = controlPoints[i];
      const p2 = controlPoints[i + 1];
      const p3 = controlPoints[i + 2];

      // Generate points along this segment
      for (let t = 0; t < resolution; t++) {
        const u = t / resolution;
        const point = this.catmullRomInterpolate(p0, p1, p2, p3, u);

        // Add progress along total spline for gradient calculation
        const progress = (i - 1 + u) / (controlPoints.length - 3);
        point.progress = Math.max(0, Math.min(1, progress));

        splinePoints.push(point);
      }
    }

    // Add final point
    const lastPoint = controlPoints[controlPoints.length - 2];
    lastPoint.progress = 1;
    splinePoints.push(lastPoint);

    return splinePoints;
  }

  // Catmull-Rom interpolation between four control points
  catmullRomInterpolate(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;

    return {
      x: 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      ),
      y: 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      )
    };
  }

  // Draw spline with smooth gradient from transparent tail to opaque head
  drawSplineWithGradient(splinePoints, color) {
    if (splinePoints.length < 2 || !this.context) return;

    const ctx = this.context;

    // Single path with gradient instead of individual segments
    ctx.beginPath();
    ctx.moveTo(splinePoints[0].x, splinePoints[0].y);

    for (let i = 1; i < splinePoints.length; i++) {
      ctx.lineTo(splinePoints[i].x, splinePoints[i].y);
    }

    // Apply gradient using canvas linear gradient
    const gradient = ctx.createLinearGradient(
      splinePoints[0].x, splinePoints[0].y,
      splinePoints[splinePoints.length - 1].x, splinePoints[splinePoints.length - 1].y
    );

    gradient.addColorStop(0, this.colorWithOpacity(color, this.options.minOpacity));
    gradient.addColorStop(1, this.colorWithOpacity(color, this.options.maxOpacity));

    ctx.strokeStyle = gradient;
    ctx.lineWidth = this.options.trailWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Convert color string to rgba with specified opacity
  colorWithOpacity(color, opacity) {
    // Handle hex colors
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    // Handle rgb colors - convert to rgba
    if (color.startsWith('rgb(')) {
      return color.replace('rgb(', 'rgba(').replace(')', `, ${opacity})`);
    }

    // Handle rgba colors - replace alpha
    if (color.startsWith('rgba(')) {
      return color.replace(/,\s*[\d.]+\)$/, `, ${opacity})`);
    }

    // Fallback to named color
    return `rgba(128, 128, 128, ${opacity})`;
  }

  // Force redraw (for external calls)
  forceRedraw() {
    // Ensure proper positioning before redraw
    if (this._map && this.canvas) {
      this.updateCanvasPosition();
    }
    this.redraw();
  }

  // Get performance statistics
  getStats() {
    const canvasPosition = this.canvas ? {
      left: this.canvas.style.left,
      top: this.canvas.style.top,
      transform: this.canvas.style.transform,
      width: this.canvas.width,
      height: this.canvas.height
    } : null;

    return {
      trailCount: this.trails.size,
      frameCount: this.frameCount,
      lastRedraw: this.lastRedraw,
      canvasPosition,
      averagePointsPerTrail: this.trails.size > 0 ?
        Array.from(this.trails.values()).reduce((sum, trail) => sum + trail.points.length, 0) / this.trails.size : 0
    };
  }

  // Debug method to check canvas alignment
  debugCanvasAlignment() {
    if (!this.canvas || !this._map) {
      console.log('Canvas or map not available');
      return;
    }

    const mapSize = this._map.getSize();
    const canvasRect = this.canvas.getBoundingClientRect();
    const mapRect = this._map.getContainer().getBoundingClientRect();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    const currentPosition = L.DomUtil.getPosition(this.canvas);

    console.log('Canvas Alignment Debug:', {
      mapSize: { x: mapSize.x, y: mapSize.y },
      canvasSize: { width: this.canvas.width, height: this.canvas.height },
      mapRect: { left: mapRect.left, top: mapRect.top, width: mapRect.width, height: mapRect.height },
      canvasRect: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height },
      expectedTopLeft: topLeft,
      actualPosition: currentPosition,
      positionDiff: currentPosition ? {
        x: currentPosition.x - topLeft.x,
        y: currentPosition.y - topLeft.y
      } : 'unknown'
    });
  }
}

window.CanvasTrailsLayer = CanvasTrailsLayer;
