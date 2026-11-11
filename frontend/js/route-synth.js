// City synth on plain Web Audio. One timbre per vehicle type that reports in the feed:
//   bus (incl. school buses) - a smooth drone per busy route + soft plucks at each stop. Routes that share
//                              road right now gently cross-modulate; speed makes a route pulse, stopped ones sit still.
//   rail                     - per train: traction-motor whine that steps up the scale as it speeds up, crunchy
//                              rail-joint clacks at real speed, a low electric buzz at stations; Wairarapa is a diesel rumble.
//   ferry                    - per boat: a low hull tone with watery vibrato through a swept band-pass, plus bubbles;
//                              docking at a wharf drops big gloops and smears the boat through the granular bus.
// Close-up mode (under ~4 km from the screen centre to its nearest edge): every bus on screen gets its own voice,
// panned by its direction from the crosshair, pitched by its heading, filtered by its speed, roughened by its own lateness; the route drones
// shrink to a calmer background bed.
// Plus a traffic noise bed (only when zoomed in), a reverb every source sends into by distance, and a glitch bus
// that stays silent until a vehicle turns around at the end of its route or a ferry docks: that sound is then
// replayed for a few seconds as reversed, stuttering grains (size from city speed, feedback from city lateness).
// Sound is placed relative to the map view (see Utils.spatial). The cable car never reports, so it is silent.
// Two time scales: where the camera is (level, pan, reverb send, tone) follows within SPACE seconds; the data
// (bus counts, delay, speed) changes every 10-20 s and glides over seconds so it doesn't pulse with the feed.
// Switches: pitch 'length' (longer route = lower) | 'family' (route-number family = chord tone); scale (see SCALES);
//           drone 'emergent' (routes with 2+ buses, busiest near you, up to MAX_DRONES) | 'top8' (8 busiest; plucks become bells).

const ROOT_HZ = 73.42; // D2
// Scales as frequency ratios within an octave above D. Pentatonic (the default) keeps any mix consonant.
const SCALES = {
  pentatonic: [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3], // just major pentatonic
  minor: [1, 6 / 5, 4 / 3, 3 / 2, 9 / 5], // just minor pentatonic
  dorian: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3, 9 / 5],
  lydian: [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 5 / 3, 15 / 8],
  hirajoshi: [1, 9 / 8, 6 / 5, 3 / 2, 8 / 5],
  harmonic: [1, 9 / 8, 5 / 4, 11 / 8, 3 / 2, 13 / 8, 7 / 4, 15 / 8], // partials 8 to 15
  wholetone: [0, 2, 4, 6, 8, 10].map(st => 2 ** (st / 12)),
  chromatic: Array.from({ length: 12 }, (_, st) => 2 ** (st / 12)) // anything goes
};
let SCALE = SCALES.pentatonic; // the current scale; set through RouteSynth.setModes({ scale })
const MAX_NOTES = 48; // cap on overlapping notes
const TOP_N = 8;
const SPACE = 0.35; // seconds for camera-driven changes
const MAX_DRONES = 32; // route drones when zoomed out (with these budgets a peak-hour offline render runs ~2.3x real time)
const MIX_TRIM = { bus: 1, train: 0.36, ferry: 1, arrival: 1 }; // fader 100% = this gain; trains = the old 60% (-9 dB)
const BED_VOICES = 8; // route drones kept as background in close-up mode
const NEAR_VOICES = 36; // per-bus voices in close-up mode; past this the furthest are dropped
const NOTE_GAIN = 0.12;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const META_BY_NAME = Object.fromEntries(Object.values(window.ROUTE_META || {}).map(m => [m.name, m]));
const metaFor = route => META_BY_NAME[route] || { name: route, type: 3, km: null };
const scaleStep = i => ROOT_HZ * 2 ** Math.floor(i / SCALE.length) * SCALE[((i % SCALE.length) + SCALE.length) % SCALE.length];
const clamp01 = x => Math.max(0, Math.min(1, x));
// One distance curve for every source, so zooming treats buses, trains and notes alike
const presence = pos => 0.35 + 0.65 * pos.near;    // direct level: far is -9 dB, so zooming focuses rather than mutes
const wetness = pos => 0.25 + 0.9 * (1 - pos.near); // reverb send: distant = wetter
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) >>> 0;

// Ramp a param to a target. Ramps end, so the param drops back to Chrome's cheap static path afterwards;
// tiny changes are skipped, which is most updates since the inputs only move every 10-20 s.
function glide(param, target, secs, now, tolerance) {
  if (param._target != null && Math.abs(target - param._target) <= tolerance) return;
  param._target = target;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + secs);
}

// Control rate: one value per 128-sample block (2.7 ms) instead of per sample. For params that glide over tenths of a
// second or more it's inaudible, and a filter then recomputes its coefficients once a block instead of every sample.
// Left at audio rate: anything with an audio-rate input (FM) or a fast envelope (notes), and gains with an LFO input.
const kRate = (...params) => params.forEach(p => { p.automationRate = 'k-rate'; });

function family(m) {
  const n = parseInt(m.name, 10);
  if (m.type === 2) return 'rail';
  if (m.type !== 3 || /^N\d/.test(m.name)) return 'special';
  if (/^(HV|ME)/.test(m.name) || (n >= 100 && n < 200) || (n >= 80 && n < 90)) return 'hutt';
  if (/^(KP|JV)/.test(m.name) || n >= 200) return 'north';
  return 'city';
}
// Chord tones (scale degrees) and base octave per family: together they spell D6/9
const FAMILY = {
  rail: { deg: [0], oct: 1 }, city: { deg: [0, 3], oct: 2 }, hutt: { deg: [2], oct: 2 },
  north: { deg: [1, 4], oct: 2 }, special: { deg: [4], oct: 3 }
};

// Which step of the current scale a route sits on (counting up from D2). Length: longer route = lower, spread over
// about 4.2 octaves. Family: each area's chord tones (written for the 5-note scale, scaled to the current one).
function routeStep(route, mode) {
  const m = metaFor(route);
  const km = m.km ?? 15;
  const n = SCALE.length;
  if (mode === 'family') {
    const f = FAMILY[family(m)];
    const oct = f.oct + (km < 8 ? 1 : km > 30 ? -1 : 0);
    return oct * n + Math.round(f.deg[hash(route) % f.deg.length] * n / 5);
  }
  const p = Math.log(Math.max(2, Math.min(100, km)) / 2) / Math.log(50); // 2 km -> 0, 100 km -> 1
  return Math.round((1 - p) * 4.2 * n);
}

