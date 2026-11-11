# Metlink Synth

Wellington's buses and trains, live, played as music. Every busy bus route hums its own note and plucks one at each stop; trains whine, clack and buzz into stations. Late routes go sour, routes sharing a road bend each other's sound, and a vehicle turning around at the end of its route glitches. Zoom the map in to listen closer.

## Quick Start

**Windows**: Double-click `start.bat`  
**Mac/Linux**: Run `./start.sh`

Then open http://localhost:3000 and press play

## Manual Setup

1. **Get a Metlink API key** from https://opendata.metlink.org.nz/
2. **Install dependencies**:
   ```bash
   cd backend
   npm install
   ```
3. **Configure API key**:
   ```bash
   cp .env.example .env
   # Edit .env and add your METLINK_API_KEY
   ```
4. **Start the server**:
   ```bash
   npm start
   ```

### Docker

```bash
docker build -t bus-synth-ng .
docker run -d --name bus-synth --env-file backend/.env -p 3000:3000 -p 8765:8765 bus-synth-ng
```
The API key is passed at runtime; `.env` files are never copied into the image.

## How It Works

### Sound (`frontend/js/route-synth.js`, plain Web Audio)
- **Buses** (school buses included): a smooth drone per busy route, louder with more buses, and a soft pluck at each stop arrival. Arrivals play when they happened, in sync with the map's 60 s lag.
- **Trains**: per train, a motor whine that climbs the scale as it speeds up, crunchy rail-joint clacks at its real speed (zoomed in), and a low buzz at stations. The Wairarapa diesel rumbles. Ferries and the cable car don't report realtime positions, so they're silent.
- **Modulation**: routes sharing road right now cross-modulate; late routes go flat and rough, early ones bright; speed sets brightness and pulse; bunching thickens the drone.
- **Space**: you listen from the map centre. The crosshair ring is where sound drops to half; zoomed right out you hear the whole region. Zoomed in, a traffic bed (idling rumble, tyre noise) appears and the mix opens up.
- **FX**: one reverb every source sends into by distance, and a granular glitch bus (`granular-worklet.js`) that only fires when a vehicle turns around at the end of its route.
- **Controls**: *Length / Area* picks the pitch map (longer route = lower, or one chord tone per area, all on D pentatonic); *All / Top 8* picks which routes drone.

### Map
Full-screen map on an [OpenFreeMap](https://openfreemap.org) dark basemap (free, no key; drawn by MapLibre inside Leaflet). Buses are bars in their note colour, trains three linked carriages in their line colour that bend along the track. Trails show about the last 7 minutes. An arrival ripples out from its stop: shape = the route's area (circle city, hexagon Hutt, triangle Porirua-Kāpiti, square rail), ragged and red when late, imploding when early. Bad GPS (outside the region, or impossible jumps) is filtered; vehicles that go quiet for a while just continue. The Info tab opens routes, arrivals and late running.

### Route data
Route names, types and lengths come from `frontend/js/route-meta.js`. Regenerate it when Metlink publishes a new timetable:
```bash
uv run scripts/build_route_meta.py
cd backend && npm test   # self-check
```

## Configuration

Edit `backend/.env`:
```env
METLINK_API_KEY=your_api_key_here
PORT=3000
WS_PORT=8765
```

## Architecture

```
backend/
├── server.js            # Express (frontend, /api/stops, /js/constants.js) + WebSocket broadcast every 10 s
├── metlink-client.js    # Metlink Open Data API
├── cache.js             # TTL cache, serves stale data on API errors
└── historical-cache.js  # Last 90 s of updates, sent to new clients for an instant start

frontend/
├── index.html / style.css
└── js/
    ├── app.js                       # Glue: arrivals, turnarounds, route state, UI
    ├── route-synth.js               # Synth engine (Web Audio)
    ├── granular-worklet.js          # Glitch FX bus (AudioWorklet)
    ├── interpolated-map-manager.js  # Map, vehicle markers, 60 s display lag
    ├── canvas-stops-layer.js        # Stops and arrival/turnaround ripples
    ├── canvas-trails-layer.js       # Vehicle trails
    ├── route-meta.js                # Generated: route names, types, lengths
    ├── utils.js                     # Route names, arrival extraction, spatial placement
    └── websocket.js                 # Live updates, reconnects with backoff

shared/constants.js   # Used by both server and browser
scripts/              # build_route_meta.py (regenerate route-meta.js), check-arrivals.js (self-check: npm test)
```

## Troubleshooting

**No audio?** Check browser permissions and press play. The glitch effect needs https or localhost (AudioWorklet)  
**No buses?** Verify your Metlink API key and internet connection  
**Performance issues?** Sorry lol
