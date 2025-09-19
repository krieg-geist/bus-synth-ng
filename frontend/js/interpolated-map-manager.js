const MAP_CONSTANTS = SHARED_CONSTANTS.MAP;

class InterpolatedMapManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.busMarkers = new Map();
    this.canvasStopsLayer = null; // Canvas-based stop rendering
    this.canvasTrailsLayer = null; // Canvas-based trail rendering (replaces polyline trails)
    this.bounds = null;
    this.routeColors = new Map();
    this.colorIndex = 0;

    // Interpolation and animation
    this.busPositionHistory = new Map(); // busId -> array of {position, timestamp}
    this.currentInterpolatedPositions = new Map(); // busId -> current lagged position
    this.currentTime = Date.now();
    this.displayLag = MAP_CONSTANTS.TIMING.DISPLAY_LAG_MS;
    this.maxHistoryAge = MAP_CONSTANTS.TIMING.MAX_HISTORY_AGE_MS;
    this.hasInitialData = false; // Track if we've received first dataset
    this.animationFrame = null;
    this.isAnimating = false;
    this.isProcessingHistoricalData = false; // Track if we're still receiving historical data
    this.historicalDataCount = 0; // Count historical entries received
    this.lastAnimationTime = Date.now(); // Track animation timing for gap detection
    this.wasDocumentHidden = false; // Track document visibility state

    // Performance optimization
    this.viewportBounds = null;
    this.visibleBuses = new Set();

    // Trail settings
    this.trailLength = MAP_CONSTANTS.TRAIL.LENGTH_SEGMENTS;
    this.trailFadeSteps = MAP_CONSTANTS.TRAIL.FADE_STEPS;
    this.lastSkipLog = 0; // Throttle skip logging

    // A lot of this shit should probably not be hardcoded
    this.busIconSvg = (color, rotation = 0, scale = 1) => `
      <svg width="${MAP_CONSTANTS.BUS_ICON.WIDTH * scale}" height="${MAP_CONSTANTS.BUS_ICON.HEIGHT * scale}" viewBox="0 0 ${MAP_CONSTANTS.BUS_ICON.WIDTH} ${MAP_CONSTANTS.BUS_ICON.HEIGHT}" style="transform: rotate(${rotation}deg)">
        <rect x="${MAP_CONSTANTS.BUS_ICON.STROKE_WIDTH / 2}" y="${MAP_CONSTANTS.BUS_ICON.STROKE_WIDTH / 2}" width="${MAP_CONSTANTS.BUS_ICON.WIDTH - MAP_CONSTANTS.BUS_ICON.STROKE_WIDTH}" height="${MAP_CONSTANTS.BUS_ICON.HEIGHT - MAP_CONSTANTS.BUS_ICON.STROKE_WIDTH}" fill="${color}" stroke="#fff" stroke-width="${MAP_CONSTANTS.BUS_ICON.STROKE_WIDTH}" rx="${MAP_CONSTANTS.BUS_ICON.BORDER_RADIUS}"/>
      </svg>
    `;

    this.getFrontCenterAnchor = () => {
      return [MAP_CONSTANTS.BUS_ICON.WIDTH/2, MAP_CONSTANTS.BUS_ICON.HEIGHT / 2]; // Center horizontally, exactly at front edge
    };

    // Stop pulse icon
    this.stopPulseIconSvg = (color, scale = 1) => `
      <svg width="${MAP_CONSTANTS.STOP_PULSE.WIDTH * scale}" height="${MAP_CONSTANTS.STOP_PULSE.HEIGHT * scale}" viewBox="0 0 ${MAP_CONSTANTS.STOP_PULSE.WIDTH} ${MAP_CONSTANTS.STOP_PULSE.HEIGHT}">
        <circle cx="${MAP_CONSTANTS.STOP_PULSE.WIDTH / 2}" cy="${MAP_CONSTANTS.STOP_PULSE.HEIGHT / 2}" r="${MAP_CONSTANTS.STOP_PULSE.OUTER_RADIUS}" fill="${color}" opacity="0.8"/>
        <circle cx="${MAP_CONSTANTS.STOP_PULSE.WIDTH / 2}" cy="${MAP_CONSTANTS.STOP_PULSE.HEIGHT / 2}" r="${MAP_CONSTANTS.STOP_PULSE.INNER_RADIUS}" fill="#fff" opacity="0.9"/>
      </svg>
    `;
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
      zoomControl: true,
      attributionControl: true
    });

    // Add Dark Matter tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);

    // Add canvas-based stop layer
    this.canvasStopsLayer = new CanvasStopsLayer(stops, {
      stopColor: '#ff6b6b',
      stopRadius: 3,
      animationDuration: 2000,
      maxAnimationScale: 3
    });
    this.map.addLayer(this.canvasStopsLayer);
    
    // Add canvas-based trails layer
    this.canvasTrailsLayer = new CanvasTrailsLayer({
      trailLength: MAP_CONSTANTS.TRAIL.LENGTH_SEGMENTS,
      minOpacity: 0.1,
      maxOpacity: 0.8,
      trailWidth: 4,
      splineResolution: 3
    });
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

    console.log(`Interpolated map initialized with ${stops.length} stops`);
  }

  setupVisibilityHandlers() {
    // Handle browser tab focus/unfocus to prevent disjointed trails
    this.handleVisibilityChange = () => {
      if (document.hidden) {
        this.wasDocumentHidden = true;
        console.log('Tab hidden - animation will be reset on return');
      } else if (this.wasDocumentHidden) {
        console.log('Tab visible again - clearing trails and connecting lines');
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
    
    console.log('Cleared all trails');
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
        console.log(`Large time gap detected (${(timeSinceLastFrame / 1000).toFixed(1)}s) - clearing trails`);
        this.clearAllTrailsAndConnections();
      }

      this.currentTime = now;
      this.lastAnimationTime = now;
      this.updateInterpolatedPositions();
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
    const timestamp = Date.now();

    // Handle historical data with adjusted timeline for smooth startup
    if (isHistorical) {
      this.isProcessingHistoricalData = true;
      this.historicalDataCount++;

      const adjustedTimestamp = timestamp - (MAP_CONSTANTS.TIMING.HISTORICAL_SPREAD_MS - (this.historicalDataCount * MAP_CONSTANTS.TIMING.HISTORICAL_INTERVAL_MS));

      buses
        .filter(bus => bus.vehicle && bus.vehicle.position)
        .forEach(bus => {
          const busId = bus.vehicle.vehicle.id;
          const rawRouteId = bus.vehicle.trip.route_id;
          // Clean route ID
          const routeId = this.cleanRouteId(rawRouteId);
          const position = bus.vehicle.position;

          if (!this.busPositionHistory.has(busId)) {
            this.busPositionHistory.set(busId, []);
          }

          const history = this.busPositionHistory.get(busId);
          history.push({
            lat: position.latitude,
            lon: position.longitude,
            bearing: position.bearing || 0,
            routeId: routeId, // Use cleaned route ID
            timestamp: adjustedTimestamp
          });

          // Limit history length for performance
          if (history.length > 100) {
            history.shift();
          }
        });

      console.log(`Processed historical entry ${this.historicalDataCount} with ${buses.length} buses at adjusted time ${new Date(adjustedTimestamp).toLocaleTimeString()}`);
      return;
    }

    // Handle real-time data normally
    this.isProcessingHistoricalData = false;

    // Mark that we have initial data
    if (!this.hasInitialData && buses.length > 0) {
      this.hasInitialData = true;
      console.log('Real-time data started - historical data processing complete');
    }

    // Add new bus positions to history
    buses
      .filter(bus => bus.vehicle && bus.vehicle.position)
      .forEach(bus => {
        const busId = bus.vehicle.vehicle.id;
        const rawRouteId = bus.vehicle.trip.route_id;
        // Clean route ID (remove trailing zeros, handle strings and numbers)
        const routeId = this.cleanRouteId(rawRouteId);
        const position = bus.vehicle.position;

        if (!this.busPositionHistory.has(busId)) {
          this.busPositionHistory.set(busId, []);
        }

        const history = this.busPositionHistory.get(busId);
        history.push({
          lat: position.latitude,
          lon: position.longitude,
          bearing: position.bearing || 0,
          routeId: routeId,
          timestamp: timestamp
        });

        // Limit history length for performance
        if (history.length > 100) {
          history.shift();
        }
      });

    // Remove history for buses that are no longer present
    const activeBusIds = new Set(buses
      .filter(bus => bus.vehicle && bus.vehicle.position)
      .map(bus => bus.vehicle.vehicle.id));

    for (const busId of this.busPositionHistory.keys()) {
      if (!activeBusIds.has(busId)) {
        this.removeBus(busId);
      }
    }

    console.log(`Added positions for ${activeBusIds.size} buses at ${new Date(timestamp).toLocaleTimeString()}`);
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
      const smoothProgress = progress * progress * (3 - 2 * progress);

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

      // Update icon rotation and anchor for front center
      const iconHtml = this.busIconSvg(color, position.bearing);
      const frontAnchor = this.getFrontCenterAnchor();
      markerData.marker.setIcon(L.divIcon({
        html: iconHtml,
        className: 'bus-marker',
        iconSize: [6, 16], // Updated for new orientation
        iconAnchor: frontAnchor // Front center of bus at exact GPS coordinates
      }));

      // Add to map if not visible
      if (!markerData.isVisible) {
        markerData.marker.addTo(this.map);
        markerData.isVisible = true;
      }
    } else {
      // Create new marker
      const iconHtml = this.busIconSvg(color, position.bearing);
      const frontAnchor = this.getFrontCenterAnchor();
      const marker = L.marker([position.lat, position.lon], {
        icon: L.divIcon({
          html: iconHtml,
          className: 'bus-marker',
          iconSize: [6, 16], // Updated for new orientation
          iconAnchor: frontAnchor
        })
      });

      // Custom tooltip with timeout
      let tooltipTimeout = null;
      const displayRouteId = position.routeId; // Route ID is already cleaned upstream

      const tooltip = L.tooltip({
        permanent: false,
        direction: 'top',
        className: 'bus-tooltip'
      }).setContent(`Bus: ${busId}<br/>Route: ${displayRouteId}`);

      marker.bindTooltip(tooltip);

      // Add hover events for auto-hide tooltip
      marker.on('mouseover', () => {
        if (tooltipTimeout) {
          clearTimeout(tooltipTimeout);
          tooltipTimeout = null;
        }
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
    
    // Filter trail history to only include points up to current display time
    const trailHistory = history
      .filter(pos => pos.timestamp <= currentDisplayTime)
      .slice(-this.trailLength);
    
    if (trailHistory.length < 2) {
      // Not enough points for a trail
      this.canvasTrailsLayer.removeBusTrail(busId);
      return;
    }
    
    // Get current interpolated position to create seamless trail+connection
    const currentPosition = this.currentInterpolatedPositions.get(busId);
    const routeColor = this.getRouteColor(trailHistory[0].routeId);
    
    // Update canvas trail (automatically handles trail + connection unity)
    this.canvasTrailsLayer.updateBusTrail(busId, routeColor, trailHistory, currentPosition);
  }

  animateStopPulse(stopId, intensity = 1) {
    if (!this.canvasStopsLayer) return;

    // Delegate to canvas layer
    this.canvasStopsLayer.animateStopPulse(stopId, intensity);

    console.log(`Map: Triggered stop pulse for ${stopId} with intensity ${intensity}`);
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

    // Remove current interpolated position
    this.currentInterpolatedPositions.delete(busId);
  }

  cleanupOldHistory() {
    const cutoffTime = this.currentTime - this.maxHistoryAge;

    this.busPositionHistory.forEach((history, busId) => {
      // Remove old positions
      while (history.length > 0 && history[0].timestamp < cutoffTime) {
        history.shift();
      }

      // Remove bus entirely if no recent history
      if (history.length === 0 ||
        (history.length > 0 && history[history.length - 1].timestamp < cutoffTime)) {
        this.removeBus(busId);
      }
    });
  }

  getRouteColor(routeId) {
    if (!this.routeColors.has(routeId)) {
      const colors = [
        '#00bcd4', '#4caf50', '#ff9800', '#e91e63',
        '#9c27b0', '#3f51b5', '#009688', '#8bc34a',
        '#ffeb3b', '#ff5722', '#795548', '#607d8b',
        '#f44336', '#2196f3', '#ffc107', '#673ab7'
      ];

      const color = colors[this.colorIndex % colors.length];
      this.routeColors.set(routeId, color);
      this.colorIndex++;
    }

    return this.routeColors.get(routeId);
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
    this.availableColors = [];
  }

  cleanRouteId(routeId) {
    if (!routeId) return routeId;
    
    // Handle both string and number route IDs
    if (typeof routeId === 'number') {
      // Remove trailing zero from numeric route IDs (Metlink convention)
      if (routeId % 10 === 0) {
        return routeId / 10;
      }
      return routeId;
    }
    
    // Handle string route IDs (like trains)
    if (typeof routeId === 'string') {
      // Remove trailing zero from numeric strings
      if (/^\d+0$/.test(routeId) && routeId.length > 1) {
        return routeId.slice(0, -1);
      }
      return routeId;
    }
    
    return routeId;
  }
}

window.InterpolatedMapManager = InterpolatedMapManager;