function routePitch(route, mode) {
  return scaleStep(routeStep(route, mode));
}

function noiseBuffer(ctx, secs) {
  const b = ctx.createBuffer(2, ctx.sampleRate * secs, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return b;
}

function reverbBuffer(ctx, secs) { // decaying stereo noise that darkens as it decays (highs die first, like a room)
  const b = ctx.createBuffer(2, ctx.sampleRate * secs, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let y = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / d.length;
      y += (0.5 * Math.exp(-4 * t) + 0.02) * (Math.random() * 2 - 1 - y); // one-pole lowpass, ~4 kHz down to ~150 Hz
      d[i] = y * Math.exp(-6.9 * t);
    }
  }
  return b;
}

function clackBuffer(ctx) { // wheel over a rail joint: thump, thud and metallic ring, overdriven and bit-reduced
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(1, Math.floor(sr * 0.11), sr);
  const d = b.getChannelData(0);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    y += 0.2 * (Math.random() * 2 - 1 - y); // lowpassed noise: a thud, not a hiss
    const ring = Math.sin(2 * Math.PI * 1250 * t) + 0.6 * Math.sin(2 * Math.PI * 1940 * t) + 0.7 * Math.sin(2 * Math.PI * 610 * t);
    const thump = Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t / 0.03);
    const raw = y * Math.exp(-t / 0.008) * 1.5 + ring * Math.exp(-t / 0.025) * 0.3 + thump * 0.6;
    d[i] = Math.round(Math.tanh(4 * raw) * 7) / 7 * 0.7; // crunch: drive into tanh, then ~4-bit steps (baked in, free at runtime)
  }
  return b;
}

// Gentle master saturation: unity gain for quiet signals, rounding off peaks (see the zoom tone in update)
const SOFT_CURVE = Float32Array.from({ length: 2048 }, (_, i) => Math.tanh(1.2 * (i / 1023.5 - 1)) / 1.2);
// Bitcrusher curves: amplitude quantised to 2^(bits-1) steps per polarity, cached per bit depth
const CRUSH_CURVES = {};
const crushCurve = bits => CRUSH_CURVES[bits] ??= Float32Array.from({ length: 1024 }, (_, i) => {
  const q = 2 ** (bits - 1);
  return Math.round((i / 511.5 - 1) * q) / q;
});
const BUZZ_CURVE = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(5 * (i / 511.5 - 1))); // hard-ish clip

class RouteSynth {
  constructor({ place }) {
    this.place = place; // (lat, lon) -> { pan, near, local }
    this.modes = { pitch: 'length', drone: 'emergent', scale: 'pentatonic' };
    this.voices = new Map(); // bus route -> drone voice
    this.trains = new Map(); // vehicle id -> train voice
    this.ferries = new Map(); // vehicle id -> ferry voice
    this.near = new Map(); // vehicle id -> close-up bus voice
    this.closeUp = 0; // 0..1, how far into close-up mode
    this.levels = { bus: 1, train: 1, ferry: 1, arrival: 1 }; // user mix from the settings sliders, linear gain
    this.states = new Map(); // route -> latest state from app
    this.ctx = null;
    this.activeNotes = 0;
  }

  get running() {
    return !!this.ctx;
  }

  async start(volume) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    const node = (Type, opts) => new Type(ctx, opts);
    this.master = node(GainNode, { gain: volume });
    this.master.connect(ctx.destination);
    const limiter = node(DynamicsCompressorNode, { threshold: -6, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
    limiter.connect(this.master);
    // Master tone follows zoom (see update): zoomed out is softer and distant, zoomed in opens up with a little grit
    this.mixBus = node(GainNode);
    this.tone = node(BiquadFilterNode, { type: 'lowpass', frequency: 5000, Q: 0.5 });
    kRate(this.tone.frequency);
    this.drive = node(GainNode);
    this.makeup = node(GainNode);
    this.mixBus.connect(this.tone).connect(this.drive).connect(node(WaveShaperNode, { curve: SOFT_CURVE })).connect(this.makeup).connect(limiter);

    // FX bus 1: one reverb, fed by every source's own send
    this.reverbIn = node(GainNode);
    this.reverbIn.connect(node(ConvolverNode, { buffer: reverbBuffer(ctx, 4) })).connect(node(GainNode, { gain: 0.8 })).connect(limiter);

    // FX bus 2: granular glitch. AudioWorklet only exists on https/localhost; without it the bus is silent.
    this.glitchIn = node(GainNode);
    this.granular = null;
    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule('js/granular-worklet.js');
      this.granular = new AudioWorkletNode(ctx, 'granular', { outputChannelCount: [2] });
      const glitchOut = node(GainNode, { gain: 0.7 });
      this.glitchIn.connect(this.granular).connect(glitchOut);
      glitchOut.connect(this.mixBus);
      glitchOut.connect(node(GainNode, { gain: 0.3 })).connect(this.reverbIn);
    }

    // User mix (settings sliders): a dry and a reverb stage per sound type, so a fader takes its reverb with it
    this.mix = Object.fromEntries(Object.entries(this.levels).map(([type, g]) => {
      const dry = node(GainNode, { gain: g * MIX_TRIM[type] }), wet = node(GainNode, { gain: g * MIX_TRIM[type] });
      dry.connect(this.mixBus);
      wet.connect(this.reverbIn);
      return [type, { dry, wet }];
    }));

    this.droneBus = node(GainNode, { gain: 0.3 });
    this.droneBus.connect(this.mix.bus.dry);
    this.droneSend = node(GainNode, { gain: 0.3 });
    this.droneSend.connect(this.mix.bus.wet);
    this.noteBus = node(GainNode);
    this.noteBus.connect(this.mix.arrival.dry);
    this.trainBus = node(GainNode, { gain: 0.8 });
    this.trainBus.connect(this.mix.train.dry);
    // Train grit: a parallel drive -> clip -> 5-bit crush, highpassed so the low end stays clean (see updateTrains)
    this.trainGrit = node(GainNode, { gain: 0 });
    this.trainBus.connect(this.trainGrit).connect(node(WaveShaperNode, { curve: BUZZ_CURVE }))
      .connect(node(WaveShaperNode, { curve: crushCurve(5) })).connect(node(BiquadFilterNode, { type: 'highpass', frequency: 250 }))
      .connect(node(GainNode, { gain: 0.18 })).connect(this.mix.train.dry);
    this.ferryBus = node(GainNode, { gain: 0.5 });
    this.ferryBus.connect(this.mix.ferry.dry);
    this.nearBus = node(GainNode, { gain: 0.1 });
    this.nearBus.connect(this.mix.bus.dry);
    // Shared LFOs, one per speed band, instead of one oscillator per voice: slow sway for the route drones,
    // faster tremolo for the close-up voices
    this.swayBank = [0.12, 0.35, 0.7, 1.2].map(frequency => {
      const o = node(OscillatorNode, { frequency });
      o.start();
      return o;
    });
    this.tremolo = [0.4, 0.9, 1.8, 3.2].map(frequency => {
      const o = node(OscillatorNode, { frequency });
      o.start();
      return o;
    });
    this.clack = clackBuffer(ctx);
    this.glitchUntil = 0;

    // Traffic bed: idling engines rumble with a diesel throb; moving traffic is a band of tyre noise
    this.noise = noiseBuffer(ctx, 4); // shared by the traffic bed and the trains' rail roar
    const noise = node(AudioBufferSourceNode, { buffer: this.noise, loop: true });
    const throbOsc = node(OscillatorNode, { frequency: 10.5 });
    const throb = node(GainNode, { gain: 0.5 });
    throbOsc.connect(node(GainNode, { gain: 0.5 })).connect(throb.gain);
    const rumble = node(GainNode, { gain: 0 });
    const whooshBP = node(BiquadFilterNode, { type: 'bandpass', frequency: 400, Q: 1.2 });
    const whoosh = node(GainNode, { gain: 0 });
    const trafficPan = node(StereoPannerNode);
    noise.connect(node(BiquadFilterNode, { type: 'lowpass', frequency: 120, Q: 1 })).connect(throb).connect(rumble).connect(trafficPan);
    noise.connect(whooshBP).connect(whoosh).connect(trafficPan);
    trafficPan.connect(this.mix.bus.dry);
    trafficPan.connect(node(GainNode, { gain: 0.4 })).connect(this.mix.bus.wet);
    noise.start();
    throbOsc.start();
    this.traffic = { rumble, whoosh, whooshBP, pan: trafficPan };

    // Rail roar noise, shared by all trains instead of a noise source and filter each: three decorrelated loops for
    // the electric units (a train takes one, so the few near you rarely share) and one for the diesel
    const roarLoop = cutoff => {
      const src = node(AudioBufferSourceNode, { buffer: this.noise, loop: true });
      const lp = node(BiquadFilterNode, { type: 'lowpass', frequency: cutoff, Q: 0.8 });
      src.connect(lp);
      src.start(0, Math.random() * 3);
      return lp;
    };
    this.roars = { electric: [340, 340, 340].map(roarLoop), diesel: [roarLoop(220)] };

    this.activeNotes = 0;
    this.ctx = ctx;
  }

