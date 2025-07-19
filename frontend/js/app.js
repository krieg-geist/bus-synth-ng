// Constants
const CONSTANTS = {
  PROXIMITY: {
    STOP_THRESHOLD_METERS: 100,
    APPROACH_THRESHOLD_METERS: 20
  },
  TIMING: {
    ROUTE_CLEANUP_INTERVAL_MS: 60000, // 1 minute
    EARTH_RADIUS_METERS: 6371000,
    ARRIVAL_DEBOUNCE_MS: 30000, // 30 seconds between arrivals at same stop
    MAX_BLAST_DELAY_MS: 15000   // Don't play blasts for arrivals older than 15 seconds
  },
  SPATIAL: {
    GRID_SIZE: 50, // 50x50 grid for Wellington (~800m cells)
    SEARCH_RADIUS_MULTIPLIER: 2 // Search radius = threshold × multiplier
  }
};

class BusSynthApp {
  constructor() {
    this.wsClient = null;
    this.audioManager = null;
    this.mapManager = null;
    this.isAudioStarted = false;
    this.bounds = null;
    this.currentBuses = new Map();
    this.stops = [];
    this.stopSpatialIndex = null; // Spatial index for efficient stop proximity queries
    this.routeBusData = new Map(); // grouping buses by route
    this.lastBusPositions = new Map(); // for detecting arrivals
    this.recentArrivals = new Map(); // debounce arrivals: "busId-stopId" -> timestamp
    this.stopDelays = new Map(); // store delay data: "stopId" -> {delay, routeId, timestamp}
    this.stopProximityThreshold = CONSTANTS.PROXIMITY.STOP_THRESHOLD_METERS;

    // UI elements
    this.audioToggleBtn = document.getElementById('audio-toggle-btn');
    this.volumeSlider = document.getElementById('volume-slider');
    this.volumeValue = document.getElementById('volume-value');
    this.connectionStatus = document.getElementById('connection-status');
    this.busCount = document.getElementById('bus-count');
    this.audioStatus = document.getElementById('audio-status');
    
    // Audio events display elements
    this.activeRoutesDisplay = document.getElementById('active-routes');
    this.recentArrivalsDisplay = document.getElementById('recent-arrivals');
    this.delayEventsDisplay = document.getElementById('delay-events');
    this.clearEventsBtn = document.getElementById('clear-events');
    
    // Audio events data
    this.recentArrivalEvents = [];
    this.recentDelayEvents = [];
    this.maxEventHistory = 10;

    this.bindEvents();
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

  bindEvents() {
    this.audioToggleBtn.addEventListener('click', () => this.toggleAudio());

    this.volumeSlider.addEventListener('input', (e) => {
      const volume = parseInt(e.target.value);
      this.volumeValue.textContent = `${volume}%`;
      if (this.audioManager) {
        this.audioManager.setMasterVolume(volume / 100);
      }
    });
    
    this.clearEventsBtn.addEventListener('click', () => this.clearAudioEvents());
  }

  async initialize() {
    try {
      // Fetch initial data
      this.updateStatus('Loading stops data...');
      const stopsResponse = await fetch('/api/stops');
      if (!stopsResponse.ok) throw new Error('Failed to fetch stops');

      this.stops = await stopsResponse.json();
      this.calculateBounds();

      // Initialize spatial index for efficient stop proximity queries
      this.initializeSpatialIndex();

      // Initialize map
      this.mapManager = new InterpolatedMapManager('map-container');
      await this.mapManager.initialize(this.stops, this.bounds);

      // Handle window resize for map
      window.addEventListener('resize', () => {
        if (this.mapManager) {
          this.mapManager.resize();
        }
      });

      // Initialize route-based audio manager
      this.audioManager = new RoutePulseAudioManager(this.bounds);

      // Initialize WebSocket
      this.wsClient = new WebSocketClient();
      this.wsClient.onMessage = (data) => this.handleWebSocketMessage(data);
      this.wsClient.onStatusChange = (status) => this.updateConnectionStatus(status);
      this.wsClient.connect();

      // Start cleanup interval for inactive routes
      setInterval(() => {
        if (this.audioManager) {
          this.audioManager.cleanupInactiveRoutes();
        }
      }, CONSTANTS.TIMING.ROUTE_CLEANUP_INTERVAL_MS);

      this.updateStatus('Ready - Canvas trails with Catmull-Rom splines optimize visual quality');
      console.log(`Initialized with ${this.stops.length} stops`);

      // Don't auto-start audio - let user start manually
      this.audioToggleBtn.textContent = 'Start Audio';
      this.audioStatus.textContent = 'Stopped';

    } catch (error) {
      console.error('Initialization failed:', error);
      this.updateStatus('Initialization failed');
    }
  }
  calculateBounds() {
    if (this.stops.length === 0) return;

    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;

    this.stops.forEach(stop => {
      minLat = Math.min(minLat, stop.stop_lat);
      maxLat = Math.max(maxLat, stop.stop_lat);
      minLon = Math.min(minLon, stop.stop_lon);
      maxLon = Math.max(maxLon, stop.stop_lon);
    });

    this.bounds = [[minLat, maxLat], [minLon, maxLon]];
    console.log('Calculated bounds:', this.bounds);
  }

  initializeSpatialIndex() {
    if (!this.bounds || this.stops.length === 0) return;

    // Create spatial index with configurable grid size
    this.stopSpatialIndex = new SpatialIndex(this.bounds, CONSTANTS.SPATIAL.GRID_SIZE);
    
    // Index all stops
    this.stops.forEach(stop => {
      this.stopSpatialIndex.addItem(stop.stop_lat, stop.stop_lon, stop);
    });
    
    const stats = this.stopSpatialIndex.getStats();
    console.log(`Stop spatial index created: ${stats.totalItems} stops, ${stats.avgItemsPerCell} avg per cell, ${stats.cellSize.approxMeters} cell size`);
    
    // Quick performance test
    this.testSpatialIndexPerformance();
  }

  testSpatialIndexPerformance() {
    if (!this.stopSpatialIndex || this.stops.length === 0) return;
    
    // Test a few random points in Wellington
    const testPoints = [
      { lat: -41.2865, lon: 174.7762 }, // Wellington CBD
      { lat: -41.3067, lon: 174.7811 }, // Courtenay Place
      { lat: -41.2444, lon: 174.7633 }  // Thorndon
    ];
    
    let totalNearbyStops = 0;
    const radius = this.stopProximityThreshold * CONSTANTS.SPATIAL.SEARCH_RADIUS_MULTIPLIER;
    
    testPoints.forEach(point => {
      const nearbyStops = this.stopSpatialIndex.getItemsInRadius(point.lat, point.lon, radius);
      totalNearbyStops += nearbyStops.length;
    });
    
    const avgNearbyStops = Math.round(totalNearbyStops / testPoints.length);
    const performanceImprovement = Math.round(this.stops.length / avgNearbyStops);
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
      this.updateStatus('Starting audio...');
      const success = await this.audioManager.initialize();

      if (success) {
        this.isAudioStarted = true;
        this.audioToggleBtn.textContent = 'Stop Audio';
        this.audioStatus.textContent = 'Running';
        this.updateStatus('Audio started');

        // Resume any existing routes
        this.audioManager.resumeAllAudio();
      } else {
        throw new Error('Audio initialization failed');
      }
    } catch (error) {
      console.error('Start audio failed:', error);
      this.audioToggleBtn.textContent = 'Start Audio';
      this.audioStatus.textContent = 'Failed';
      this.updateStatus('Audio start failed');
    }
  }

