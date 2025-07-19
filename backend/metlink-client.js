const fetch = require('node-fetch').default;

class MetlinkClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.opendata.metlink.org.nz/v1';
    this.headers = {
      'accept': 'application/json',
      'x-api-key': this.apiKey
    };
  }

  async getBuses() {
    const url = `${this.baseUrl}/gtfs-rt/vehiclepositions`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Bus data fetch failed: ${response.status}`);
    }
    
    const data = await response.json();
    return data.entity || [];
  }

  async getStops() {
    const url = `${this.baseUrl}/gtfs/stops`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Stop data fetch failed: ${response.status}`);
    }
    
    return await response.json();
  }

  async getUpdates() {
    const url = `${this.baseUrl}/gtfs-rt/tripupdates`;
    const response = await fetch(url, { headers: this.headers });
    
    if (!response.ok) {
      throw new Error(`Updates fetch failed: ${response.status}`);
    }
    
    const data = await response.json();
    return data.entity || [];
  }
}

module.exports = MetlinkClient;