  stop() {
    const ctx = this.ctx;
    this.ctx = null;
    [...this.voices.values(), ...this.trains.values(), ...this.ferries.values(), ...this.near.values()].forEach(v => clearTimeout(v.fadeTimer));
    this.voices.clear();
    this.trains.clear();
    this.ferries.clear();
    this.near.clear();
    ctx?.close(); // frees every node at once
  }

  setVolume(v) {
    if (this.ctx) glide(this.master.gain, v, 0.05, this.ctx.currentTime, 0);
  }

  // type: 'bus' | 'train' | 'ferry' | 'arrival'; g: linear gain (1 = as designed)
  setLevel(type, g) {
    this.levels[type] = g;
    const m = this.ctx && this.mix[type];
    if (m) [m.dry, m.wet].forEach(stage => glide(stage.gain, g * MIX_TRIM[type], 0.05, this.ctx.currentTime, 0));
  }

  setModes(modes) {
    Object.assign(this.modes, modes);
    SCALE = SCALES[this.modes.scale] || SCALES.pentatonic;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.voices.forEach((v, route) => { // glide drones to their new pitch
      v.freq = routePitch(route, this.modes.pitch) / 2;
      v.oscs.forEach(o => glide(o.frequency, v.freq, 3, now, 0));
    });
  }

  noteName(route) {
    const n = Math.round(12 * Math.log2(routePitch(route, this.modes.pitch) / 440)) + 69;
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  }

  holdFor(n) {
    const level = Math.min(1, Math.log2(Math.max(1, n)) / 4); // 2 buses .25, 4 .5, 16 1
    return this.modes.drone === 'top8' ? 0.35 + 0.65 * level : level;
  }

  // frame: { routes: Map route -> { n, delay, kmh, bunched, lat, lon, partner, contact },
  //          trains: [{ id, route, lat, lon, kmh }], traffic: { idle, moving, speed, pan },
  //          city: { total, meanDelay, earlyFrac, kmh, bunchedFrac, arrivalsPerMin } }
  update(frame) {
    this.states = frame.routes;
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    this.closeUp = frame.closeUp ?? 0;
    this.updateDrones(frame.routes, now);
    this.updateTrains(frame.trains, now, 1 - (frame.zoom ?? 1));
    this.updateFerries(frame.ferries || [], now);
    this.updateNearby(frame.nearby || [], now);

    // Zoom colours the whole mix, subtly: 5 kHz and clean zoomed out, ~16 kHz with a touch of drive at street level
    const close = 1 - (frame.zoom ?? 1);
    const drive = 0.9 + 0.5 * close;
    glide(this.tone.frequency, 5000 * 3.2 ** close, SPACE, now, 50);
    glide(this.drive.gain, drive, SPACE, now, 0.01);
    glide(this.makeup.gain, 1 / drive, SPACE, now, 0.01);

    // Plucks: zoomed in, most arrivals are far away and quiet, so lift the note bus
    // by how present routes are on average. The level stays put; the balance shifts towards what's near.
    let sum = 0, count = 0;
    frame.routes.forEach(s => { sum += presence(this.place(s.lat, s.lon)); count++; });
    glide(this.noteBus.gain, Math.min(2.5, count ? count / sum : 1), SPACE, now, 0.05);

    const tr = frame.traffic;
    glide(this.traffic.rumble.gain, 3.5 * (1 - Math.exp(-tr.idle / 4)), 1, now, 0.01);
    glide(this.traffic.whoosh.gain, 0.25 * (1 - Math.exp(-tr.moving / 4)), 1, now, 0.005);
    glide(this.traffic.whooshBP.frequency, 200 + 18 * tr.speed, 4, now, 10);
    glide(this.traffic.pan.pan, tr.pan, SPACE, now, 0.02);

    // City state shapes the glitch bursts: a jammed city stretches grains, a late one feeds back and smears.
    // Density, reverse and stutter belong to the bursts themselves (see glitchBurst).
    const c = frame.city;
    this.cityEarly = c.earlyFrac;
    const g = this.granular?.parameters;
    if (g) {
      glide(g.get('size'), 0.05 + 0.3 * (1 - clamp01(c.kmh / 30)), 6, now, 0.01);
      glide(g.get('scatter'), clamp01(0.15 + c.bunchedFrac * 3), 6, now, 0.02);
      glide(g.get('feedback'), 0.15 + 0.6 * clamp01(c.meanDelay / 400), 10, now, 0.01);
    }
    glide(this.reverbIn.gain, 0.7 + 0.6 * (1 - clamp01(c.total / 300)), 10, now, 0.01); // emptier city = bigger room
  }