  stopAudio() {
    if (!this.isAudioStarted) return;

    this.audioManager.stopAllAudio();
    this.isAudioStarted = false;
    this.audioToggleBtn.textContent = 'Start Audio';
    this.audioStatus.textContent = 'Stopped';
    this.updateStatus('Audio stopped');
  }

  handleWebSocketMessage(data) {
    if (data.type === 'bus_update') {
      // Handle both historical and real-time data, pass isHistorical flag
      this.processBusUpdate(data.buses, data.isHistorical);
      this.processDelayUpdates(data.updates);
      
      // Log differently for historical vs real-time data
      if (data.isHistorical) {
        console.log(`Processed historical data: ${data.buses.length} buses at ${new Date(data.timestamp).toLocaleTimeString()}`);
      }
    }
  }
  processBusUpdate(buses, isHistorical = false) {
    // Update interpolated map with buses, passing historical flag
    this.mapManager.updateBuses(buses, isHistorical);
    
    // Only process audio and stop detection for real-time data
    if (!isHistorical) {
      // Get lagged/interpolated positions for synchronized audio and stop detection
      const laggedRouteData = this.mapManager.getCurrentLaggedRouteData();
      const laggedPositions = this.mapManager.getCurrentLaggedPositions();
      
      // Convert lagged positions to bus format for stop detection
      const laggedBuses = Array.from(laggedPositions.entries()).map(([busId, pos]) => ({
        vehicle: {
          vehicle: { id: busId },
          position: {
            latitude: pos.lat,
            longitude: pos.lon,
            bearing: pos.bearing
          },
          trip: { route_id: pos.routeId }
        }
      }));
      
      // Detect stop arrivals using lagged positions (synchronized with visual)
      this.detectStopArrivals(laggedBuses);
      
      // Update audio using lagged route data (synchronized with visual)
      if (this.isAudioStarted && laggedRouteData.size > 0) {
        laggedRouteData.forEach((buses, routeId) => {
          this.audioManager.updateRoute(routeId, buses);
        });
        
        // Stop audio for routes with no buses in lagged data
        this.routeBusData.forEach((_, routeId) => {
          if (!laggedRouteData.has(routeId)) {
            this.audioManager.updateRoute(routeId, []);
          }
        });
      }
      
      // Store current route data (use lagged data for consistency)
      this.routeBusData = laggedRouteData;
      
      // Update UI with lagged bus count but show the synchronization
      const totalLaggedBuses = Array.from(laggedRouteData.values()).reduce((sum, buses) => sum + buses.length, 0);
      this.busCount.textContent = `${totalLaggedBuses} buses, ${laggedRouteData.size} routes`;
      
      // Update active routes display
      this.updateActiveRoutesDisplay();
      
      console.log(`Synchronized update: ${laggedRouteData.size} routes, ${totalLaggedBuses} lagged buses`);
    }
  }

