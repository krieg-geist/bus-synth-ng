# Metlink Synth

Wellington's buses, trains and ferries, live, played as music. Every busy bus route hums its own note and plucks one at each stop; trains whine, clack and buzz into stations; ferries glop. Late routes go sour, routes sharing a road bend each other's sound, and a vehicle turning around at the end of its route glitches. Zoom the map in to listen closer.

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
- **Trains**: per train, a motor whine that climbs the scale as it speeds up, crunchy rail-joint clacks at its real speed and a rail roar (both when zoomed in near it), and a low buzz at stations. Zoomed in, trains come forward and pick up a crushed, overdriven edge. The Wairarapa diesel rumbles.
- **Ferries**: they report as AIS-style vessel ids (9 digits starting 512) with no route, and are matched to the ferry route. Each boat is a low hull tone with watery vibrato through a swept band-pass, plus bubbles; docking at a wharf (from the timetable's ferry stops) drops big gloops and smears the boat through the granular bus. The cable car doesn't report, so it's silent.
- **Modulation**: routes sharing road right now cross-modulate; late routes go flat and rough, early ones bright; speed sets brightness and pulse; bunching thickens the drone.
- **Space**: you listen from the map centre, and sound fades towards the edges of the screen, so what's in view is what you hear; zoomed right out you hear the whole region. Zoomed in, a traffic bed (idling rumble, tyre noise) appears and the mix opens up. Once the centre is under about 4 km from the nearest screen edge, every bus on screen gets its own voice (panned by direction, pitched by heading, filter opened by speed, roughened by its own lateness) and the route drones shrink to a background bed.
- **FX**: one reverb every source sends into by distance, and a granular glitch bus (`granular-worklet.js`) that fires when a vehicle turns around at the end of its route or a ferry docks.
- **Two time scales**: where the camera is (level, pan, reverb send, tone) follows within about a third of a second, updated continuously while you pan; the data (bus counts, delays, speed) glides over seconds so it doesn't pulse with the 10 s feed. Voices go to the routes busiest near you.
- **Settings** (the button next to the volume): *Length / Area* picks the pitch map (longer route = lower, or one chord tone per area); *All / Top 8* picks which routes drone; *Scale* picks the scale (just-intoned D pentatonic by default). *Mix* sets the level of buses (drones, per-bus voices, traffic), trains, ferries and arrivals (stop plucks, station buzzes, turnaround notes), each with its reverb.

### Map
Full-screen map on an [OpenFreeMap](https://openfreemap.org) dark basemap (free, no key; drawn by MapLibre inside Leaflet). Buses are bars in their note colour, trains three linked carriages in their line colour that bend along the track. Trails show about the last 7 minutes. An arrival ripples out from its stop: shape = the route's area (circle city, hexagon Hutt, triangle Porirua-Kāpiti, square rail), ragged and red when late, imploding when early. Bad GPS (outside the region, or impossible jumps) is filtered; vehicles that go quiet for a while just continue. Hover a vehicle for its route, note, lateness, speed and load; click it to fly in and follow it (any pan or zoom lets go). The Info tab opens routes, arrivals and late running.

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