  updateDrones(routes, now) {
    // Voices go to the routes that are busy near you (drone level x presence). Routes already sounding get a 25%
    // head start, so panning doesn't make voices flicker in and out at the edge.
    const scored = [];
    routes.forEach((s, route) => {
      const type = metaFor(route).type;
      if (s.n < 2 || type === 2 || type === 4) return;
      const pos = this.place(s.lat, s.lon);
      const live = this.voices.get(route);
      scored.push({ route, s, pos, score: this.holdFor(s.n) * presence(pos) * (live && !live.fadeTimer ? 1.25 : 1) });
    });
    scored.sort((a, b) => b.score - a.score);
    // Close up, most of the budget goes to per-bus voices and the route drones shrink to a background bed
    const count = this.modes.drone === 'top8' ? TOP_N : Math.round(MAX_DRONES - (MAX_DRONES - BED_VOICES) * this.closeUp);
    const wanted = new Map(scored.slice(0, count).map(d => [d.route, d]));
    const calm = 1 - 0.75 * this.closeUp; // close up, the roughness moves from the route drones to the per-bus voices

    this.voices.forEach((v, route) => {
      if (wanted.has(route) || v.fadeTimer) return;
      glide(v.out.gain, 0, 1.5, now, 0);
      v.fadeTimer = setTimeout(() => {
        v.oscs.forEach(o => o.stop());
        if (v.band != null) this.swayBank[v.band].disconnect(v.lfoDepth); // or the shared LFO keeps it alive
        v.space.disconnect();
        this.voices.delete(route);
      }, 2000);
    });

    let energy = 0;
    wanted.forEach(({ s, pos }, route) => {
      let v = this.voices.get(route);
      const fresh = !v || !!v.fadeTimer;
      if (!v) this.voices.set(route, v = this.makeVoice(route));
      if (v.fadeTimer) { clearTimeout(v.fadeTimer); v.fadeTimer = null; }
      // Data stage (out): bus count sets the hold; swells and tremolo ride on it. Camera stage (space): presence.
      v.hold = this.holdFor(s.n);
      glide(v.out.gain, v.hold, fresh ? 1 : 4, now, 0.01);
      const p = presence(pos);
      glide(v.space.gain, p, SPACE, now, 0.01);
      glide(v.pan.pan, pos.pan * 0.8, SPACE, now, 0.02);
      glide(v.reverbSend.gain, wetness(pos), SPACE, now, 0.02);
      energy += (v.hold * p) ** 2;

      // Late routes go flat and beat against themselves; early ones go slightly sharp; bunching thickens.
      // 8 s glides: delay and speed step on the feed's clock, this keeps them from pulsing with it.
      const late = clamp01((s.delay - 60) / 540);
      const early = clamp01((-s.delay - 60) / 240);
      const centre = (-30 * late + 12 * early) * calm;
      const spread = 4 + (24 * late + 10 * Math.min(s.bunched, 3)) * calm;
      glide(v.oscs[0].detune, centre - spread / 2, 8, now, 0.5);
      glide(v.oscs[1].detune, centre + spread / 2, 8, now, 0.5);

      // Moving routes are brighter and pulse (rate follows speed); jammed routes go dark and still
      const move = clamp01(s.kmh / 40);
      const cutoff = v.freq * (1.5 + 4 * move);
      glide(v.filter.frequency, cutoff, 8, now, cutoff * 0.03);
      const band = Math.min(3, Math.floor(move * 4));
      if (v.band !== band) {
        if (v.band != null) this.swayBank[v.band].disconnect(v.lfoDepth);
        this.swayBank[band].connect(v.lfoDepth);
        v.band = band;
      }
      glide(v.lfoDepth.gain, v.hold * 0.35 * move, 4, now, 0.005);
    });

    // Routes sharing road right now cross-modulate: each drone's FM comes from its busiest corridor partner.
    // Kept gentle (index <= 0.5) so bus drones stay smooth. The delay makes mutual pairs a legal cycle.
    wanted.forEach(({ s }, route) => {
      const v = this.voices.get(route);
      const p = (s.partner && this.voices.get(s.partner)) || null;
      if (p !== v.fmSrc) {
        try { v.fmSrc?.oscs[0].disconnect(v.fmIn); } catch { /* source already gone */ }
        p?.oscs[0].connect(v.fmIn);
        if (p && !v.fmSrc) v.fmDelay.connect(v.oscs[0].frequency);
        if (!p && v.fmSrc) v.fmDelay.disconnect();
        v.fmSrc = p;
      }
      glide(v.fmIn.gain, p ? v.freq * Math.min(0.5, 0.1 * s.contact) * calm : 0, 2, now, 0.5);
    });

    // Normalise by total presence, not voice count: zooming in shifts the balance to nearby routes
    // instead of making the whole drone quieter. Follows the camera.
    const norm = (0.18 / Math.sqrt(Math.max(0.25, energy))) * (1 - 0.45 * this.closeUp); // close up, the bed sits ~5 dB back
    glide(this.droneBus.gain, norm, SPACE, now, 0.005);
    glide(this.droneSend.gain, norm, SPACE, now, 0.005);
  }

