class HistoricalDataCache {
  constructor(options = {}) {
    this.maxAge = options.maxAge || 90000; // Keep 90 seconds of data (1.5 minutes)
    this.cleanupInterval = options.cleanupInterval || 30000; // Cleanup every 30 seconds
    this.maxEntries = options.maxEntries || 50; // Safety limit on entries
    
    // Array of timestamped bus update entries
    this.entries = [];
    
    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
    
    console.log(`Historical cache initialized: ${this.maxAge}ms retention, cleanup every ${this.cleanupInterval}ms`);
  }

  /**
   * Add a new bus update to the historical cache
   * @param {Object} buses - Bus data array
   * @param {Object} updates - Updates data array  
   */
  addEntry(buses, updates) {
    const timestamp = Date.now();
    
    const entry = {
      timestamp,
      buses: Array.isArray(buses) ? buses : [],
      updates: Array.isArray(updates) ? updates : []
    };
    
    this.entries.push(entry);
    
    // Immediate cleanup if we exceed max entries (safety measure)
    if (this.entries.length > this.maxEntries) {
      this.cleanup();
    }
    
    console.log(`Added historical entry: ${entry.buses.length} buses, ${entry.updates.length} updates (total: ${this.entries.length} entries)`);
  }

  /**
   * Get all historical entries for a new client connection
   * @returns {Array} Array of historical bus update entries
   */
  getHistoricalData() {
    // Clean up before returning to ensure fresh data
    this.cleanup();
    
    return this.entries.map(entry => ({
      type: 'bus_update',
      timestamp: entry.timestamp,
      buses: entry.buses,
      updates: entry.updates,
      isHistorical: true // Flag to help frontend identify historical vs real-time data
    }));
  }

  /**
   * Remove entries older than maxAge
   */
  cleanup() {
    const cutoffTime = Date.now() - this.maxAge;
    const initialCount = this.entries.length;
    
    this.entries = this.entries.filter(entry => entry.timestamp >= cutoffTime);
    
    const removedCount = initialCount - this.entries.length;
    if (removedCount > 0) {
      console.log(`Historical cache cleanup: removed ${removedCount} old entries, ${this.entries.length} remaining`);
    }
  }

  /**
   * Get current cache statistics
   */
  getStats() {
    if (this.entries.length === 0) {
      return { entryCount: 0, oldestAge: 0, newestAge: 0, totalBuses: 0 };
    }

    const now = Date.now();
    const oldest = Math.min(...this.entries.map(e => e.timestamp));
    const newest = Math.max(...this.entries.map(e => e.timestamp));
    const totalBuses = this.entries.reduce((sum, e) => sum + e.buses.length, 0);

    return {
      entryCount: this.entries.length,
      oldestAge: now - oldest,
      newestAge: now - newest,
      totalBuses,
      timeSpan: newest - oldest
    };
  }

  /**
   * Clear all historical data
   */
  clear() {
    this.entries = [];
    console.log('Historical cache cleared');
  }

  /**
   * Clean shutdown
   */
  dispose() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
    console.log('Historical cache disposed');
  }
}

module.exports = HistoricalDataCache;