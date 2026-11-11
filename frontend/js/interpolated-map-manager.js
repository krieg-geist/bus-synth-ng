const MAP_CONSTANTS = SHARED_CONSTANTS.MAP;

class InterpolatedMapManager {
  constructor(containerId, { colorFor, describe, onFollow } = {}) {
    this.containerId = containerId;
    this.colorFor = colorFor; // route -> colour; see BusSynthApp.colorFor
    this.describe = describe; // (vehicle id, route) -> tooltip HTML
    this.onFollow = onFollow; // (vehicle id or null, route) when following starts or stops
    this.following = null; // vehicle id the camera is following
    this.map = null;
    this.busMarkers = new Map();
    this.canvasStopsLayer = null; // Canvas-based stop rendering
    this.canvasTrailsLayer = null; // Canvas-based trail rendering (replaces polyline trails)
    this.bounds = null;

    // Interpolation and animation
    this.suspects = new Map(); // busId -> a report that jumped, waiting for the next one to confirm or refute it
    this.busPositionHistory = new Map(); // busId -> array of {position, timestamp}
    this.currentInterpolatedPositions = new Map(); // busId -> current lagged position
    this.currentTime = Date.now();
    this.displayLag = MAP_CONSTANTS.TIMING.DISPLAY_LAG_MS;
    this.maxHistoryAge = MAP_CONSTANTS.TIMING.MAX_HISTORY_AGE_MS;
    this.hasInitialData = false; // Track if we've received first dataset
    this.animationFrame = null;
    this.isAnimating = false;
    this.historicalDataCount = 0; // Count historical entries received
    this.lastAnimationTime = Date.now(); // Track animation timing for gap detection
    this.wasDocumentHidden = false; // Track document visibility state

    // Performance optimization
    this.viewportBounds = null;

    // Trail settings
    this.trailLength = MAP_CONSTANTS.TRAIL.LENGTH_SEGMENTS;

    // A lot of this shit should probably not be hardcoded
    // Vehicle markers, scaled with zoom. A bus is a rounded bar with a dark windscreen at the front (so you can see
    // which way it's heading) in its note colour. A train is three bus-width carriages in its line colour, windscreen
    // on the front one: the middle carriage sits on the GPS fix and the others hinge at their couplings by half the
    // bend each, so the train curves along its track.
    this.vehicleIcon = (color, rotation, type, zoom, bend = 0) => {
      const s = Math.max(0.7, Math.min(1.7, 1 + 0.18 * (zoom - 13)));
      const w = 7 * s;
      const car = type === 2 ? 10 * s : 15 * s;
      const body = (y, front) =>
        `<rect x="${-w / 2 + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${car - 1}" rx="${1.8 * s}" fill="${color}" stroke="rgba(5,8,12,.85)" stroke-width="1"/>` +
        (front ? `<rect x="${-w / 2 + 1.4 * s}" y="${y + 1.4 * s}" width="${w - 2.8 * s}" height="${2.2 * s}" rx="${0.6 * s}" fill="rgba(5,8,12,.55)"/>` : '');
      let size, shapes;
      if (type === 2) {
        const gap = 1.6 * s, half = car / 2;
        size = Math.ceil(2 * Math.hypot(half + gap + car, w / 2) + 2);
        shapes = `<g transform="rotate(${rotation - bend / 2})">${body(-half, false)}` +
          `<g transform="rotate(${bend / 2} 0 ${-half - gap / 2})">${body(-half - gap - car, true)}</g>` +
          `<g transform="rotate(${-bend / 2} 0 ${half + gap / 2})">${body(half + gap, false)}</g></g>`;
      } else if (type === 4) {
        // Ferry: a hull with a pointed bow and a light cabin
        const fw = 10 * s, fl = 22 * s;
        size = Math.ceil(fl + 2);
        shapes = `<g transform="rotate(${rotation})"><path d="M0 ${-fl / 2} C ${fw / 2} ${-fl / 4} ${fw / 2} ${fl / 4} ${fw * 0.4} ${fl / 2} ` +
          `L ${-fw * 0.4} ${fl / 2} C ${-fw / 2} ${fl / 4} ${-fw / 2} ${-fl / 4} 0 ${-fl / 2} Z" fill="${color}" stroke="rgba(5,8,12,.85)" stroke-width="1"/>` +
          `<rect x="${-fw * 0.22}" y="${-fl * 0.04}" width="${fw * 0.44}" height="${fl * 0.3}" rx="${1.2 * s}" fill="rgba(255,255,255,.6)"/></g>`;
      } else {
        size = Math.ceil(car + 2);
        shapes = `<g transform="rotate(${rotation})">${body(-car / 2, true)}</g>`;
      }
      const html = `<svg width="${size}" height="${size}" viewBox="${-size / 2} ${-size / 2} ${size} ${size}">${shapes}</svg>`;
      return L.divIcon({ html, className: ['vehicle-marker', { 2: 'train', 4: 'ferry' }[type]].join(' '), iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    };

  }

  async initialize(stops, bounds) {
    this.stops = stops;
    this.bounds = bounds;

    // Calculate center for Wellington
    const centerLat = (bounds[0][0] + bounds[0][1]) / 2;
    const centerLon = (bounds[1][0] + bounds[1][1]) / 2;

    // Initialize Leaflet map
    this.map = L.map(this.containerId, {
      center: [centerLat, centerLon],
      zoom: 11,
      zoomControl: false,
      zoomSnap: 0.25, // the vector basemap renders fractional zoom cleanly, so the initial fit can be tight
      attributionControl: true
    });
    this.zoomControl = L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    // Following a vehicle (click it) ends on any camera move by the user: drag, wheel, pinch, double-click, keys, buttons
    const stop = () => this.unfollow();
    this.map.on('dragstart dblclick', stop);
    const el = this.map.getContainer();
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('touchstart', e => { if (e.touches.length > 1) stop(); }, { passive: true });
    el.addEventListener('keydown', stop);
    this.zoomControl.getContainer().addEventListener('click', stop);
    this.map.fitBounds([[bounds[0][0], bounds[1][0]], [bounds[0][1], bounds[1][1]]], { padding: [20, 20] });

    // Basemap: OpenFreeMap vector tiles (free, no key) drawn by MapLibre inside Leaflet.
    // CARTO's raster tiles now stamp every tile with "API KEY REQUIRED".
    const basemap = L.maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/dark',
      attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
    }).addTo(this.map);
    // The style references a "wood-pattern" sprite it doesn't ship; a blank stand-in keeps the console clean
    const gl = basemap.getMaplibreMap();
    gl.on('styleimagemissing', e => { if (!gl.hasImage(e.id)) gl.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });

    // Add canvas-based stop layer
    this.canvasStopsLayer = new CanvasStopsLayer(stops);
    this.map.addLayer(this.canvasStopsLayer);
    
    // Add canvas-based trails layer
    this.canvasTrailsLayer = new CanvasTrailsLayer();
    this.map.addLayer(this.canvasTrailsLayer);

    // Set up viewport tracking
    this.updateViewportBounds();
    this.map.on('moveend', () => {
      this.updateViewportBounds();
      this.renderVisibleFeatures();
    });

    this.map.on('zoomend', () => {
      this.updateViewportBounds();
      this.renderVisibleFeatures();
      // Force canvas redraw on zoom
      if (this.canvasStopsLayer) {
        this.canvasStopsLayer.forceRedraw();
      }
    });

    // Start animation loop
    this.startAnimation();

    // Add page visibility listeners to handle focus/unfocus issues
    this.setupVisibilityHandlers();

  }