  makeVoice(route) {
    const ctx = this.ctx;
    const node = (Type, opts) => new Type(ctx, opts);
    const freq = routePitch(route, this.modes.pitch) / 2;
    const space = node(GainNode, { gain: 0 }); // camera stage: presence
    space.connect(this.droneBus);
    const reverbSend = node(GainNode, { gain: 0 });
    space.connect(reverbSend).connect(this.droneSend);
    const out = node(GainNode, { gain: 0 }); // data stage: hold, swells, tremolo
    out.connect(space);
    const glitchSend = node(GainNode, { gain: 0 });
    out.connect(glitchSend).connect(this.glitchIn);
    const pan = node(StereoPannerNode);
    pan.connect(out);
    const filter = node(BiquadFilterNode, { type: 'lowpass', frequency: freq * 3, Q: 0.7 });
    filter.connect(pan);
    // Corridor FM goes into one oscillator, and only while there's a partner (see updateDrones): an audio-rate
    // frequency input is the expensive path, so idle voices don't pay for it
    const fmIn = node(GainNode, { gain: 0 });
    const fmDelay = node(DelayNode, { delayTime: 0.003 });
    fmIn.connect(fmDelay);
    const oscs = [0, 1].map(() => {
      const o = node(OscillatorNode, { type: 'sawtooth', frequency: freq });
      o.connect(filter);
      o.start();
      return o;
    });
    const lfoDepth = node(GainNode, { gain: 0 }); // fed by a shared sway LFO (see updateDrones)
    lfoDepth.connect(out.gain);
    kRate(space.gain, reverbSend.gain, glitchSend.gain, pan.pan, filter.frequency, filter.Q, oscs[1].frequency, oscs[0].detune, oscs[1].detune);
    return { out, space, pan, filter, oscs, fmIn, fmDelay, fmSrc: null, lfoDepth, band: null, reverbSend, glitchSend, freq, hold: 0, fadeTimer: null };
  }

  // zoomedIn: 0 at region view .. 1 at street level; trains come forward and get rougher as you zoom in
  updateTrains(trains, now, zoomedIn = 0) {
    const seen = new Set();
    for (const t of trains) {
      seen.add(t.id);
      let v = this.trains.get(t.id);
      if (!v) this.trains.set(t.id, v = this.makeTrain(t));
      if (v.fadeTimer) { clearTimeout(v.fadeTimer); v.fadeTimer = null; }
      const pos = this.place(t.lat, t.lon);
      const kmh = t.kmh ?? 0;
      const root = routePitch(t.route, this.modes.pitch);
      glide(v.out.gain, 0.35 + 0.65 * clamp01(kmh / 80), 3, now, 0.01);
      glide(v.space.gain, presence(pos), SPACE, now, 0.01);
      glide(v.pan.pan, pos.pan, SPACE, now, 0.02);
      glide(v.reverbSend.gain, wetness(pos), SPACE, now, 0.02);
      if (v.diesel) {
        glide(v.body.frequency, (root / 2) * (1 + kmh / 60), 3, now, 0.5); // engine revs with speed
      } else {
        glide(v.body.frequency, root, 1, now, 0.5);
        // Traction-motor whine climbs one scale step per ~12 km/h, like the "do-re-mi" inverter trains
        const wf = root * 4 * scaleStep(Math.min(9, Math.floor(kmh / 12))) / ROOT_HZ;
        glide(v.whine.frequency, wf, 0.4, now, 0.5);
        glide(v.whineBP.frequency, wf * 2, 0.4, now, 1);
        glide(v.whineGain.gain, (0.18 + 0.22 * Math.min(1, pos.local * 2)) * clamp01(kmh / 15), 1.5, now, 0.005);
      }
      // Rail joints: a pair of clacks (one per bogie) every ~18 m, so the rhythm is the train's real speed.
      // Only when zoomed in near the train: zoomed out, every train clacking at once was a wall of noise.
      const close = Math.min(1, pos.local * 2);
      // Rail roar: low rumbling noise under a moving train, only near you (zoomed out it would just be hiss)
      glide(v.roar.gain, 0.9 * clamp01(kmh / 60) * close, 1, now, 0.005);
      if (kmh > 8 && close > 0.04) {
        const mps = kmh / 3.6;
        let at = Math.max(v.nextClack, now + 0.05);
        while (at < now + 2.2) {
          this.clackAt(v, at, 1.0 * close);
          this.clackAt(v, at + 2.6 / mps, 0.75 * close);
          at += (18.3 / mps) * (0.93 + 0.14 * Math.random());
        }
        v.nextClack = at;
      }
    }
    // Normalise trains by total presence like the drones, and keep them under the bus bed:
    // unnormalised, 15 whining trains were 10 dB louder than every bus drone together
    let energy = 0;
    this.trains.forEach(v => { if (!v.fadeTimer) energy += ((v.out.gain._target ?? 0) * (v.space.gain._target ?? 0)) ** 2; });
    // Zoomed out trains sit ~2 dB under where they were; zoomed in they come up to the same level as before (~+9 dB)
    glide(this.trainBus.gain, (0.12 / Math.sqrt(Math.max(0.25, energy))) * (1 + 1.875 * zoomedIn), SPACE, now, 0.005);
    glide(this.trainGrit.gain, 6 * zoomedIn * zoomedIn, SPACE, now, 0.01); // parallel crunch, only zoomed in

    this.trains.forEach((v, id) => {
      if (seen.has(id) || v.fadeTimer) return;
      glide(v.space.gain, 0, 1.5, now, 0);
      v.fadeTimer = setTimeout(() => {
        v.body.stop();
        v.whine?.stop();
        v.roarSrc.disconnect(v.roar); // or the shared noise keeps the voice alive
        v.space.disconnect();
        this.trains.delete(id);
      }, 2000);
    });
  }

  makeTrain(t) {
    const ctx = this.ctx;
    const node = (Type, opts) => new Type(ctx, opts);
    const diesel = t.route === 'WRL'; // the only diesel line; the rest are electric units
    const space = node(GainNode, { gain: 0 }); // camera stage
    space.connect(this.trainBus);
    const reverbSend = node(GainNode, { gain: 0 });
    space.connect(reverbSend).connect(this.mix.train.wet);
    const out = node(GainNode, { gain: 0 }); // data stage: louder when moving
    out.connect(space);
    const pan = node(StereoPannerNode);
    pan.connect(out);
    // Body: electric units hum, the diesel throbs through a lowpass
    const body = node(OscillatorNode, { type: diesel ? 'square' : 'sine', frequency: 60 });
    body.connect(node(BiquadFilterNode, { type: 'lowpass', frequency: diesel ? 180 : 600 }))
      .connect(node(GainNode, { gain: diesel ? 0.5 : 0.35 })).connect(pan);
    body.start();
    // Rail roar: a shared low noise band (see start), level set per update by speed and closeness
    const roar = node(GainNode, { gain: 0 });
    const roarSrc = this.roars[diesel ? 'diesel' : 'electric'][this.trains.size % (diesel ? 1 : 3)];
    roarSrc.connect(roar).connect(pan);
    const v = { out, space, pan, body, reverbSend, roar, roarSrc, diesel, nextClack: 0, fadeTimer: null };
    if (!diesel) {
      v.whine = node(OscillatorNode, { type: 'sawtooth', frequency: 300 });
      v.whineBP = node(BiquadFilterNode, { type: 'bandpass', frequency: 600, Q: 12 });
      v.whineGain = node(GainNode, { gain: 0 });
      v.whine.connect(v.whineBP).connect(v.whineGain).connect(pan);
      v.whine.start();
      kRate(v.whine.frequency, v.whineBP.frequency, v.whineGain.gain);
    }
    kRate(out.gain, space.gain, pan.pan, reverbSend.gain, body.frequency, roar.gain);
    return v;
  }

