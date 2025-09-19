// Shared constants for Bus Synth application
const SHARED_CONSTANTS = {
  // Network configuration
  NETWORK: {
    DEFAULT_HTTP_PORT: 3000,
    DEFAULT_WS_PORT: 8765,
    WS_RECONNECT_MAX_ATTEMPTS: 5,
    WS_RECONNECT_BASE_DELAY: 1000
  },

  // Cache configuration
  CACHE: {
    // TTL for different data types
    BUSES_TTL_MS: 8000,        // 8 seconds
    STOPS_TTL_MS: 86400000,    // 24 hours
    UPDATES_TTL_MS: 30000,     // 30 seconds
    
    // Historical cache settings
    HISTORICAL_MAX_AGE_MS: 90000,      // 90 seconds
    HISTORICAL_CLEANUP_INTERVAL_MS: 30000,  // 30 seconds
    HISTORICAL_MAX_ENTRIES: 50         // Safety limit
  },

  // Polling and timing
  POLLING: {
    BROADCAST_INTERVAL_MS: 10000,  // 10 seconds
    STARTUP_DELAY_MS: 2000,        // 2 seconds
    ROUTE_CLEANUP_INTERVAL_MS: 60000, // 1 minute (moved from TIMING)
    ARRIVAL_DEBOUNCE_MS: 30000,    // 30 seconds (moved from TIMING)
    MAX_BLAST_DELAY_MS: 15000      // 15 seconds (moved from TIMING)
  },

  // Proximity and spatial calculations
  PROXIMITY: {
    STOP_THRESHOLD_METERS: 100,
    APPROACH_THRESHOLD_METERS: 20,
    GRID_SIZE: 50,                 // Moved from SPATIAL
    SEARCH_RADIUS_MULTIPLIER: 2    // Moved from SPATIAL
  },

  // General timing constants
  TIMING: {
    ROUTE_CLEANUP_INTERVAL_MS: 60000, // 1 minute
    EARTH_RADIUS_METERS: 6371000,
    ARRIVAL_DEBOUNCE_MS: 30000, // 30 seconds between arrivals at same stop
    MAX_BLAST_DELAY_MS: 15000   // Don't play blasts for arrivals older than 15 seconds
  },

  // Spatial indexing
  SPATIAL: {
    GRID_SIZE: 50, // 50x50 grid for Wellington (~800m cells)
    SEARCH_RADIUS_MULTIPLIER: 2 // Search radius = threshold × multiplier
  },

  MAP: {
    TIMING: {
      DISPLAY_LAG_MS: 60000,      // 1 minute lag
      MAX_HISTORY_AGE_MS: 180000, // 3 minutes of history
      HISTORICAL_SPREAD_MS: 90000, // Spread historical data over 90s
      HISTORICAL_INTERVAL_MS: 10000, // 10s between historical entries
      MAX_TIME_GAP_MS: 30000      // Max gap before clearing trails (30s)
    },
    TRAIL: {
      LENGTH_SEGMENTS: 15,
      FADE_STEPS: 8,
      MAX_SEGMENT_DISTANCE_M: 800 // Maximum meters between trail points
    },
    BUS_ICON: {
      WIDTH: 6,
      HEIGHT: 16,
      STROKE_WIDTH: 1,
      BORDER_RADIUS: 0.5
    },
    STOP_PULSE: {
      WIDTH: 12,
      HEIGHT: 12,
      OUTER_RADIUS: 5,
      INNER_RADIUS: 3
    }
  },

  // Audio synthesis constants
  AUDIO: {
    FREQUENCY: {
      BASE_MIN_HZ: 100,
      BASE_MAX_HZ: 800,
      PITCH_MODULATION_RANGE: 0.5 // ±20%
    },
    PULSE: {
      RATE_MIN_HZ: 0.05,
      RATE_MAX_HZ: 2.0,
      MAX_BUSES_PER_ROUTE: 20
    },
    VOLUME: {
      MASTER_DEFAULT: 0.8,
      ROUTE_MIN_DB: -8,
      ROUTE_MAX_DB: 0,
      LIMITER_THRESHOLD_DB: -1,
      // Advanced gain scaling constants
      ROUTE_LOG_BASE: Math.E, // Natural log for smooth scaling
      ROUTE_MAX_BOOST_DB: 12, // Cap route boost at +12dB
      MASTER_MIN_BUSES: 10,   // 10 buses = 0.5 master gain
      MASTER_MAX_BUSES: 120   // 120+ buses = 1.0 master gain
    },
    EFFECTS: {
      REVERB_DECAY: 2,
      REVERB_PREDELAY: 0.05,
      REVERB_WET: 0.2,
      PAN_RANGE: 1.0
    },
    ARRIVAL: {
      NOISE_DURATION_MIN: 0.05,    // Minimum blast duration
      NOISE_DURATION_MAX: 0.6,     // Maximum blast duration
      MAX_DELAY_SECONDS: 600,
      FILTER_FREQ_MIN: 800,        // Heavy filtering for on-time
      FILTER_FREQ_MAX: 20000,      // No filtering for very late
      VOLUME_DB: -6,
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
      }
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
  }
};

// Browser global export
if (typeof window !== 'undefined') {
  window.SHARED_CONSTANTS = SHARED_CONSTANTS;
}
