// Glitch FX bus: grains read back from the last 4 s of whatever is sent here.
// Native Web Audio nodes can't capture and replay audio, so this runs as one AudioWorklet node.
class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'density', defaultValue: 0, minValue: 0, maxValue: 60, automationRate: 'k-rate' },    // grains per second
      { name: 'size', defaultValue: 0.12, minValue: 0.01, maxValue: 1, automationRate: 'k-rate' },  // grain length, s
      { name: 'reverse', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },   // chance a grain plays backwards
      { name: 'scatter', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' },  // chance of an octave jump
      { name: 'stutter', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },  // chance to repeat the last grain
      { name: 'feedback', defaultValue: 0.2, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.len = Math.floor(sampleRate * 4);
    this.buf = [new Float32Array(this.len), new Float32Array(this.len)];
    this.write = 0;
    this.grains = [];
    this.untilNext = 0;
    this.last = null;
  }

  spawn(p) {
    const size = Math.floor(p.size * sampleRate * (0.6 + 0.8 * Math.random()));
    if (this.last && Math.random() < p.stutter) {
      this.grains.push({ ...this.last, age: 0, pos: this.last.start });
      return;
    }
    let rate = Math.random() < p.scatter ? (Math.random() < 0.5 ? 0.5 : 2) : 1;
    if (Math.random() < p.reverse) rate = -rate;
    // Start far enough behind the write head that the grain never reads past it
    const back = size * Math.max(1, Math.abs(rate)) + Math.random() * sampleRate * 0.8; // recent past: bursts capture ~2 s
    const start = (this.write - back + this.len) % this.len;
    const pan = Math.random() * 2 - 1;
    const g = { start, pos: start, rate, len: size, age: 0, l: Math.sqrt((1 - pan) / 2), r: Math.sqrt((1 + pan) / 2) };
    this.grains.push(g);
    this.last = g;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const p = {};
    for (const k in parameters) p[k] = parameters[k][0];
    const inL = input[0], inR = input[1] || input[0];
    const [bufL, bufR] = this.buf;
    const len = this.len;

    for (let i = 0; i < n; i++) {
      if (--this.untilNext <= 0) {
        if (p.density > 0 && this.grains.length < 24) this.spawn(p);
        this.untilNext = p.density > 0 ? (sampleRate / p.density) * (0.3 + 1.4 * Math.random()) : sampleRate * 0.1;
      }
      let l = 0, r = 0;
      for (const g of this.grains) {
        if (g.age >= g.len) continue;
        const env = Math.sin(Math.PI * g.age / g.len); // smooth window, no clicks
        const idx = (g.pos % len + len) % len;
        const j = Math.floor(idx), f = idx - j, k = (j + 1) % len;
        l += (bufL[j] + (bufL[k] - bufL[j]) * f) * env * g.l;
        r += (bufR[j] + (bufR[k] - bufR[j]) * f) * env * g.r;
        g.pos += g.rate;
        g.age++;
      }
      // Record input plus saturated feedback, so heavy feedback smears instead of blowing up
      const w = this.write;
      bufL[w] = Math.tanh((inL ? inL[i] : 0) + l * p.feedback);
      bufR[w] = Math.tanh((inR ? inR[i] : 0) + r * p.feedback);
      this.write = (w + 1) % len;
      out[0][i] = l * 0.5;
      if (out[1]) out[1][i] = r * 0.5;
    }
    this.grains = this.grains.filter(g => g.age < g.len);
    return true;
  }
}

registerProcessor('granular', GranularProcessor);
