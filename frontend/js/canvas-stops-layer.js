class CanvasStopsLayer extends L.Layer {
  constructor(stops, options = {}) {
    super();
    this.stops = stops;
    this.options = {
      stopColor: '#ff6b6b',
      stopRadius: 3,
      animationDuration: 2000,
      maxAnimationScale: 3,
      stopOpacity: 0.5,
      ...options
    };
    
    this.canvas = null;
    this.ctx = null;
    this.pixelRatio = window.devicePixelRatio || 1;
    
    // Animation state tracking
    this.animations = new Map(); // stopId -> {startTime, duration, maxScale}
    this.isAnimating = false;
    this.animationFrame = null;
    
    // Performance optimization
    this.needsRedraw = true;
    this.lastBounds = null;
    this.updateTimeout = null; // For throttling updates
  }

  onAdd(map) {
    this.map = map;
    this.createCanvas();
    this.bindEvents();
    this.redraw();
    return this;
  }

  onRemove() {
    this.unbindEvents();
    
    // Clean up timeouts
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.stopAnimation();
    return this;
  }

  createCanvas() {
    const size = this.map.getSize();
    this.canvas = L.DomUtil.create('canvas', 'leaflet-canvas-stops-layer');
    
    // Set canvas size accounting for device pixel ratio
    this.canvas.width = size.x * this.pixelRatio;
    this.canvas.height = size.y * this.pixelRatio;
    this.canvas.style.width = size.x + 'px';
    this.canvas.style.height = size.y + 'px';
    this.canvas.style.position = 'absolute';
    this.canvas.style.pointerEvents = 'none'; // Allow map interactions through canvas
    this.canvas.style.zIndex = '200';
    
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(this.pixelRatio, this.pixelRatio);
    
    // Position canvas at map's top-left
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    
    // Add to map pane
    this.map.getPanes().overlayPane.appendChild(this.canvas);
  }

  bindEvents() {
    this.map.on('viewreset', this.reset, this);
    this.map.on('zoom', this.reset, this);
    this.map.on('zoomstart', this.reset, this);
    this.map.on('zoomend', this.reset, this);
    this.map.on('movestart', this.updatePosition, this);
    this.map.on('move', this.updatePosition, this);
    this.map.on('moveend', this.updatePosition, this);
    this.map.on('resize', this.resize, this);
  }

  unbindEvents() {
    this.map.off('viewreset', this.reset, this);
    this.map.off('zoom', this.reset, this);
    this.map.off('zoomstart', this.reset, this);
    this.map.off('zoomend', this.reset, this);
    this.map.off('movestart', this.updatePosition, this);
    this.map.off('move', this.updatePosition, this);
    this.map.off('moveend', this.updatePosition, this);
    this.map.off('resize', this.resize, this);
  }

  updatePosition() {
    if (!this.canvas) return;
    
    // Throttle position updates for better performance
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    
    this.updateTimeout = setTimeout(() => {
      // Update canvas position to stay in sync with map
      const topLeft = this.map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this.canvas, topLeft);
      
      // Redraw with new positions
      this.redraw();
    }, 16); // ~60fps throttling
  }

  reset() {
    if (!this.canvas) return;
    
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    
    // Force complete redraw after reset
    this.needsRedraw = true;
    this.redraw();
  }

  resize() {
    if (!this.canvas) return;
    
    const size = this.map.getSize();
    this.canvas.width = size.x * this.pixelRatio;
    this.canvas.height = size.y * this.pixelRatio;
    this.canvas.style.width = size.x + 'px';
    this.canvas.style.height = size.y + 'px';
    
    // Reset canvas context and scaling
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(this.pixelRatio, this.pixelRatio);
    
    // Reposition and redraw
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    
    this.needsRedraw = true;
    this.redraw();
  }
  redraw() {
    if (!this.canvas || !this.ctx) return;
    
    // Clear canvas
    const size = this.map.getSize();
    this.ctx.clearRect(0, 0, size.x, size.y);
    
    // Get visible bounds for culling
    const bounds = this.map.getBounds();
    const currentTime = Date.now();
    
    // Draw all visible stops
    let drawnStops = 0;
    
    this.stops.forEach(stop => {
      // Viewport culling
      if (!bounds.contains([stop.stop_lat, stop.stop_lon])) {
        return;
      }
      
      // Convert lat/lon to pixel coordinates relative to map container
      const point = this.map.latLngToContainerPoint([stop.stop_lat, stop.stop_lon]);
      
      // Check if point is within canvas bounds
      if (point.x < 0 || point.y < 0 || point.x > size.x || point.y > size.y) {
        return;
      }
      
      // Check if stop is animating
      const animation = this.animations.get(stop.stop_id);
      let scale = 1;
      let alpha = this.options.stopOpacity;
      
      if (animation) {
        const elapsed = currentTime - animation.startTime;
        const progress = Math.min(elapsed / animation.duration, 1);
        
        if (progress >= 1) {
          // Animation finished
          this.animations.delete(stop.stop_id);
          if (this.animations.size === 0) {
            this.stopAnimation();
          }
        } else {
          // Calculate animation values
          const easeOut = 1 - Math.pow(1 - progress, 3);
          scale = 1 + (animation.maxScale - 1) * Math.sin(easeOut * Math.PI);
          alpha = 1 - progress * 0.3; // Slight fade during animation
        }
      }
      
      this.drawStop(point.x, point.y, scale, alpha);
      drawnStops++;
    });
    
    this.needsRedraw = false;
    // Only log when there are many stops or animations
    if (drawnStops > 100 || this.animations.size > 0) {
      console.log(`Canvas: Drew ${drawnStops} stops, ${this.animations.size} animating`);
    }
  }

  drawStop(x, y, scale = 1, alpha = 1) {
    const baseRadius = this.options.stopRadius;
    const radius = baseRadius * scale;
    const isAnimating = scale > 1;
    
    this.ctx.save();
    
    // Draw outer glow layers for animated stops (most pronounced)
    if (isAnimating) {
      const glowIntensity = (scale - 1) / (this.options.maxAnimationScale - 1);
      
      // Outer glow (largest, most subtle)
      const outerRadius = radius * 2.5;
      const outerGradient = this.ctx.createRadialGradient(x, y, 0, x, y, outerRadius);
      outerGradient.addColorStop(0, this.options.stopColor + '40'); // 25% opacity
      outerGradient.addColorStop(0.3, this.options.stopColor + '20'); // 12% opacity
      outerGradient.addColorStop(1, this.options.stopColor + '00'); // 0% opacity
      
      this.ctx.beginPath();
      this.ctx.arc(x, y, outerRadius, 0, Math.PI * 2);
      this.ctx.fillStyle = outerGradient;
      this.ctx.globalAlpha = alpha * glowIntensity * 0.8;
      this.ctx.fill();
      
      // Middle glow (more pronounced)
      const middleRadius = radius * 1.8;
      const middleGradient = this.ctx.createRadialGradient(x, y, 0, x, y, middleRadius);
      middleGradient.addColorStop(0, this.options.stopColor + '80'); // 50% opacity
      middleGradient.addColorStop(0.5, this.options.stopColor + '40'); // 25% opacity
      middleGradient.addColorStop(1, this.options.stopColor + '00'); // 0% opacity
      
      this.ctx.beginPath();
      this.ctx.arc(x, y, middleRadius, 0, Math.PI * 2);
      this.ctx.fillStyle = middleGradient;
      this.ctx.globalAlpha = alpha * glowIntensity;
      this.ctx.fill();
    }
    
    // Main stop circle with radial fade
    const coreGradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius);
    coreGradient.addColorStop(0, this.options.stopColor + 'FF'); // 100% opacity at center
    coreGradient.addColorStop(0.7, this.options.stopColor + 'CC'); // 80% opacity
    coreGradient.addColorStop(1, this.options.stopColor + '99'); // 60% opacity at edge
    
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fillStyle = coreGradient;
    this.ctx.globalAlpha = alpha;
    this.ctx.fill();
    
    this.ctx.restore();
  }

  // Main API method for triggering stop animations
  animateStopPulse(stopId, intensity = 1) {
    const maxScale = Math.min(1 + intensity * 2, this.options.maxAnimationScale);
    
    this.animations.set(stopId, {
      startTime: Date.now(),
      duration: this.options.animationDuration,
      maxScale: maxScale
    });
    
    // Start animation loop if not already running
    if (!this.isAnimating) {
      this.startAnimation();
    }
  }
  startAnimation() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    
    const animate = () => {
      if (!this.isAnimating || this.animations.size === 0) {
        this.stopAnimation();
        return;
      }
      
      this.redraw();
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

  // Batch update multiple stop animations (for efficiency)
  animateMultipleStops(stopAnimations) {
    let hasNewAnimations = false;
    
    stopAnimations.forEach(({ stopId, intensity }) => {
      this.animateStopPulse(stopId, intensity);
      hasNewAnimations = true;
    });
    
    if (hasNewAnimations && !this.isAnimating) {
      this.startAnimation();
    }
  }

  // Get number of currently animating stops
  getAnimationCount() {
    return this.animations.size;
  }

  // Force immediate redraw (useful for viewport changes)
  forceRedraw() {
    this.needsRedraw = true;
    this.redraw();
  }

  // Update stop data (if stops change dynamically)
  updateStops(newStops) {
    this.stops = newStops;
    this.needsRedraw = true;
    this.redraw();
  }

  // Clear all animations
  clearAnimations() {
    this.animations.clear();
    this.stopAnimation();
    this.redraw();
  }
}

// Export for use in other modules
window.CanvasStopsLayer = CanvasStopsLayer;