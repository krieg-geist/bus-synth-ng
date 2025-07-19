# Metlink Synth

This app turns live transit data for the Wellington region into a somewhat unpleasant ambient soundscape where each bus route becomes a rhythmic pulse, creating a real-time audio representation of the city's movement.

## Quick Start

**Windows**: Double-click `start.bat`  
**Mac/Linux**: Run `./start.sh`

Then open http://localhost:3000 and click "Start Audio"

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

## How It Works

### Audio Engine
Each bus route generates rhythmic pulses based on:
- **Route ID** → Base frequency (60-300 Hz)
- **Bus count** → Pulse rate (more buses = faster rhythm)
- **Location** → Stereo positioning and pitch modulation
- **Delays** → Temporary rhythm disruption
- **Arrivals** → Blasts of noise when busses arrive at stops, modulated by how late they are

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
├── server.js          # Express server + WebSocket
├── metlink-client.js  # API wrapper with
└── cache.js           # Response caching

frontend/
├── index.html         # Main interface
├── style.css          # Styling
└── js/
    ├── app.js                      # Application controller
    ├── route-pulse-audio.js        # Audio synthesis
    ├── interpolated-map-manager.js # Map visualization
    ├── canvas-stops-layer.js       # Stop rendering
    └── websocket.js                # Real-time updates
```

## Troubleshooting

**No audio?** Check browser permissions and click "Start Audio"  
**No buses?** Verify your Metlink API key and internet connection  
**Performance issues?** Sorry lol