  processDelayUpdates(updates) {
    if (!updates || updates.length === 0) return;

    const currentTime = Date.now() / 1000;
    let newDelayRecords = 0;

    updates.forEach(update => {
      if (!update.trip_update || !update.trip_update.stop_time_update) return;

      const tripUpdate = update.trip_update;
      const stopTimeUpdate = tripUpdate.stop_time_update;
      const arrival = stopTimeUpdate.arrival;

      if (!arrival || !arrival.delay || !stopTimeUpdate.stop_id) return;

      const delay = Math.abs(arrival.delay);
      const stopId = stopTimeUpdate.stop_id;
      const timestamp = arrival.time || currentTime;
      const rawRouteId = tripUpdate.trip?.route_id;
      const routeId = this.cleanRouteId(rawRouteId); // Clean route ID consistently

      // Store delay data for arrival blasts (adapted from Python implementation)
      if (stopId && delay > 10 && routeId) {
        this.stopDelays.set(stopId, {
          delay: delay,
          routeId: routeId, // Store cleaned route ID
          timestamp: timestamp,
          recordedAt: currentTime
        });
        newDelayRecords++;
      }

      // Only process future delays for route disruptions
      if (timestamp > currentTime && delay > 10 && routeId && this.isAudioStarted) {
        const stop = this.stops.find(s => s.stop_id === stopId);
        if (stop) {
          const triggerTime = (timestamp - currentTime) * 1000;

          setTimeout(() => {
            // Trigger route-specific delay disruption
            this.audioManager.triggerDelayEvent(routeId, delay, stop.stop_lat, stop.stop_lon);
            
            // Add to delay events display
            this.addDelayEvent(routeId, delay, stopId);
          }, triggerTime);

          console.log(`Scheduled delay disruption for route ${routeId} at stop ${stopId} in ${triggerTime / 1000}s (${delay}s delay)`);
        }
      }
    });

    if (newDelayRecords > 0) {
      console.log(`Stored ${newDelayRecords} delay records for arrival blasts. Total: ${this.stopDelays.size}`);
    }

    // Cleanup old delay records (older than 1 hour)
    if (Math.random() < 0.1) { // 10% chance to cleanup
      this.cleanupOldDelayRecords(currentTime);
    }
  }

