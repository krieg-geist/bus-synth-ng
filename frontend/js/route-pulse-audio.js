// Constants
const AUDIO_CONSTANTS = {
  FREQUENCY: {
    BASE_MIN_HZ: 100,
    BASE_MAX_HZ: 800,
    PITCH_MODULATION_RANGE: 0.5 // ±20%
  },
  PULSE: {
    RATE_MIN_HZ: 0.3,
    RATE_MAX_HZ: 5.0,
    MAX_BUSES_PER_ROUTE: 20
  },
  VOLUME: {
    MASTER_DEFAULT: 0.8,
    ROUTE_MIN_DB: -8,
    ROUTE_MAX_DB: 0,
    LIMITER_THRESHOLD_DB: -1
  },
  TIMING: {
    CLEANUP_THRESHOLD_MS: 30000, // 30 seconds
    DISPOSE_DELAY_MS: 100,
    DISRUPTION_MAX_SECONDS: 2,
    DISRUPTION_SLOW_HZ: 1
  },
  EFFECTS: {
    REVERB_DECAY: 2,
    REVERB_PREDELAY: 0.05,
    REVERB_WET: 0.2,
    PAN_RANGE: 0.8
  },
  ARRIVAL: {
    NOISE_DURATION_MIN: 0.05,    // Minimum blast duration
    NOISE_DURATION_MAX: 0.6,     // Maximum blast duration
    MAX_DELAY_SECONDS: 600,
    FILTER_FREQ_MIN: 800,        // Heavy filtering for on-time
    FILTER_FREQ_MAX: 20000,      // No filtering for very late
    // Discrete bitcrush levels
    BITCRUSH_LEVELS: {
      NONE: { intensity: 0, label: 'clean' },
      LIGHT: { intensity: 0.3, label: 'light crunch' },
      MEDIUM: { intensity: 0.6, label: 'medium crunch' },
      HEAVY: { intensity: 1.0, label: 'heavy crunch' }
    },
    DELAY_THRESHOLDS: {
      LIGHT_BITCRUSH: 120,   // 2 minutes
      MEDIUM_BITCRUSH: 300,  // 5 minutes  
      HEAVY_BITCRUSH: 480    // 8 minutes
    },
    VOLUME_DB: -6
  },
  ENVELOPE: {
    ATTACK: 0.05,
    DECAY: 0.3,
    SUSTAIN: 0.2,
    RELEASE: 0.5
  },
  PERFORMANCE: {
    NOISE_BUFFER_COUNT: 10,      // Pre-generated noise buffers
    PARAM_UPDATE_BATCH_SIZE: 10  // Batch parameter updates
  }
};

class RoutePulseAudioManager {
  constructor(bounds) {
    this.bounds = bounds; // [[minLat, maxLat], [minLon, maxLon]]
    this.routes = new Map(); // routeId -> route audio data
    this.isStarted = false;
    this.masterVolume = AUDIO_CONSTANTS.VOLUME.MASTER_DEFAULT;
    
    // Web Audio API context and global nodes
    this.audioContext = null;
    this.masterGain = null;
    this.limiter = null;
    this.reverb = null;
    
    // Performance optimizations
    this.noiseBuffers = []; // Pre-generated noise buffers
    this.bitcrusherWaveShaper = null; // Reusable bitcrusher
    this.parameterUpdateQueue = []; // Batch parameter updates
    
    // Route audio parameters
    this.baseFreqRange = [AUDIO_CONSTANTS.FREQUENCY.BASE_MIN_HZ, AUDIO_CONSTANTS.FREQUENCY.BASE_MAX_HZ];
    this.pulseRateRange = [AUDIO_CONSTANTS.PULSE.RATE_MIN_HZ, AUDIO_CONSTANTS.PULSE.RATE_MAX_HZ];
    this.maxBusesPerRoute = AUDIO_CONSTANTS.PULSE.MAX_BUSES_PER_ROUTE;
  }

  async initialize() {
    try {
      // Create Web Audio API context
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContext();
      
      // Resume context if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('Audio context resumed');
      }
      
      // Create global effects chain
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.audioContext.destination);
      
