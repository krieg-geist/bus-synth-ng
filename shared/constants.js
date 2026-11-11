// Shared constants for Bus Synth application
const SHARED_CONSTANTS = {
  // Network configuration
  NETWORK: {
    DEFAULT_HTTP_PORT: 3000,
    DEFAULT_WS_PORT: 8765,
    WS_RECONNECT_BASE_DELAY: 1000
  },

  // Cache configuration
  CACHE: {
    // TTL for different data types
    BUSES_TTL_MS: 8000,        // 8 seconds
    STOPS_TTL_MS: 86400000,    // 24 hours
    UPDATES_TTL_MS: 8000,      // 8 seconds: arrivals must reach clients inside the 60 s display lag
    
    // Historical cache settings
    HISTORICAL_MAX_AGE_MS: 180000,     // 3 minutes of polls sent to a new client, so routes and trails show at once
    HISTORICAL_CLEANUP_INTERVAL_MS: 30000,  // 30 seconds
    HISTORICAL_MAX_ENTRIES: 50         // Safety limit
  },

  // Polling and timing
  POLLING: {
    BROADCAST_INTERVAL_MS: 10000,  // 10 seconds
    STARTUP_DELAY_MS: 2000         // 2 seconds
  },

  MAP: {
    TIMING: {
      DISPLAY_LAG_MS: 60000,      // 1 minute lag
      MAX_HISTORY_AGE_MS: 480000, // 8 minutes of history (trails)
      STALE_VEHICLE_MS: 300000,  // a vehicle silent this long is removed; shorter gaps just continue
      MAX_TIME_GAP_MS: 30000      // Max gap before clearing trails (30s)
    },
    TRAIL: {
      LENGTH_SEGMENTS: 42 // trail points: ~7 minutes at one report per 10 s
    }
  }
};

// Node.js module export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SHARED_CONSTANTS;
}

// Browser global export
if (typeof window !== 'undefined') {
  window.SHARED_CONSTANTS = SHARED_CONSTANTS;
}
