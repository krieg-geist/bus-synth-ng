class Cache {
  constructor() {
    this.cache = new Map();
  }

  async getOrFetch(key, fetchFn, ttlMs) {
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < ttlMs) {
      return cached.data;
    }

    try {
      const data = await fetchFn();
      this.cache.set(key, {
        data,
        timestamp: Date.now()
      });
      return data;
    } catch (error) {
      console.error(`Cache fetch error for key ${key}:`, error);
      
      // Return stale data if available
      if (cached) {
        console.log(`Returning stale data for key ${key}`);
        return cached.data;
      }
      
      throw error;
    }
  }

  clear() {
    this.cache.clear();
  }

  delete(key) {
    this.cache.delete(key);
  }

  size() {
    return this.cache.size;
  }
}

module.exports = Cache;