  updateFerries(ferries, now) {
    const seen = new Set();
    for (const f of ferries) {
      seen.add(f.id);
      let v = this.ferries.get(f.id);
      if (!v) this.ferries.set(f.id, v = this.makeFerry(f));
      if (v.fadeTimer) { clearTimeout(v.fadeTimer); v.fadeTimer = null; }
      const pos = this.place(f.lat, f.lon);
      const move = clamp01((f.kmh ?? 0) / 25);
      glide(v.space.gain, presence(pos), SPACE, now, 0.01);
      glide(v.pan.pan, pos.pan, SPACE, now, 0.02);
      glide(v.reverbSend.gain, 0.3 + wetness(pos), SPACE, now, 0.02); // boats are wetter than buses
      glide(v.lfo.frequency, 0.12 + 0.5 * move, 4, now, 0.01); // slow sway docked, choppier under way
      glide(v.wahDepth.gain, v.freq * (1.2 + 1.8 * move), 4, now, 5);
      // Bubbles until the next update, at irregular (Poisson) intervals like real ones: a few big gloops docked,
      // a busy wake when moving
      let at = Math.max(v.nextBubble, now + 0.05);
      while (at < now + 2.2) {
        this.bubbleAt(v, at, move);
        at += -Math.log(1 - Math.random()) / (move > 0.1 ? 3 + 8 * move : 1.2);
      }
      v.nextBubble = at;
    }
    this.ferries.forEach((v, id) => {
      if (seen.has(id) || v.fadeTimer) return;
      glide(v.space.gain, 0, 1.5, now, 0);
      v.fadeTimer = setTimeout(() => {
        v.oscs.forEach(o => o.stop());
        v.lfo.stop();
        v.space.disconnect();
        this.ferries.delete(id);
      }, 2000);
    });
  }

  // Close-up mode: one voice per bus on screen, so you can pick them apart. Pan: its direction from the
  // crosshair. Pitch: its route's note bent by its heading (see below), plus a few cents of its own.
  // Speed opens its filter and sets its tremolo; stopped buses go dull. Level: closeness. Its own lateness flattens it, makes its
  // two oscillators beat and drives it into a soft clip: this is where the roughness lives once you're close.
  updateNearby(vehicles, now) {
    vehicles = vehicles.slice(0, NEAR_VOICES); // nearest first, so over budget the furthest drop out
    const seen = new Set();
    for (const b of vehicles) {
      seen.add(b.id);
      let v = this.near.get(b.id);
      if (!v) this.near.set(b.id, v = this.makeNearVoice(b));
      if (v.fadeTimer) { clearTimeout(v.fadeTimer); v.fadeTimer = null; }
      const pos = this.place(b.lat, b.lon);
      // Heading bends the pitch continuously, +-2 semitones: east up, west down, north and south on the route's note,
      // so there's no jump anywhere round the compass. Heading comes from 20 s of movement; the bend glides over 4 s.
      const bend = b.heading == null ? 0 : 2 * Math.sin(b.heading * Math.PI / 180);
      const f = routePitch(b.route, this.modes.pitch) * 2 ** (bend / 12);
      const late = clamp01((b.delay - 60) / 540);
      const early = clamp01((-b.delay - 60) / 240);
      const centre = v.cents - 30 * late + 12 * early;
      const spread = 3 + 30 * late;
      v.oscs.forEach((o, i) => {
        glide(o.frequency, f, 4, now, 0.5); // a turn is a slow portamento
        glide(o.detune, centre + (i ? 0.5 : -0.5) * spread, 6, now, 0.5);
      });
      const drive = 0.03 + 0.25 * late;
      glide(v.drive.gain, drive, 6, now, 0.002);
      glide(v.makeup.gain, 0.1 / drive, 6, now, 0.01);
      const move = clamp01((b.kmh ?? 0) / 40);
      glide(v.filter.frequency, Math.min(12000, f * (1.5 + 10 * move)), 8, now, 20); // stopped: near sine; 40 km/h: bright
      glide(v.filter.Q, 0.7 + 2.5 * move, 8, now, 0.05);
      const band = Math.min(3, Math.floor(move * 4));
      if (v.band !== band) {
        if (v.band != null) this.tremolo[v.band].disconnect(v.lfoDepth);
        this.tremolo[band].connect(v.lfoDepth);
        v.band = band;
      }
      glide(v.lfoDepth.gain, 0.3 * move, 4, now, 0.01);
      glide(v.space.gain, this.closeUp * presence(pos), SPACE, now, 0.01);
      glide(v.pan.pan, pos.pan, SPACE, now, 0.02);
      glide(v.reverbSend.gain, 0.6 * wetness(pos), SPACE, now, 0.02);
    }
    this.near.forEach((v, id) => {
      if (seen.has(id) || v.fadeTimer) return;
      glide(v.space.gain, 0, 1, now, 0);
      v.fadeTimer = setTimeout(() => {
        v.oscs.forEach(o => o.stop());
        if (v.band != null) this.tremolo[v.band].disconnect(v.lfoDepth); // or the shared LFO keeps it alive
        v.space.disconnect();
        this.near.delete(id);
      }, 1500);
    });
    glide(this.nearBus.gain, 0.16 / Math.sqrt(Math.max(1, vehicles.length)), SPACE, now, 0.005);
  }

