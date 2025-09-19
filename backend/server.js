require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const MetlinkClient = require('./metlink-client');
const Cache = require('./cache');
const HistoricalDataCache = require('./historical-cache');

// Constants
const CACHE_TTL = {
  BUSES_MS: 8000,        // 8 seconds
  STOPS_MS: 86400000,    // 24 hours
  UPDATES_MS: 30000      // 30 seconds
};

const POLLING = {
  BROADCAST_INTERVAL_MS: 10000,  // 10 seconds
  STARTUP_DELAY_MS: 2000         // 2 seconds
};

const HISTORICAL_CACHE_CONFIG = {
  MAX_AGE_MS: 90000,      // 90 seconds
  CLEANUP_INTERVAL_MS: 30000,  // 30 seconds
  MAX_ENTRIES: 50         // Safety limit
};

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 8765;

// Initialize cache, historical cache, and Metlink client
const cache = new Cache();
const historicalCache = new HistoricalDataCache({
  maxAge: HISTORICAL_CACHE_CONFIG.MAX_AGE_MS,
  cleanupInterval: HISTORICAL_CACHE_CONFIG.CLEANUP_INTERVAL_MS,
  maxEntries: HISTORICAL_CACHE_CONFIG.MAX_ENTRIES
});
const metlink = new MetlinkClient(process.env.METLINK_API_KEY);

if (!process.env.METLINK_API_KEY) {
  console.error('METLINK_API_KEY environment variable is required');
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());

// API Routes (before static files to avoid conflicts)
app.get('/api/buses', async (req, res) => {
  try {
    const data = await cache.getOrFetch('buses', () => metlink.getBuses(), CACHE_TTL.BUSES_MS);
    res.json(data);
  } catch (error) {
    console.error('Bus data error:', error);
    res.status(500).json({ error: 'Failed to fetch bus data' });
  }
});

app.get('/api/stops', async (req, res) => {
  try {
    const data = await cache.getOrFetch('stops', () => metlink.getStops(), CACHE_TTL.STOPS_MS);
    res.json(data);
  } catch (error) {
    console.error('Stop data error:', error);
    res.status(500).json({ error: 'Failed to fetch stop data' });
  }
});

app.get('/api/updates', async (req, res) => {
  try {
    const data = await cache.getOrFetch('updates', () => metlink.getUpdates(), CACHE_TTL.UPDATES_MS);
    res.json(data);
  } catch (error) {
    console.error('Updates data error:', error);
    res.status(500).json({ error: 'Failed to fetch updates data' });
  }
});

// Serve frontend static files with proper MIME types
const isDevelopment = process.env.NODE_ENV === 'development';
const frontendPath = isDevelopment
  ? path.join(__dirname, '../frontend')  // Development: serve from source frontend
  : path.join(__dirname, 'public');      // Production: serve from public directory

console.log(`Bus Synth Server`);
console.log(`Environment: ${isDevelopment ? 'development' : 'production'}`);
console.log(`Frontend path: ${frontendPath}`);
console.log(`HTTP port: ${PORT}`);
console.log(`WebSocket port: ${WS_PORT}`);

// Verify frontend directory exists
if (!fs.existsSync(frontendPath)) {
  console.error(`Frontend directory does not exist: ${frontendPath}`);
  if (isDevelopment) {
    console.error(`For development, run: npm run dev`);
  } else {
    console.error(`For production, ensure frontend files are in: ${frontendPath}`);
  }
  process.exit(1);
}

// Serve frontend static files with proper MIME types
app.use(express.static(frontendPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Serve frontend
app.get('/', (req, res) => {
  const indexPath = isDevelopment
    ? path.join(__dirname, '../frontend/index.html')  // Development
    : path.join(__dirname, 'public/index.html');      // Production
  res.sendFile(indexPath);
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ port: WS_PORT });

console.log(`WebSocket server running on port ${WS_PORT}`);

// Broadcast real-time updates to all connected clients
const broadcastUpdates = async () => {
  try {
    const [buses, updates] = await Promise.all([
      cache.getOrFetch('buses', () => metlink.getBuses(), CACHE_TTL.BUSES_MS),
      cache.getOrFetch('updates', () => metlink.getUpdates(), CACHE_TTL.UPDATES_MS)
    ]);

    // Store in historical cache for new connections
    historicalCache.addEntry(buses, updates);

    // Only broadcast to clients if there are any connected
    if (wss.clients.size > 0) {
      const message = JSON.stringify({
        type: 'bus_update',
        timestamp: Date.now(),
        buses,
        updates,
        isHistorical: false // Mark as real-time data
      });

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });

      console.log(`Broadcasted update to ${wss.clients.size} clients - ${buses.length} buses, ${updates.length} updates`);
    } else {
      console.log(`Cached update (no clients) - ${buses.length} buses, ${updates.length} updates`);
    }

  } catch (error) {
    console.error('Broadcast error:', error);
  }
};

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send historical data immediately for instant startup
  try {
    const historicalData = historicalCache.getHistoricalData();
    if (historicalData.length > 0) {
      // Send each historical entry as a separate message to match real-time format
      historicalData.forEach(entry => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(entry));
        }
      });

      console.log(`Sent ${historicalData.length} historical entries to new client`);

      // Log cache stats for debugging
      const stats = historicalCache.getStats();
      console.log(`Historical cache stats: ${stats.entryCount} entries, ${(stats.timeSpan / 1000).toFixed(1)}s span, ${stats.totalBuses} total buses`);
    } else {
      console.log('No historical data available for new client');
    }
  } catch (error) {
    console.error('Error sending historical data:', error);
  }

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Start broadcasting updates every 10 seconds 
// Optimized based on Wellington bus analysis: 11.1s avg update interval, 95.8% updates within 30s
setInterval(broadcastUpdates, POLLING.BROADCAST_INTERVAL_MS);

// Initialize historical cache with some data on startup
const initializeHistoricalCache = async () => {
  console.log('Initializing historical cache with startup data...');
  try {
    // Fetch initial data and populate cache immediately
    await broadcastUpdates();

    // Wait a bit and fetch again to give some initial history
    setTimeout(async () => {
      await broadcastUpdates();
      console.log('Historical cache initialized with startup data');
    }, POLLING.STARTUP_DELAY_MS);
  } catch (error) {
    console.error('Error initializing historical cache:', error);
  }
};

// Start initialization
initializeHistoricalCache();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  historicalCache.dispose();
  wss.close();
  process.exit(0);
});