  detectStopArrivals(buses) {
    if (!this.mapManager.animateStopPulse || !this.stopSpatialIndex) return; // Safety check

    const now = Date.now();

    buses.forEach(bus => {
      if (!bus.vehicle || !bus.vehicle.position) return;

      const busId = bus.vehicle.vehicle.id;
      const currentPos = bus.vehicle.position;
      const lastPos = this.lastBusPositions.get(busId);

      // Store current position for next comparison
      this.lastBusPositions.set(busId, {
        lat: currentPos.latitude,
        lon: currentPos.longitude,
        timestamp: now
      });

      if (!lastPos) return; // Skip first position

      // Use spatial index to get only nearby stops (much more efficient!)
      const nearbyStops = this.stopSpatialIndex.getItemsInRadius(
        currentPos.latitude, 
        currentPos.longitude, 
        this.stopProximityThreshold * CONSTANTS.SPATIAL.SEARCH_RADIUS_MULTIPLIER
      );

      // Check only the nearby stops instead of all 2000+ stops
      nearbyStops.forEach(stop => {
        const distanceToStop = this.calculateDistance(
          currentPos.latitude,
          currentPos.longitude,
          stop.stop_lat,
          stop.stop_lon
        );

        const lastDistanceToStop = lastPos ? this.calculateDistance(
          lastPos.lat,
          lastPos.lon,
          stop.stop_lat,
          stop.stop_lon
        ) : Infinity;

        // Check if this bus has recently arrived at this stop (debouncing)
        const arrivalKey = `${busId}-${stop.stop_id}`;
        const lastArrival = this.recentArrivals.get(arrivalKey);
        const timeSinceLastArrival = lastArrival ? (now - lastArrival) : Infinity;

        // Trigger animation if bus is close to stop and getting closer AND hasn't recently arrived
        if (distanceToStop < this.stopProximityThreshold &&
          lastDistanceToStop > distanceToStop &&
          distanceToStop < lastDistanceToStop - CONSTANTS.PROXIMITY.APPROACH_THRESHOLD_METERS &&
          timeSinceLastArrival > CONSTANTS.TIMING.ARRIVAL_DEBOUNCE_MS) {

          // Calculate when the bus actually crossed the proximity threshold
          const actualArrivalTime = this.interpolateArrivalTime(
            lastPos, 
            { lat: currentPos.latitude, lon: currentPos.longitude, timestamp: now },
            stop,
            this.stopProximityThreshold
          );

          // Mark this arrival to prevent spam
          this.recentArrivals.set(arrivalKey, now);

          // Calculate intensity based on how close (100m = 0.5, 0m = 1.0)
          const intensity = Math.max(0.5, 1 - (distanceToStop / this.stopProximityThreshold));
          this.mapManager.animateStopPulse(stop.stop_id, intensity);

          // Schedule arrival audio blast at the correct time
          if (this.isAudioStarted && this.audioManager) {
            // Clean route ID consistently (handles both numbers and strings, removes trailing zeros)
            const rawRouteId = bus.vehicle.trip?.route_id;
            const routeId = this.cleanRouteId(rawRouteId);
            
            if (routeId) {
              // Look up actual delay data for this stop
              const delayData = this.stopDelays.get(stop.stop_id);
              let actualDelay = 0; // Default to on-time
              
              if (delayData && delayData.routeId === routeId) {
                // Use stored delay if route matches and data is recent (within 1 hour)
                const dataAge = now / 1000 - delayData.recordedAt;
                if (dataAge < 3600) { // 1 hour
                  actualDelay = delayData.delay;
                } else {
                  console.log(`Delay data too old for stop ${stop.stop_id}, using default`);
                }
              }

              // Schedule blast based on when arrival actually occurred (relative to real-time, not batch processing time)
              this.scheduleArrivalBlastAtTime(routeId, actualDelay, stop, actualArrivalTime);
            }
          }

          console.log(`Bus ${busId} arriving at stop ${stop.stop_id} (distance: ${distanceToStop.toFixed(0)}m)`);
        }
      });

      // Cleanup old arrival records to prevent memory buildup
      if (Math.random() < 0.001) { // 0.1% chance to cleanup
        this.cleanupOldArrivals(now);
      }
    });
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    // Haversine formula for accurate geodetic distance
    const R = CONSTANTS.TIMING.EARTH_RADIUS_METERS;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; // Distance in meters
  }