  setupVisibilityHandlers() {
    // Handle browser tab focus/unfocus to prevent disjointed trails
    this.handleVisibilityChange = () => {
      if (document.hidden) {
        this.wasDocumentHidden = true;
      } else if (this.wasDocumentHidden) {
        this.clearAllTrailsAndConnections();
        this.wasDocumentHidden = false;
        this.lastAnimationTime = Date.now(); // Reset timing
      }
    };

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  clearAllTrailsAndConnections() {
    // Clear all canvas-based trails
    if (this.canvasTrailsLayer) {
      this.canvasTrailsLayer.clearAllTrails();
    }
    
  }

  updateViewportBounds() {
    const bounds = this.map.getBounds();
    this.viewportBounds = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest()
    };
  }

  isInViewport(lat, lon) {
    if (!this.viewportBounds) return true;
    return lat <= this.viewportBounds.north &&
      lat >= this.viewportBounds.south &&
      lon <= this.viewportBounds.east &&
      lon >= this.viewportBounds.west;
  }

  startAnimation() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.lastAnimationTime = Date.now();

    const animate = () => {
      if (!this.isAnimating) return;

      const now = Date.now();
      const timeSinceLastFrame = now - this.lastAnimationTime;

      // Hopefully this will detect tab switching or long pauses
      if (timeSinceLastFrame > MAP_CONSTANTS.TIMING.MAX_TIME_GAP_MS) {
        this.clearAllTrailsAndConnections();
      }

      this.currentTime = now;
      this.lastAnimationTime = now;
      this.updateInterpolatedPositions();
      this.trackFollowed();
      this.canvasTrailsLayer?.redraw();
      this.cleanupOldHistory();

      this.animationFrame = requestAnimationFrame(animate);
    };