      // Create limiter (using DynamicsCompressor)
      this.limiter = this.audioContext.createDynamicsCompressor();
      this.limiter.threshold.value = this.dbToLinear(AUDIO_CONSTANTS.VOLUME.LIMITER_THRESHOLD_DB);
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.01;
      this.limiter.connect(this.masterGain);
      
      // Create simplified reverb
      this.reverb = this.createSimpleReverb();
      this.reverb.connect(this.limiter);
      
      // Pre-generate noise buffers for performance
      this.generateNoiseBuffers();
      
      // Create bitcrusher waveshaper
      this.createBitcrusherWaveShaper();
      
      // Initialize buffer source pool
      
      // Start parameter update batching
      this.startParameterUpdateBatching();
      
      
      this.isStarted = true;
      return true;
    } catch (error) {
      console.error('Audio initialization failed:', error);
      return false;
    }
  }

  generateNoiseBuffers() {
    const sampleRate = this.audioContext.sampleRate;
    // Use maximum duration for buffer generation to ensure we have enough samples
    const bufferLength = Math.floor(sampleRate * AUDIO_CONSTANTS.ARRIVAL.NOISE_DURATION_MAX);
    
    // Safety check for buffer size
    const maxBufferSize = sampleRate * 2; // Max 2 seconds
    const safeBufferLength = Math.min(bufferLength, maxBufferSize);
    
    
    for (let i = 0; i < AUDIO_CONSTANTS.PERFORMANCE.NOISE_BUFFER_COUNT; i++) {
      const buffer = this.audioContext.createBuffer(1, safeBufferLength, sampleRate);
      const data = buffer.getChannelData(0);
      
      // Generate white noise
      for (let j = 0; j < safeBufferLength; j++) {
        data[j] = Math.random() * 2 - 1;
      }
      
      this.noiseBuffers.push(buffer);
    }
  }

  createSimpleReverb() {
    // Simple delay-based reverb instead of convolver for better performance
    const reverbGain = this.audioContext.createGain();
    const wetGain = this.audioContext.createGain();
    const dryGain = this.audioContext.createGain();
    const merger = this.audioContext.createGain();
    
    // Create multiple delays for reverb effect
    const delays = [];
    const delayTimes = [0.05, 0.1, 0.15, 0.2]; // Different delay times
    const decayGains = [0.3, 0.2, 0.15, 0.1]; // Decreasing gains
    
    delayTimes.forEach((time, index) => {
      const delay = this.audioContext.createDelay(1.0);
      const feedback = this.audioContext.createGain();
      
      delay.delayTime.value = time;
      feedback.gain.value = decayGains[index];
      
      reverbGain.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay); // Feedback loop
      delay.connect(wetGain);
      
      delays.push({ delay, feedback });
    });
    
    // Set up wet/dry mix
    wetGain.gain.value = AUDIO_CONSTANTS.EFFECTS.REVERB_WET;
    dryGain.gain.value = 1 - AUDIO_CONSTANTS.EFFECTS.REVERB_WET;
    
    reverbGain.connect(dryGain);
    dryGain.connect(merger);
    wetGain.connect(merger);
    
    // Return the input node for connection
    merger.reverbInput = reverbGain;
    merger.delays = delays; // Store for cleanup
    return merger;
  }

  createBitcrusherWaveShaper() {
    // Create waveshaper for efficient bitcrushing
    this.bitcrusherWaveShaper = this.audioContext.createWaveShaper();
    this.bitcrusherWaveShaper.oversample = 'none'; // Better performance
    
    // Generate curve for bitcrushing effect
    this.updateBitcrusherCurve(0.5); // Default intensity
  }

  updateBitcrusherCurve(intensity) {
    const samples = 65536;
    const curve = new Float32Array(samples);
    const bitReduction = Math.floor(intensity * 12) + 4; // 4-16 bits
    const sampleReduction = Math.pow(2, Math.floor(intensity * 8)); // Sample rate reduction
    
    for (let i = 0; i < samples; i++) {
      const x = (i - samples / 2) / (samples / 2);
      
      // Apply bit reduction
      const bits = Math.pow(2, bitReduction - 1);
      let crushed = Math.round(x * bits) / bits;
      
      // Apply sample rate reduction (creates aliasing)
      if (i % sampleReduction !== 0) {
        crushed = curve[i - (i % sampleReduction)] || 0;
      }
      
      curve[i] = Math.max(-1, Math.min(1, crushed));
    }
    
    this.bitcrusherWaveShaper.curve = curve;
  }



  getPooledBufferSource() {
    // Always create new buffer source since they can't be reused after start()
    return this.audioContext.createBufferSource();
  }



  startParameterUpdateBatching() {
    // Batch parameter updates for better performance
    setInterval(() => {
      this.flushParameterUpdates();
    }, 16); // ~60fps
  }

  queueParameterUpdate(param, value, time) {
    this.parameterUpdateQueue.push({ param, value, time });
    
    // Flush immediately if queue is getting large
    if (this.parameterUpdateQueue.length >= AUDIO_CONSTANTS.PERFORMANCE.PARAM_UPDATE_BATCH_SIZE) {
      this.flushParameterUpdates();
    }
  }

  flushParameterUpdates() {
    if (this.parameterUpdateQueue.length === 0) return;
    
    // Group updates and apply them
    this.parameterUpdateQueue.forEach(update => {
      try {
        if (update.time) {
          update.param.exponentialRampToValueAtTime(update.value, update.time);
        } else {
          update.param.value = update.value;
        }
      } catch (error) {
        // Ignore parameter update errors
      }
    });
    
    this.parameterUpdateQueue.length = 0;
  }
  createRouteAudio(routeId) {
    if (!this.isStarted || this.routes.has(routeId)) return;

    try {
      const baseFreq = this.getRouteBaseFrequency(routeId);
      
      // Create continuous synthesis chain for better performance
      const oscillator = this.audioContext.createOscillator();
      const pulseGain = this.audioContext.createGain();
      const volume = this.audioContext.createGain();
      const filter = this.audioContext.createBiquadFilter();
      const panner = this.audioContext.createStereoPanner();
      
      // Configure oscillator - continuous instead of one-shot
      oscillator.type = 'sine';
      oscillator.frequency.value = baseFreq;
      oscillator.start(); // Start immediately and keep running
      
      // Configure pulse gain (for amplitude modulation)
      pulseGain.gain.value = 0; // Start silent
      
      // Configure filter
      filter.type = 'lowpass';
      filter.frequency.value = baseFreq * 4;
      filter.Q.value = 1;
      
      // Configure volume (convert dB to linear)
      volume.gain.value = this.dbToLinear(AUDIO_CONSTANTS.VOLUME.ROUTE_MIN_DB);
      
      // Configure panner
      panner.pan.value = 0;
      
      // Connect continuous synthesis chain
      oscillator.connect(pulseGain);
      pulseGain.connect(volume);
      volume.connect(panner);
      panner.connect(filter);
      filter.connect(this.reverb.reverbInput);
      
      // Store route audio components
      this.routes.set(routeId, {
        oscillator,
        pulseGain,
        volume,
        filter,
        panner,
        baseFreq,
        busCount: 0,
        isPlaying: false,
        lastUpdate: Date.now(),
        pulseInterval: null,
        currentFreq: baseFreq,
        // Performance tracking
        lastPulseTime: 0
      });
      
    } catch (error) {
      console.error(`Failed to create route audio ${routeId}:`, error);
    }
  }

  updateRoute(routeId, buses) {
    if (!this.isStarted) return;
    
    if (!this.routes.has(routeId)) {
      this.createRouteAudio(routeId);
    }
    
    const route = this.routes.get(routeId);
    if (!route) return;
    
    try {
      const busCount = buses.length;
      route.busCount = busCount;
      route.lastUpdate = Date.now();
      
      if (busCount === 0) {
        // Stop route if no buses
        if (route.isPlaying) {
          if (route.pulseInterval) {
            clearInterval(route.pulseInterval);
            route.pulseInterval = null;
          }
          // Fade out instead of immediate stop
          const now = this.audioContext.currentTime;
          route.pulseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
          route.isPlaying = false;
        }
        return;
      }
      
      // Calculate average position for pitch modulation
      const avgLat = buses.reduce((sum, bus) => sum + bus.position.latitude, 0) / busCount;
      const avgLon = buses.reduce((sum, bus) => sum + bus.position.longitude, 0) / busCount;
      
      // Map bus count to pulse rate
      const pulseRate = this.mapRange(
        Math.min(busCount, this.maxBusesPerRoute), 
        [1, this.maxBusesPerRoute], 
        this.pulseRateRange
      );
      
      // Map position to pitch variation
      const pitchMod = this.mapRange(avgLat, this.bounds[0], [-AUDIO_CONSTANTS.FREQUENCY.PITCH_MODULATION_RANGE, AUDIO_CONSTANTS.FREQUENCY.PITCH_MODULATION_RANGE]);
      const frequency = route.baseFreq * (1 + pitchMod);
      
      // Map longitude to stereo position
      const pan = this.mapRange(avgLon, this.bounds[1], [-AUDIO_CONSTANTS.EFFECTS.PAN_RANGE, AUDIO_CONSTANTS.EFFECTS.PAN_RANGE]);
      
      // Map bus count to volume
      const volumeDb = this.mapRange(busCount, [1, this.maxBusesPerRoute], [AUDIO_CONSTANTS.VOLUME.ROUTE_MIN_DB, AUDIO_CONSTANTS.VOLUME.ROUTE_MAX_DB]);
      
      // Update audio parameters efficiently
      route.currentFreq = frequency;
      
      const now = this.audioContext.currentTime;
      
      // Queue batched parameter updates for better performance
      this.queueParameterUpdate(route.oscillator.frequency, frequency, now + 0.5);
      this.queueParameterUpdate(route.filter.frequency, frequency * 3, now + 0.5);
      this.queueParameterUpdate(route.volume.gain, this.dbToLinear(volumeDb), now + 0.3);
      this.queueParameterUpdate(route.panner.pan, pan, now + 0.5);
      
      // Start playing if not already
      if (!route.isPlaying) {
        const intervalMs = 1000 / pulseRate;
        route.pulseInterval = setInterval(() => {
          this.triggerPulse(route);
        }, intervalMs);
        
        route.isPlaying = true;
      } else {
        // Update pulse rate
        if (route.pulseInterval) {
          clearInterval(route.pulseInterval);
        }
        const intervalMs = 1000 / pulseRate;
        route.pulseInterval = setInterval(() => {
          this.triggerPulse(route);
        }, intervalMs);
      }
      
    } catch (error) {
      console.error(`Failed to update route ${routeId}:`, error);
    }
  }

  triggerPulse(route) {
    try {
      const now = this.audioContext.currentTime;
      
      // Prevent pulse overlapping for performance
      if (now - route.lastPulseTime < 0.05) return;
      route.lastPulseTime = now;
      
      // Use amplitude modulation instead of creating new oscillators
      const attackTime = AUDIO_CONSTANTS.ENVELOPE.ATTACK;
      const decayTime = AUDIO_CONSTANTS.ENVELOPE.DECAY;
      const sustainLevel = AUDIO_CONSTANTS.ENVELOPE.SUSTAIN;
      const releaseTime = AUDIO_CONSTANTS.ENVELOPE.RELEASE;
      const duration = 0.25;
      
      // ADSR envelope using existing gain node
      route.pulseGain.gain.setValueAtTime(0, now);
      route.pulseGain.gain.linearRampToValueAtTime(1, now + attackTime);
      route.pulseGain.gain.linearRampToValueAtTime(sustainLevel, now + attackTime + decayTime);
      route.pulseGain.gain.linearRampToValueAtTime(0, now + duration);
      
    } catch (error) {
      console.warn('Error triggering pulse:', error);
    }
  }

  triggerArrivalBlast(routeId, delaySeconds, lat, lon) {
    if (!this.isStarted) return;
    
    try {
      // Clamp delay to 0-600 seconds range
      const clampedDelay = Math.max(0, Math.min(AUDIO_CONSTANTS.ARRIVAL.MAX_DELAY_SECONDS, delaySeconds));
      
      // Calculate variable duration based on delay (longer delays = longer blasts)
      const delayNormalized = clampedDelay / AUDIO_CONSTANTS.ARRIVAL.MAX_DELAY_SECONDS;
      const duration = AUDIO_CONSTANTS.ARRIVAL.NOISE_DURATION_MIN + 
        (delayNormalized * (AUDIO_CONSTANTS.ARRIVAL.NOISE_DURATION_MAX - AUDIO_CONSTANTS.ARRIVAL.NOISE_DURATION_MIN));
      
      const now = this.audioContext.currentTime;
      
      // Filter frequency: starts low (heavy filtering) and increases with delay
      const filterFreq = this.mapRange(
        delayNormalized,
        [0, 1],
        [AUDIO_CONSTANTS.ARRIVAL.FILTER_FREQ_MIN, AUDIO_CONSTANTS.ARRIVAL.FILTER_FREQ_MAX]
      );
      
      // Determine discrete bitcrush level based on delay thresholds
      let bitcrushLevel = AUDIO_CONSTANTS.ARRIVAL.BITCRUSH_LEVELS.NONE;
      let bitcrushLabel = bitcrushLevel.label;
      
      if (clampedDelay >= AUDIO_CONSTANTS.ARRIVAL.DELAY_THRESHOLDS.HEAVY_BITCRUSH) {
        bitcrushLevel = AUDIO_CONSTANTS.ARRIVAL.BITCRUSH_LEVELS.HEAVY;
        bitcrushLabel = bitcrushLevel.label;
      } else if (clampedDelay >= AUDIO_CONSTANTS.ARRIVAL.DELAY_THRESHOLDS.MEDIUM_BITCRUSH) {
        bitcrushLevel = AUDIO_CONSTANTS.ARRIVAL.BITCRUSH_LEVELS.MEDIUM;
        bitcrushLabel = bitcrushLevel.label;
      } else if (clampedDelay >= AUDIO_CONSTANTS.ARRIVAL.DELAY_THRESHOLDS.LIGHT_BITCRUSH) {
        bitcrushLevel = AUDIO_CONSTANTS.ARRIVAL.BITCRUSH_LEVELS.LIGHT;
        bitcrushLabel = bitcrushLevel.label;
      }
      
      // Get pre-generated noise buffer for performance
      const noiseBuffer = this.noiseBuffers[Math.floor(Math.random() * this.noiseBuffers.length)];
      
      // Get pooled buffer source
      const noiseSource = this.getPooledBufferSource();
      const volume = this.audioContext.createGain();
      const filter = this.audioContext.createBiquadFilter();
      const panner = this.audioContext.createStereoPanner();
      
      noiseSource.buffer = noiseBuffer;
      volume.gain.value = this.dbToLinear(AUDIO_CONSTANTS.ARRIVAL.VOLUME_DB);
      
      // Configure filter
      filter.type = 'lowpass';
      filter.frequency.value = filterFreq;
      filter.Q.value = 1;
      
      // Map position to stereo pan
      const pan = this.mapRange(lon, this.bounds[1], [-AUDIO_CONSTANTS.EFFECTS.PAN_RANGE, AUDIO_CONSTANTS.EFFECTS.PAN_RANGE]);
      panner.pan.value = pan;
      
      // Update bitcrusher for this discrete level
      this.updateBitcrusherCurve(bitcrushLevel.intensity);
      
      // Connect audio chain
      noiseSource.connect(volume);
      volume.connect(panner);
      panner.connect(filter);
      
      // Apply bitcrushing if needed
      if (bitcrushLevel.intensity > 0.1) {
        filter.connect(this.bitcrusherWaveShaper);
        this.bitcrusherWaveShaper.connect(this.reverb.reverbInput);
      } else {
        filter.connect(this.reverb.reverbInput);
      }
      
      // Play the blast with variable duration
      noiseSource.start(now);
      noiseSource.stop(now + duration);
      
      
      // Efficient cleanup
      noiseSource.addEventListener('ended', () => {
        try {
          noiseSource.disconnect();
          volume.disconnect();
          panner.disconnect();
          filter.disconnect();
          if (bitcrushLevel.intensity > 0.1) {
            this.bitcrusherWaveShaper.disconnect();
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      });
      
    } catch (error) {
      console.error(`Failed to trigger arrival blast for route ${routeId}:`, error);
    }
  }
  triggerDelayEvent(routeId, delayIntensity, lat, lon) {
    if (!this.isStarted) return;
    
    const route = this.routes.get(routeId);
    if (!route || !route.isPlaying) return;
    
    try {
      const disruptionDuration = Math.min(delayIntensity / 50, AUDIO_CONSTANTS.TIMING.DISRUPTION_MAX_SECONDS);
      
      // Temporarily slow down the pulse 
      if (route.pulseInterval) {
        clearInterval(route.pulseInterval);
        
        // Slower interval during disruption
        const slowIntervalMs = 1000 / AUDIO_CONSTANTS.TIMING.DISRUPTION_SLOW_HZ;
        route.pulseInterval = setInterval(() => {
          this.triggerPulse(route);
        }, slowIntervalMs);
      }
      
      // Add filter modulation efficiently
      const now = this.audioContext.currentTime;
      this.queueParameterUpdate(route.filter.frequency, route.baseFreq * 6, now + 0.1);
      
      // Return to normal after disruption
      setTimeout(() => {
        if (route.isPlaying && route.busCount > 0) {
          // Restore normal pulse rate
          const normalPulseRate = this.mapRange(
            Math.min(route.busCount, this.maxBusesPerRoute), 
            [1, this.maxBusesPerRoute], 
            this.pulseRateRange
          );
          
          if (route.pulseInterval) {
            clearInterval(route.pulseInterval);
          }
          
          const intervalMs = 1000 / normalPulseRate;
          route.pulseInterval = setInterval(() => {
            this.triggerPulse(route);
          }, intervalMs);
          
          const restoreTime = this.audioContext.currentTime;
          this.queueParameterUpdate(route.filter.frequency, route.baseFreq * 3, restoreTime + 0.5);
        }
      }, disruptionDuration * 1000);
      
    } catch (error) {
      console.error(`Failed to trigger delay event for route ${routeId}:`, error);
    }
  }

  removeRoute(routeId) {
    const route = this.routes.get(routeId);
    if (!route) return;

    try {
      // Stop pulse generation immediately
      if (route.isPlaying) {
        if (route.pulseInterval) {
          clearInterval(route.pulseInterval);
          route.pulseInterval = null;
        }
        route.isPlaying = false;
      }
      
      // Clean up audio nodes efficiently
      try {
        if (route.oscillator) {
          route.oscillator.stop();
          route.oscillator.disconnect();
        }
      } catch (error) {
        // Ignore cleanup errors for stopped oscillators
      }
      
      try {
        if (route.pulseGain) route.pulseGain.disconnect();
        if (route.filter) route.filter.disconnect();
        if (route.volume) route.volume.disconnect();
        if (route.panner) route.panner.disconnect();
      } catch (error) {
        console.warn(`Error disconnecting nodes for route ${routeId}:`, error);
      }
      
      // Remove from routes map
      this.routes.delete(routeId);
      
    } catch (error) {
      console.error(`Failed to remove route ${routeId}:`, error);
      // Still remove from map even if cleanup failed
      this.routes.delete(routeId);
    }
  }

  setMasterVolume(volume) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      // Use batched updates for master volume too
      this.queueParameterUpdate(this.masterGain.gain, this.masterVolume);
    }
  }

  stopAllAudio() {
    // Prevent new audio events
    this.isStarted = false;
    
    // Immediately mute master gain for instant silence
    if (this.masterGain) {
      this.masterGain.gain.value = 0;
    }
    
    this.routes.forEach((route, routeId) => {
      if (route.isPlaying) {
        // Stop pulse intervals
        if (route.pulseInterval) {
          clearInterval(route.pulseInterval);
          route.pulseInterval = null;
        }
        route.isPlaying = false;
      }
      
      // Stop and disconnect all audio nodes
      try {
        if (route.oscillator) {
          route.oscillator.stop();
          route.oscillator.disconnect();
        }
        if (route.pulseGain) route.pulseGain.disconnect();
        if (route.volume) route.volume.disconnect();
        if (route.filter) route.filter.disconnect();
        if (route.panner) route.panner.disconnect();
      } catch (error) {
        // Ignore cleanup errors (node may already be stopped/disconnected)
      }
    });
    
    // Clear all routes
    this.routes.clear();
  }

  resumeAllAudio() {
    this.routes.forEach((route, routeId) => {
      if (!route.isPlaying && route.busCount > 0) {
        const pulseRate = this.mapRange(
          Math.min(route.busCount, this.maxBusesPerRoute), 
          [1, this.maxBusesPerRoute], 
          this.pulseRateRange
        );
        
        const intervalMs = 1000 / pulseRate;
        route.pulseInterval = setInterval(() => {
          this.triggerPulse(route);
        }, intervalMs);
        
        route.isPlaying = true;
      }
    });
  }

  getRouteBaseFrequency(routeId) {
    // Hash route ID to consistent frequency
    const hash = this.hashString(routeId);
    const normalizedHash = (hash % 1000) / 1000;
    return this.baseFreqRange[0] + normalizedHash * (this.baseFreqRange[1] - this.baseFreqRange[0]);
  }

  mapRange(value, inputRange, outputRange) {
    const clampedValue = Math.max(inputRange[0], Math.min(inputRange[1], value));
    const normalized = (clampedValue - inputRange[0]) / (inputRange[1] - inputRange[0]);
    return outputRange[0] + normalized * (outputRange[1] - outputRange[0]);
  }

  hashString(str) {
    // Convert to string to handle both string and number route IDs
    const stringValue = String(str);
    let hash = 0;
    
    for (let i = 0; i < stringValue.length; i++) {
      const char = stringValue.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash | 0; // Convert to 32-bit integer (was broken before)
    }
    return Math.abs(hash);
  }

  dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  getRouteCount() {
    return this.routes.size;
  }

  getActiveRouteCount() {
    let active = 0;
    this.routes.forEach(route => {
      if (route.isPlaying) active++;
    });
    return active;
  }

  // Clean up inactive routes (no buses for over 30 seconds)
  cleanupInactiveRoutes() {
    const now = Date.now();
    const inactiveThreshold = AUDIO_CONSTANTS.TIMING.CLEANUP_THRESHOLD_MS;
    
    this.routes.forEach((route, routeId) => {
      if (route.busCount === 0 && (now - route.lastUpdate) > inactiveThreshold) {
        this.removeRoute(routeId);
      }
    });
  }

  dispose() {
    console.log('Disposing audio manager...');
    
    // Stop all audio first
    this.stopAllAudio();
    
    // Clean up all routes
    const routeIds = Array.from(this.routes.keys());
    routeIds.forEach(routeId => {
      this.removeRoute(routeId);
    });
    
    // Clean up global nodes
    try {
      if (this.reverb) {
        // Clean up delay-based reverb
        if (this.reverb.delays) {
          this.reverb.delays.forEach(({ delay, feedback }) => {
            delay.disconnect();
            feedback.disconnect();
          });
        }
        this.reverb.disconnect();
        this.reverb = null;
      }
    } catch (error) {
      console.warn('Error disposing reverb:', error);
    }
    
    try {
      if (this.limiter) {
        this.limiter.disconnect();
        this.limiter = null;
      }
    } catch (error) {
      console.warn('Error disposing limiter:', error);
    }
    
    try {
      if (this.masterGain) {
        this.masterGain.disconnect();
        this.masterGain = null;
      }
    } catch (error) {
      console.warn('Error disposing master gain:', error);
    }
    
    try {
      if (this.bitcrusherWaveShaper) {
        this.bitcrusherWaveShaper.disconnect();
        this.bitcrusherWaveShaper = null;
      }
    } catch (error) {
      console.warn('Error disposing bitcrusher:', error);
    }
    
    // Close audio context
    try {
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close();
        this.audioContext = null;
      }
    } catch (error) {
      console.warn('Error closing audio context:', error);
    }
    
    // Clear performance optimizations
    this.noiseBuffers.length = 0;
    this.parameterUpdateQueue.length = 0;
    
    // Clear collections
    this.routes.clear();
    this.isStarted = false;
    
    console.log('Audio manager disposed');
  }

  // Performance monitoring methods
  getPerformanceStats() {
    return {
      activeRoutes: this.getActiveRouteCount(),
      totalRoutes: this.getRouteCount(),
      noiseBuffersGenerated: this.noiseBuffers.length,
      pendingParameterUpdates: this.parameterUpdateQueue.length,
      audioContextState: this.audioContext?.state || 'none'
    };
  }

  logPerformanceStats() {
    const stats = this.getPerformanceStats();
    console.log('🎵 Audio Performance Stats:', stats);
  }
}

window.RoutePulseAudioManager = RoutePulseAudioManager;