  // Two triangles -> lowpass -> drive into a soft clip -> makeup -> tremolo amp -> pan -> camera stage
  makeNearVoice(b) {
    const ctx = this.ctx;
    const node = (Type, opts) => new Type(ctx, opts);
    const f = routePitch(b.route, this.modes.pitch);
    const space = node(GainNode, { gain: 0 });
    space.connect(this.nearBus);
    const reverbSend = node(GainNode, { gain: 0 });
    space.connect(reverbSend).connect(this.mix.bus.wet);
    const pan = node(StereoPannerNode);
    pan.connect(space);
    const amp = node(GainNode, { gain: 0.6 });
    amp.connect(pan);
    const makeup = node(GainNode, { gain: 3 });
    makeup.connect(amp);
    const drive = node(GainNode, { gain: 0.03 });
    drive.connect(node(WaveShaperNode, { curve: BUZZ_CURVE })).connect(makeup);
    const filter = node(BiquadFilterNode, { type: 'lowpass', frequency: 1.5 * f, Q: 0.7 }); // speed opens it (see updateNearby)
    filter.connect(drive);
    const oscs = [0, 1].map(() => {
      const o = node(OscillatorNode, { type: 'triangle', frequency: f });
      o.connect(filter);
      o.start();
      return o;
    });
    const lfoDepth = node(GainNode, { gain: 0 }); // fed by a shared tremolo LFO (see updateNearby)
    lfoDepth.connect(amp.gain);
    kRate(space.gain, reverbSend.gain, pan.pan, filter.frequency, filter.Q, drive.gain, makeup.gain, ...oscs.flatMap(o => [o.frequency, o.detune]));
    return { space, pan, reverbSend, filter, drive, makeup, lfoDepth, band: null, oscs, cents: (Math.random() - 0.5) * 16, fadeTimer: null };
  }

  // Ferry: a low hull tone (two triangles a hair apart, slow vibrato) through a resonant band-pass that an LFO sweeps
  // up and down: the glop
  makeFerry(f) {
    const ctx = this.ctx;
    const node = (Type, opts) => new Type(ctx, opts);
    let freq = routePitch(f.route, this.modes.pitch);
    while (freq > 200) freq /= 2;
    const space = node(GainNode, { gain: 0 });
    space.connect(this.ferryBus);
    const reverbSend = node(GainNode, { gain: 0 });
    space.connect(reverbSend).connect(this.mix.ferry.wet);
    const glitchSend = node(GainNode, { gain: 0 });
    space.connect(glitchSend).connect(this.glitchIn);
    const pan = node(StereoPannerNode);
    pan.connect(space);
    const wah = node(BiquadFilterNode, { type: 'bandpass', frequency: freq * 3.5, Q: 4 });
    wah.connect(node(GainNode, { gain: 1.5 })).connect(pan);
    const lfo = node(OscillatorNode, { frequency: 0.2 });
    const wahDepth = node(GainNode, { gain: freq * 1.2 });
    const vibrato = node(GainNode, { gain: 14 }); // cents
    lfo.connect(wahDepth).connect(wah.frequency);
    lfo.connect(vibrato);
    const oscs = [1, 1.004].map(r => {
      const o = node(OscillatorNode, { type: 'triangle', frequency: freq * r });
      vibrato.connect(o.detune);
      o.connect(wah);
      o.start();
      return o;
    });
    lfo.start();
    kRate(space.gain, reverbSend.gain, glitchSend.gain, pan.pan, wah.frequency, ...oscs.flatMap(o => [o.frequency, o.detune]));
    return { space, pan, reverbSend, glitchSend, wahDepth, lfo, oscs, freq, nextBubble: 0, fadeTimer: null };
  }

  // A bubble: a sine whose pitch rises as it dies away. Docked: big, low, slow; moving: small, high, quick.
  bubbleAt(v, at, move, pitch = 1) {
    const ctx = this.ctx;
    const small = move > 0.1;
    const f0 = (small ? 500 + 900 * Math.random() : 170 + 330 * Math.random()) * pitch;
    const dur = small ? 0.04 + 0.05 * Math.random() : 0.1 + 0.14 * Math.random();
    const osc = new OscillatorNode(ctx, { frequency: f0 });
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f0 * (1.8 + Math.random()), at + dur);
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.12 + 0.12 * Math.random(), at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(v.pan);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  // Ferry docking: big gloops falling in pitch, and the granular bus captures and smears the boat for a few seconds.
  // ev: { id, route, lat, lon }
  ferryArrival(ev) {
    const ctx = this.ctx;
    const v = ctx && this.ferries.get(ev.id);
    if (!v) return;
    const at = ctx.currentTime + 0.02;
    for (let i = 0; i < 6; i++) this.bubbleAt(v, at + i * 0.12 + Math.random() * 0.05, 0, 1.3 - i * 0.12);
    if (!this.granular || at < this.glitchUntil) return;
    this.glitchUntil = at + 7;
    this.capture(v.glitchSend.gain, at, 2.5);
    this.shapeGranular(at, {
      density: [[0, 0], [0.6, 0], [1.2, 9], [4, 7], [7, 0]],
      reverse: [[0, 0.6], [7, 0.4]],
      stutter: [[0, 0.05], [7, 0.05]]
    });
  }