  cleanupOldArrivals(currentTime) {
    const cutoffTime = currentTime - CONSTANTS.TIMING.ARRIVAL_DEBOUNCE_MS * 2; // Keep double the debounce time
    let cleanedCount = 0;
    
    for (const [key, timestamp] of this.recentArrivals.entries()) {
      if (timestamp < cutoffTime) {
        this.recentArrivals.delete(key);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} old arrival records`);
    }
  }

  cleanupOldDelayRecords(currentTime) {
    const cutoffTime = currentTime - 3600; // Remove delay records older than 1 hour
    let cleanedCount = 0;
    
    for (const [stopId, delayData] of this.stopDelays.entries()) {
      if (delayData.recordedAt < cutoffTime) {
        this.stopDelays.delete(stopId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} old delay records`);
    }
  }

  interpolateArrivalTime(lastPos, currentPos, stop, threshold) {
    // Calculate when the bus actually crossed the proximity threshold
    
    const lastDistance = this.calculateDistance(
      lastPos.lat, lastPos.lon, stop.stop_lat, stop.stop_lon
    );
    const currentDistance = this.calculateDistance(
      currentPos.lat, currentPos.lon, stop.stop_lat, stop.stop_lon
    );
    
    // If bus was already within threshold, use the earlier timestamp
    if (lastDistance <= threshold) {
      return lastPos.timestamp;
    }
    
    // Linear interpolation to find when bus crossed the threshold
    const totalDistanceChange = lastDistance - currentDistance;
    const distanceToThreshold = lastDistance - threshold;
    
    if (totalDistanceChange <= 0) {
      // Bus is moving away or not moving, use current time
      return currentPos.timestamp;
    }
    
    // Calculate the fraction of time elapsed when threshold was crossed
    const timeFraction = distanceToThreshold / totalDistanceChange;
    const timeSpan = currentPos.timestamp - lastPos.timestamp;
    
    // Interpolated arrival time
    const arrivalTime = lastPos.timestamp + (timeFraction * timeSpan);
    
    return arrivalTime;
  }

  scheduleArrivalBlastAtTime(routeId, delay, stop, arrivalTime) {
    const now = Date.now();
    const ageMs = now - arrivalTime;
    
    // Don't play blasts for very old arrivals
    if (ageMs > CONSTANTS.TIMING.MAX_BLAST_DELAY_MS) {
      console.log(`Skipping arrival blast - too old (${(ageMs/1000).toFixed(1)}s ago)`);
      return;
    }
    
    // Add to display before playing
    this.addArrivalEvent(routeId, stop.stop_id, delay, ageMs);
    
    // Simple approach: play blast in X milliseconds if bus arrived X milliseconds ago
    // This spreads out the blasts naturally based on actual arrival timing
    const playDelayMs = Math.min(ageMs, 5000); // Cap at 5 seconds to avoid too long delays
    
    if (playDelayMs <= 100) {
      // Play immediately for very recent arrivals
      this.audioManager.triggerArrivalBlast(routeId, delay, stop.stop_lat, stop.stop_lon);
      console.log(`Audio blast triggered immediately for route ${routeId} at stop ${stop.stop_id} (delay: ${delay}s, age: ${(ageMs/1000).toFixed(1)}s)`);
    } else {
      // Schedule blast to play proportionally to when it actually arrived
      setTimeout(() => {
        this.audioManager.triggerArrivalBlast(routeId, delay, stop.stop_lat, stop.stop_lon);
      }, playDelayMs);
      
      console.log(`Audio blast scheduled for route ${routeId} at stop ${stop.stop_id} in ${(playDelayMs/1000).toFixed(1)}s (arrived ${(ageMs/1000).toFixed(1)}s ago, delay: ${delay}s)`);
    }
  }

  updateActiveRoutesDisplay() {
    if (!this.routeBusData || this.routeBusData.size === 0) {
      this.activeRoutesDisplay.innerHTML = '<div class="no-events">No routes playing</div>';
      return;
    }

    const routeElements = Array.from(this.routeBusData.entries())
      .filter(([routeId, buses]) => buses.length > 0)
      .map(([routeId, buses]) => {
        const busCount = buses.length;
        const frequency = this.audioManager ? this.audioManager.getRouteBaseFrequency(routeId) : 0;
        
        return `
          <div class="audio-event">
            <div class="event-route">
              <span class="route-id">Route ${routeId}</span>
              <span class="route-details">${busCount} buses</span>
            </div>
            <div class="route-details">${frequency.toFixed(0)}Hz pulse</div>
          </div>
        `;
      })
      .join('');

    this.activeRoutesDisplay.innerHTML = routeElements;
  }

  addArrivalEvent(routeId, stopId, delay, ageMs) {
    const timestamp = new Date().toLocaleTimeString();
    const delayClass = this.getDelayClass(delay);
    const delayLabel = this.getDelayLabel(delay);
    
    const event = {
      timestamp,
      routeId,
      stopId,
      delay,
      ageMs,
      html: `
        <div class="audio-event">
          <div class="event-arrival">
            <div class="arrival-stop">Stop ${stopId.substring(0, 8)}...</div>
            <div class="arrival-details">
              Route ${routeId} • ${timestamp}
              <span class="delay-indicator ${delayClass}">${delayLabel}</span>
            </div>
          </div>
        </div>
      `
    };

    this.recentArrivalEvents.unshift(event);
    if (this.recentArrivalEvents.length > this.maxEventHistory) {
      this.recentArrivalEvents.pop();
    }

    this.updateArrivalsDisplay();
  }

  addDelayEvent(routeId, delayAmount, stopId) {
    const timestamp = new Date().toLocaleTimeString();
    
    const event = {
      timestamp,
      routeId,
      delayAmount,
      stopId,
      html: `
        <div class="audio-event">
          <div class="event-delay">
            <span class="delay-route">Route ${routeId}</span>
            <span class="delay-amount">${delayAmount}s delay</span>
          </div>
          <div class="arrival-details">${timestamp} • Stop ${stopId.substring(0, 8)}...</div>
        </div>
      `
    };

    this.recentDelayEvents.unshift(event);
    if (this.recentDelayEvents.length > this.maxEventHistory) {
      this.recentDelayEvents.pop();
    }

    this.updateDelayEventsDisplay();
  }

  updateArrivalsDisplay() {
    if (this.recentArrivalEvents.length === 0) {
      this.recentArrivalsDisplay.innerHTML = '<div class="no-events">No recent arrivals</div>';
      return;
    }

    const eventsHtml = this.recentArrivalEvents.map(event => event.html).join('');
    this.recentArrivalsDisplay.innerHTML = eventsHtml;
  }

  updateDelayEventsDisplay() {
    if (this.recentDelayEvents.length === 0) {
      this.delayEventsDisplay.innerHTML = '<div class="no-events">No delay events</div>';
      return;
    }

    const eventsHtml = this.recentDelayEvents.map(event => event.html).join('');
    this.delayEventsDisplay.innerHTML = eventsHtml;
  }

  getDelayClass(delay) {
    if (delay <= 60) return 'delay-ontime';
    if (delay <= 300) return 'delay-light';
    if (delay <= 480) return 'delay-medium';
    return 'delay-heavy';
  }

  getDelayLabel(delay) {
    if (delay <= 60) return 'On time';
    if (delay <= 300) return `${Math.round(delay/60)}m late`;
    if (delay <= 480) return `${Math.round(delay/60)}m late`;
    return `${Math.round(delay/60)}m+ late`;
  }

  clearAudioEvents() {
    this.recentArrivalEvents = [];
    this.recentDelayEvents = [];
    this.updateArrivalsDisplay();
    this.updateDelayEventsDisplay();
    console.log('Audio events display cleared');
  }

  updateConnectionStatus(status) {
    this.connectionStatus.textContent = status;
    this.connectionStatus.className = 'value ' +
      (status === 'Connected' ? 'connected' :
        status.includes('Error') || status.includes('Failed') ? 'error' : 'connecting');
  }

  updateStatus(message) {
    console.log(`Status: ${message}`);
  }

  // Debug method for canvas alignment issues
  debugCanvasAlignment() {
    if (this.mapManager && this.mapManager.canvasTrailsLayer) {
      this.mapManager.canvasTrailsLayer.debugCanvasAlignment();
    } else {
      console.log('Canvas trails layer not available');
    }
  }

  dispose() {
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
    if (this.audioManager) {
      this.audioManager.dispose();
    }
    if (this.mapManager) {
      this.mapManager.dispose();
    }
    if (this.stopSpatialIndex) {
      this.stopSpatialIndex.clear();
      this.stopSpatialIndex = null;
    }
    
    // Clear arrival and delay tracking
    this.recentArrivals.clear();
    this.lastBusPositions.clear();
    this.stopDelays.clear();
    
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