    animate();
  }

  stopAnimation() {
    this.isAnimating = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }
  updateBuses(buses, isHistorical = false) {
    // Historical entries (sent on connect) are spread over the last 90 s so the lagged display has data at once
    let received = Date.now();
    if (isHistorical) {
      this.historicalDataCount++;
      received -= MAP_CONSTANTS.TIMING.HISTORICAL_SPREAD_MS - this.historicalDataCount * MAP_CONSTANTS.TIMING.HISTORICAL_INTERVAL_MS;
    } else if (buses.length > 0) {
      this.hasInitialData = true;
    }

    // Vehicles missing from this poll are kept: a gap in reporting just continues (see cleanupOldHistory)
    buses.forEach(bus => {
      if (!this.validPosition(bus)) return;
      const v = bus.vehicle;
      const busId = v.vehicle.id;
      if (!this.busPositionHistory.has(busId)) this.busPositionHistory.set(busId, []);
      this.addPosition(busId, {
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing || 0,
        routeId: Utils.vehicleRoute(v),
        timestamp: received,
        reported: (v.timestamp || 0) * 1000 // the vehicle's own report time
      });
    });
  }


  updateInterpolatedPositions() {
    // Use consistent 1-minute lag for smooth interpolation
    const displayTime = this.currentTime - this.displayLag;

    this.busPositionHistory.forEach((history, busId) => {
      if (history.length === 0) return;

      // For very new buses with limited history, use most recent position
      if (history.length === 1) {
        const singlePos = history[0];
        // Only display if the position is recent enough
        if (singlePos.timestamp <= displayTime + 30000) { // 30s tolerance for new buses
          this.currentInterpolatedPositions.set(busId, singlePos);
          this.updateBusMarker(busId, singlePos);
          this.updateBusTrail(busId, history, displayTime);
        }
        return;
      }

      // Find the two positions to interpolate between
      let beforePos = null;
      let afterPos = null;

      for (let i = 0; i < history.length - 1; i++) {
        if (history[i].timestamp <= displayTime && history[i + 1].timestamp >= displayTime) {
          beforePos = history[i];
          afterPos = history[i + 1];
          break;
        }
      }

      if (!beforePos || !afterPos) {
        // Use the most recent position if we can't interpolate
        const mostRecent = history[history.length - 1];
        if (mostRecent.timestamp <= displayTime + 30000) { // 30s tolerance
          this.currentInterpolatedPositions.set(busId, mostRecent);
          this.updateBusMarker(busId, mostRecent);
          this.updateBusTrail(busId, history, displayTime);
        }
        return;
      }

      // Smooth interpolation between positions
      const totalTime = afterPos.timestamp - beforePos.timestamp;
      const elapsedTime = displayTime - beforePos.timestamp;
      const progress = totalTime > 0 ? Math.max(0, Math.min(1, elapsedTime / totalTime)) : 0;

      // Use smooth step function for even smoother interpolation
      const smoothProgress = afterPos.jump ? 0 : progress * progress * (3 - 2 * progress); // after a jump: step, don't fly

      const interpolatedPos = {
        lat: this.lerp(beforePos.lat, afterPos.lat, smoothProgress),
        lon: this.lerp(beforePos.lon, afterPos.lon, smoothProgress),
        bearing: this.lerpAngle(beforePos.bearing, afterPos.bearing, smoothProgress),
        routeId: beforePos.routeId,
        timestamp: displayTime
      };

      // Store interpolated position for other systems to use
      this.currentInterpolatedPositions.set(busId, interpolatedPos);

      this.updateBusMarker(busId, interpolatedPos);
      this.updateBusTrail(busId, history, displayTime);
    });
  }
  updateBusMarker(busId, position) {
    if (!this.isInViewport(position.lat, position.lon)) {
      // Hide marker if outside viewport
      if (this.busMarkers.has(busId)) {
        const markerData = this.busMarkers.get(busId);
        if (markerData.isVisible) {
          this.map.removeLayer(markerData.marker);
          markerData.isVisible = false;
        }
      }
      return;
    }

    const color = this.getRouteColor(position.routeId);

    if (this.busMarkers.has(busId)) {
      // Update existing marker - position at EXACT GPS coordinates
      const markerData = this.busMarkers.get(busId);
      markerData.marker.setLatLng([position.lat, position.lon]); // Exact GPS position

      // Rebuilding the icon replaces its DOM node, so only do it when what it shows has changed
      const zoom = this.map.getZoom();
      const type = Utils.routeType(position.routeId);
      const bend = type === 2 ? this.trainBend(busId, position) : 0;
      const key = `${color}|${Math.round(position.bearing / 3)}|${zoom}|${bend}`;
      if (markerData.iconKey !== key) {
        markerData.iconKey = key;
        markerData.marker.setIcon(this.vehicleIcon(color, position.bearing, type, zoom, bend));
        if (busId === this.following) markerData.marker.getElement()?.classList.add('following'); // new icon, new element
      }

      // Add to map if not visible
      if (!markerData.isVisible) {
        markerData.marker.addTo(this.map);
        markerData.isVisible = true;
      }
    } else {
      // Create new marker
      const type = Utils.routeType(position.routeId);
      const marker = L.marker([position.lat, position.lon], { icon: this.vehicleIcon(color, position.bearing, type, this.map.getZoom()) });

      // Custom tooltip with timeout
      let tooltipTimeout = null;

      const tooltip = L.tooltip({
        permanent: false,
        direction: 'top',
        className: 'bus-tooltip'
      });

      marker.bindTooltip(tooltip);
      marker.on('click', () => this.follow(busId));

      // Add hover events for auto-hide tooltip
      marker.on('mouseover', () => {
        if (tooltipTimeout) {
          clearTimeout(tooltipTimeout);
          tooltipTimeout = null;
        }
        tooltip.setContent(this.describe(busId, this.latestRoute(busId)));
        marker.openTooltip();
      });

      marker.on('mouseout', () => {
        tooltipTimeout = setTimeout(() => {
          marker.closeTooltip();
        }, 1000); // 1 second delay
      });

      marker.addTo(this.map);
      this.busMarkers.set(busId, {
        marker,
        isVisible: true,
        routeId: position.routeId
      });
    }
  }

  updateBusTrail(busId, history, currentDisplayTime) {
    if (!this.canvasTrailsLayer) return;
    // Points up to the display time, at most trailLength of them, starting again after the last GPS jump
    let end = history.length;
    while (end > 0 && history[end - 1].timestamp > currentDisplayTime) end--;
    let start = Math.max(0, end - this.trailLength);
    for (let i = end - 1; i > start; i--) if (history[i].jump) { start = i; break; }
    const route = history[0].routeId;
    const width = { 2: 2.6, 4: 3.4 }[Utils.routeType(route)] ?? 1.8; // trains and ferries' wakes are wider
    this.canvasTrailsLayer.setTrail(busId, history, start, end, this.getRouteColor(route), width, this.currentInterpolatedPositions.get(busId));
  }

  // Reports outside the Wellington region are bad GPS (often 0,0): skip them
  validPosition(bus) {
    const p = bus.vehicle?.position;
    return !!p && p.latitude > -42.5 && p.latitude < -40 && p.longitude > 173.5 && p.longitude < 177;
  }

  // Add a report to a vehicle's history. The feed repeats a quiet vehicle's last report, so repeats are skipped and the
  // vehicle simply continues across the gap when it reports again. A huge instantaneous jump is held as a suspect:
  // dropped if the next report is back near the old track, accepted if the next report agrees with it (the vehicle
  // really moved), in which case it's marked so the marker steps instead of flying and the trail restarts.
  addPosition(busId, p) {
    const history = this.busPositionHistory.get(busId);
    const last = history[history.length - 1];
    if (last && p.reported && p.reported === last.reported) return;
    if (last && this.isJump(last, p)) {
      const suspect = this.suspects.get(busId);
      if (suspect && !this.isJump(suspect, p)) {
        this.suspects.delete(busId);
        suspect.jump = true;
        history.push(suspect, p);
      } else {
        this.suspects.set(busId, p);
      }
    } else {
      this.suspects.delete(busId);
      history.push(p);
    }
    if (history.length > 100) history.splice(0, history.length - 100);
  }

  // Over 1.5 km at more than ~150 km/h (~250 km/h for trains), timed by the vehicle's own report times so a long
  // silence followed by a long move is not a jump
  isJump(a, b) {
    const metres = Utils.calculateDistance(a.lat, a.lon, b.lat, b.lon);
    const ms = a.reported && b.reported ? b.reported - a.reported : b.timestamp - a.timestamp;
    return metres > 1500 && metres / Math.max(1, ms / 1000) > (Utils.routeType(b.routeId) === 2 ? 70 : 42);
  }



  // How much a train bends: its heading now against the direction it came from, measured from the last position at
  // least ~60 m back along its track. Quantised to 5 degrees (fewer icon rebuilds); 0 when reversing at a terminus.
  trainBend(busId, position) {
    const history = this.busPositionHistory.get(busId) || [];
    const kx = 111320 * Math.cos(position.lat * Math.PI / 180);
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.timestamp > position.timestamp) continue;
      const dx = (position.lon - h.lon) * kx, dy = (position.lat - h.lat) * 110540;
      if (dx * dx + dy * dy < 3600) continue;
      const bend = ((position.bearing - Math.atan2(dx, dy) * 180 / Math.PI + 540) % 360) - 180;
      return Math.abs(bend) > 60 ? 0 : Math.max(-40, Math.min(40, Math.round(bend / 5) * 5));
    }
    return 0;
  }

  latestRoute(busId) {
    return this.busPositionHistory.get(busId)?.at(-1)?.routeId;
  }

  // Click a vehicle: fly to street level and keep it centred every frame. The listener sits at the map centre,
  // so the followed vehicle is also the loudest thing in the mix.
  follow(busId) {
    const pos = this.currentInterpolatedPositions.get(busId);
    if (!pos) return;
    this.setFollowing(busId);
    this.flying = true;
    this.map.once('moveend', () => { this.flying = false; });
    this.map.flyTo([pos.lat, pos.lon], Math.max(this.map.getZoom(), 16), { duration: 1.2 });
  }

  unfollow() {
    if (this.following) this.setFollowing(null);
  }

  setFollowing(busId) {
    this.busMarkers.get(this.following)?.marker.getElement()?.classList.remove('following');
    this.following = busId;
    this.busMarkers.get(busId)?.marker.getElement()?.classList.add('following');
    this.onFollow?.(busId, busId && this.latestRoute(busId));
  }

  trackFollowed() {
    if (!this.following || this.flying) return;
    const pos = this.currentInterpolatedPositions.get(this.following);
    if (!pos) return this.unfollow();
    this.map.setView([pos.lat, pos.lon], this.map.getZoom(), { animate: false });
  }

  animateStopPulse(stopId, size = 1, color) {
    this.canvasStopsLayer?.animateStopPulse(stopId, size, color);
  }

  pulseAt(lat, lon, opts) {
    this.canvasStopsLayer?.pulseAt(lat, lon, opts);
  }

  renderVisibleFeatures() {
    // Just force a redraw to update visible stops
    if (this.canvasStopsLayer) {
      this.canvasStopsLayer.forceRedraw();
    }
    
    // Force trails redraw when viewport changes
    if (this.canvasTrailsLayer) {
      this.canvasTrailsLayer.forceRedraw();
    }

    // Force re-render of bus markers by updating their visibility
    this.busMarkers.forEach((markerData, busId) => {
      const latLng = markerData.marker.getLatLng();
      const inViewport = this.isInViewport(latLng.lat, latLng.lng);

      if (inViewport && !markerData.isVisible) {
        markerData.marker.addTo(this.map);
        markerData.isVisible = true;
      } else if (!inViewport && markerData.isVisible) {
        this.map.removeLayer(markerData.marker);
        markerData.isVisible = false;
      }
    });
  }
  removeBus(busId) {
    if (this.following === busId) this.unfollow();
    // Remove marker
    if (this.busMarkers.has(busId)) {
      const markerData = this.busMarkers.get(busId);
      if (markerData.isVisible) {
        this.map.removeLayer(markerData.marker);
      }
      this.busMarkers.delete(busId);
    }

    // Remove trail from canvas layer
    if (this.canvasTrailsLayer) {
      this.canvasTrailsLayer.removeBusTrail(busId);
    }

    // Remove position history
    this.busPositionHistory.delete(busId);
    this.suspects.delete(busId);

    // Remove current interpolated position
    this.currentInterpolatedPositions.delete(busId);
  }

  // Trim history beyond the trail length; drop vehicles that have been silent for STALE_VEHICLE_MS
  cleanupOldHistory() {
    const cutoff = this.currentTime - this.maxHistoryAge;
    const stale = this.currentTime - MAP_CONSTANTS.TIMING.STALE_VEHICLE_MS;
    this.busPositionHistory.forEach((history, busId) => {
      while (history.length > 1 && history[0].timestamp < cutoff) history.shift();
      if (!history.length || history[history.length - 1].timestamp < stale) this.removeBus(busId);
    });
  }


  getRouteColor(routeId) {
    return this.colorFor(routeId);
  }

  // Linear interpolation
  lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Angle interpolation (handles 0/360 wraparound)
  lerpAngle(a, b, t) {
    const diff = ((b - a + 540) % 360) - 180;
    return (a + diff * t + 360) % 360;
  }

  highlightBus(busId) {
    if (this.busMarkers.has(busId)) {
      const markerData = this.busMarkers.get(busId);
      markerData.marker.openTooltip();
      setTimeout(() => markerData.marker.closeTooltip(), 2000);
    }
  }

  // Get current interpolated/lagged bus positions for synchronization with audio/animations
  getCurrentLaggedPositions() {
    return this.currentInterpolatedPositions;
  }

  // Get lagged positions grouped by route for audio system
  getCurrentLaggedRouteData() {
    const routeGroups = new Map();

    this.currentInterpolatedPositions.forEach((position, busId) => {
      const routeId = position.routeId;
      if (!routeGroups.has(routeId)) {
        routeGroups.set(routeId, []);
      }

      routeGroups.get(routeId).push({
        id: busId,
        position: {
          latitude: position.lat,
          longitude: position.lon,
          bearing: position.bearing
        },
        routeId: routeId
      });
    });

    return routeGroups;
  }

  resize() {
    if (this.map) {
      this.map.invalidateSize();
      this.updateViewportBounds();
      this.renderVisibleFeatures();
    }
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    // Haversine formula for accurate geodetic distance
    const R = 6371000; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) *
      Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }

  dispose() {
    this.stopAnimation();

    // Remove visibility event listeners
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    if (this.map) {
      if (this.canvasStopsLayer) {
        this.map.removeLayer(this.canvasStopsLayer);
        this.canvasStopsLayer = null;
      }
      if (this.canvasTrailsLayer) {
        this.map.removeLayer(this.canvasTrailsLayer);
        this.canvasTrailsLayer = null;
      }
      this.map.remove();
      this.map = null;
    }

    this.busMarkers.clear();
    this.busPositionHistory.clear();
    this.currentInterpolatedPositions.clear();
  }

}

window.InterpolatedMapManager = InterpolatedMapManager;