  clackAt(v, time, gain) {
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.clack, playbackRate: 0.85 + 0.3 * Math.random() });
    const g = new GainNode(this.ctx, { gain });
    src.connect(g).connect(v.pan);
    src.start(time);
  }

  // ev: { route, lat, lon, delay (s, signed), occupancy (GTFS-RT 0..6 or undefined) }
  arrival(ev) {
    const ctx = this.ctx;
    if (!ctx) return;
    const pos = this.place(ev.lat, ev.lon);
    const at = ctx.currentTime + 0.02;
    const root = routePitch(ev.route, this.modes.pitch);

    if (metaFor(ev.route).type === 2) {
      this.buzz(root, pos, at, false);
      return;
    }

    const bells = this.modes.drone === 'top8';
    const n = this.states.get(ev.route)?.n ?? 1;
    const late = clamp01((ev.delay - 60) / 540);
    const early = clamp01((-ev.delay - 60) / 240);
    // Busier routes ring longer, so in 'emergent' mode the drone is built from their own arrivals
    const decay = bells ? 2.5 : Math.min(6, 0.6 + 0.35 * n);
    const freq = root * (bells ? 2 : 1);
    const velocity = ([0.45, 0.6, 0.8][ev.occupancy] ?? (ev.occupancy >= 3 ? 0.95 : 0.55)) * (bells ? 0.7 : 1);
    this.fm({
      freq, at, decay, velocity, pos,
      ratio: 1 + early + 0.41 * late, // late = inharmonic, early = brighter
      index: 2,
      attack: 0.004,
      reverb: wetness(pos),
      glitch: 0,
      crush: late > 0.15 ? Math.round(7 - 5 * late) : 0 // ~2.4 min late: 7 bits, 10+ min late: 3 bits
    });
    if (!bells) this.swell(ev.route, at);
  }

  // A vehicle starts its next trip at the terminus: a low note (or long buzz for a train) that the glitch bus
  // captures and replays. ev: { route, lat, lon }
  turnaround(ev) {
    const ctx = this.ctx;
    if (!ctx) return;
    const pos = this.place(ev.lat, ev.lon);
    const at = ctx.currentTime + 0.02;
    const root = routePitch(ev.route, this.modes.pitch);
    this.glitchBurst(ev.route, at);
    if (metaFor(ev.route).type === 2) {
      this.buzz(root, pos, at, true);
      return;
    }
    this.fm({ freq: root / 2, ratio: 1, index: 2, attack: 0.004, decay: 5, velocity: 0.8, pos, at, reverb: wetness(pos), glitch: 1 });
  }

  // Train at a station: a low electric buzz at the line's pitch (a door buzzer, not a bell)
  buzz(root, pos, at, turnaround) {
    const ctx = this.ctx;
    if (this.activeNotes >= MAX_NOTES) return;
    const node = (Type, opts) => new Type(ctx, opts);
    let f = root;
    while (f > 160) f /= 2;
    while (f < 80) f *= 2;
    const len = turnaround ? 2.4 : 1.3;
    const a = node(OscillatorNode, { type: 'square', frequency: f });
    const b = node(OscillatorNode, { type: 'sawtooth', frequency: f * 1.006 }); // slow beating against the square
    const shaper = node(WaveShaperNode, { curve: BUZZ_CURVE });
    const bp = node(BiquadFilterNode, { type: 'bandpass', frequency: 700, Q: 1.3 });
    const amp = node(GainNode, { gain: 0 });
    const level = 0.09 * presence(pos);
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(level, at + 0.06);
    amp.gain.setValueAtTime(level, at + len - 0.4);
    amp.gain.linearRampToValueAtTime(0, at + len);
    const pan = node(StereoPannerNode, { pan: pos.pan });
    a.connect(shaper);
    b.connect(shaper);
    shaper.connect(bp).connect(amp).connect(pan).connect(this.noteBus);
    pan.connect(node(GainNode, { gain: wetness(pos) })).connect(this.mix.arrival.wet);
    if (turnaround) pan.connect(this.glitchIn);
    [a, b].forEach(o => { o.start(at); o.stop(at + len); });
    this.activeNotes++;
    a.onended = () => {
      pan.disconnect();
      if (this.ctx === ctx) this.activeNotes--;
    };
  }

  // Glitch bus: silent until a vehicle turns around at the end of its route (~1-2.5 a minute city-wide, one burst
  // at a time). The route's drone is captured for 2 s and replayed as reversed, stuttering grains that thin out.
  glitchBurst(route, at) {
    if (!this.granular || at < this.glitchUntil) return;
    this.glitchUntil = at + 6;
    const v = this.voices.get(route);
    if (v && !v.fadeTimer) this.capture(v.glitchSend.gain, at, 2);
    this.shapeGranular(at, {
      density: [[0, 0], [0.5, 0], [0.9, 20], [2.5, 14], [5.5, 0]],
      reverse: [[0, 0.5 + 0.5 * clamp01((this.cityEarly || 0) * 3)], [5.5, 0.3]],
      stutter: [[0, 0.5], [2, 0.6], [5.5, 0.1]]
    });
  }

  // Open a voice's send into the granular bus for a few seconds, so the grains have something to chew on
  capture(param, at, secs) {
    param.cancelScheduledValues(at);
    param.setValueAtTime(0, at);
    param.linearRampToValueAtTime(1, at + 0.1);
    param.setValueAtTime(1, at + secs);
    param.linearRampToValueAtTime(0, at + secs + 0.5);
  }

  // Automate the granular bus's per-burst parameters: { name: [[seconds from at, value], ...] }
  shapeGranular(at, shapes) {
    const g = this.granular.parameters;
    for (const [name, points] of Object.entries(shapes)) {
      const p = g.get(name);
      p.cancelScheduledValues(at);
      p.setValueAtTime(points[0][1], at);
      points.slice(1).forEach(([t, val]) => p.linearRampToValueAtTime(val, at + t));
    }
  }

  // 2-operator FM note: modulator -> carrier frequency, carrier -> [bitcrush] -> envelope -> pan -> dry + sends.
  // Crushing before the envelope keeps the grit steady as the note decays (after it, the tail would just gate out).
  fm({ freq, ratio, index, attack, decay, velocity, pos, at, reverb, glitch, crush = 0 }) {
    const ctx = this.ctx;
    if (this.activeNotes >= MAX_NOTES) return;
    while (freq > 2500) freq /= 2; // keep pings out of the piercing range
    const node = (Type, opts) => new Type(ctx, opts);
    const end = at + attack + decay;
    const car = node(OscillatorNode, { frequency: freq });
    const mod = node(OscillatorNode, { frequency: freq * ratio });
    const modGain = node(GainNode, { gain: index * freq * ratio * Math.min(1, 800 / freq) }); // less FM up high: less aliasing
    modGain.gain.setTargetAtTime(0, at, decay * 0.08); // brightness fades faster than loudness
    const amp = node(GainNode, { gain: 0 });
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(velocity * NOTE_GAIN * presence(pos), at + attack);
    amp.gain.setTargetAtTime(0, at + attack, decay / 5);
    const pan = node(StereoPannerNode, { pan: pos.pan });
    mod.connect(modGain).connect(car.frequency);
    (crush ? car.connect(node(WaveShaperNode, { curve: crushCurve(crush) })) : car).connect(amp).connect(pan).connect(this.noteBus);
    pan.connect(node(GainNode, { gain: reverb })).connect(this.mix.arrival.wet);
    if (glitch > 0.01) pan.connect(node(GainNode, { gain: glitch })).connect(this.glitchIn);
    car.start(at);
    mod.start(at);
    car.stop(end);
    mod.stop(end);
    this.activeNotes++;
    car.onended = () => {
      pan.disconnect();
      if (this.ctx === ctx) this.activeNotes--;
    };
  }

  swell(route, t) { // Lyra-style touch: lift the route's drone above its hold floor, then let it settle
    const v = this.voices.get(route);
    if (!v || v.fadeTimer) return;
    const g = v.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v.hold + 0.3, t + 0.15);
    g.linearRampToValueAtTime(v.hold, t + 3);
    g._target = v.hold;
  }
}

window.RouteSynth = RouteSynth;
window.routePitch = routePitch;
window.routeDegree = (route, mode) => ((routeStep(route, mode) % SCALE.length) + SCALE.length) % SCALE.length; // for colours
window.routeFamily = route => family(metaFor(route)); // 'city' | 'hutt' | 'north' | 'rail' | 'special'
