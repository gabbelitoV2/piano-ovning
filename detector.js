// Hör vilka pianotangenter som slås an, från mikrofonljud.
//
// Metod: varje analys jämför spektrumet nu med hur det såg ut ~0,15 s tidigare. Bara ljud som
// just tillkommit (nya anslag) blir kvar, så toner som klingar vidare med pedalen stör inte.
// I det nya ljudet letas tonerna fram en i taget: den tangent vars deltoner (grundton + övertoner)
// förklarar mest energi väljs, dess deltoner tas bort, och sedan letas nästa.
// Stämningen (cent) justerar alla förväntade frekvenser och varje ton får avvika lite (tolerans),
// så ett lite ostämt piano fungerar.
(function (g) {
  'use strict';

  function makeFFT(N) {
    const bits = Math.round(Math.log2(N));
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let r = 0, x = i; for (let k = 0; k < bits; k++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const a = j + half;
            const tre = re[a] * cos[k] + im[a] * sin[k];
            const tim = im[a] * cos[k] - re[a] * sin[k];
            re[a] = re[j] - tre; im[a] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  const W = [1, 0.85, 0.7, 0.6, 0.5, 0.42, 0.36, 0.3];
  const RING = 4;            // sparade spektrum; jämförelse med 3 analyser bakåt
  const MAX_NOTES = 10;

  class PitchDetector {
    constructor(sampleRate) {
      this.sr = sampleRate;
      this.N = sampleRate > 30000 ? 16384 : 8192;
      const N = this.N, half = N / 2;
      this.fft = makeFFT(N);
      this.re = new Float64Array(N);
      this.im = new Float64Array(N);
      this.win = new Float32Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));   // Hann
      this.ring = [];
      for (let r = 0; r < RING; r++) this.ring.push(new Float32Array(half));
      this.diff = new Float32Array(half);
      this.frames = 0;
      this.tune = 0;              // hela pianots stämning i cent (negativt = lågt stämt)
      this.tolCents = 45;         // hur mycket varje enskild ton får avvika
      this.sensitivity = 0.5;     // 0..1
      this.refractoryMs = 260;
      this.relaxed = true;        // väntade toner får lite mildare krav
      this.lo = 21; this.hi = 108;
      this.lastOnset = new Float64Array(128).fill(-1e9);
      this.level = -120;
      this.cur = this.ring[0];
      this._plan();
    }

    setRange(lo, hi) { this.lo = Math.max(21, lo); this.hi = Math.min(108, hi); this._plan(); }
    setTune(cents) { this.tune = cents; this._plan(); }

    freq(p) { return 440 * Math.pow(2, (p - 69) / 12 + this.tune / 1200); }

    // Förberäknar vilka frekvensband varje tangents deltoner ligger i.
    _plan() {
      const N = this.N, sr = this.sr, tol = Math.pow(2, this.tolCents / 1200) - 1;
      this.bands = []; this.nUse = [];
      for (let p = 0; p < 128; p++) {
        if (p < this.lo || p > this.hi) { this.bands[p] = null; continue; }
        const f0 = this.freq(p);
        const H = p < 48 ? 8 : p < 60 ? 6 : p < 72 ? 4 : 3;
        const B = Math.min(2e-3, Math.max(5e-5, 1e-4 * Math.pow(2, (p - 48) / 12)));   // strängarnas inharmonicitet
        const list = [];
        for (let h = 1; h <= 16; h++) {
          const f = h * f0 * Math.sqrt(1 + B * h * h);
          if (f > sr * 0.45) break;
          const c = f * N / sr, t = Math.max(1, c * tol);
          list.push({ h, use: h <= H, a: Math.max(1, Math.floor(c - t)), b: Math.min(N / 2 - 1, Math.ceil(c + t)),
            ca: Math.max(1, Math.floor(c - Math.max(t, 3))), cb: Math.min(N / 2 - 1, Math.ceil(c + Math.max(t, 3))) });
        }
        this.bands[p] = list;
        this.nUse[p] = list.filter(b => b.use).length;
      }
    }

    _spectrum(samples) {
      const N = this.N, re = this.re, im = this.im, off = samples.length - N;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const x = off + i >= 0 ? samples[off + i] : 0;
        sum += x * x;
        re[i] = x * this.win[i]; im[i] = 0;
      }
      this.level = 10 * Math.log10(sum / N + 1e-12);
      this.fft(re, im);
      const m = this.ring[this.frames % RING];
      for (let k = 0; k < N / 2; k++) m[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      this.cur = m;
    }

    _peaks(spec, p, all) {
      const bands = this.bands[p], n = all ? bands.length : this.nUse[p], amps = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        let mx = 0;
        for (let k = bands[j].a; k <= bands[j].b; k++) if (spec[k] > mx) mx = spec[k];
        amps[j] = mx;
      }
      return amps;
    }

    _salience(spec, p) {
      if (!this.bands[p]) return 0;
      const amps = this._peaks(spec, p);
      // en riktig ton har energi vid sin grundton (basens grundton är svag, där räcker 2:a–3:e deltonen)
      let mx = 0;
      for (let j = 0; j < amps.length; j++) if (amps[j] > mx) mx = amps[j];
      const own = p < 48 ? Math.max(amps[0], amps[1] || 0, amps[2] || 0) : amps[0];
      if (own < 0.25 * mx) return 0;
      let s = 0;
      for (let j = 0; j < amps.length; j++) s += W[j] * amps[j];
      return s;
    }

    // Tar bort tangentens deltoner ur spektrumet. En deltonsamplitud som är mycket större än
    // grannarnas antas delas med en annan ton, så bara en "rimlig" del tas bort.
    _cancel(spec, p) {
      const bands = this.bands[p], amps = this._peaks(spec, p, true);
      for (let j = 0; j < bands.length; j++) {
        // grundtonen tas bort helt; övertoner som är mycket starkare än grannarna delas troligen med en annan ton
        const nb = j === 0 ? amps[0] : (amps[j - 1] + (amps[j + 1] !== undefined ? amps[j + 1] : amps[j - 1])) / 2;
        const take = j === 0 ? amps[0] : Math.min(amps[j], 2 * nb + 1e-9);
        for (let k = bands[j].ca; k <= bands[j].cb; k++) spec[k] = Math.max(0, spec[k] - take);
      }
    }

    thresholdDb() { return 24 - 12 * Math.min(1, Math.max(0, this.sensitivity)); }

    // Analyserar de senaste N ljudproverna. `expected` = tangenter som väntas just nu.
    // Returnerar nya anslag: [{p, strength(dB), expected}]
    analyze(samples, nowMs, expected) {
      this._spectrum(samples);
      const half = this.N / 2, cur = this.cur;
      const older = this.frames >= 3 ? this.ring[(this.frames - 3) % RING] : null;
      this.frames++;
      if (!older || this.level < -62) return [];
      const D = this.diff;
      for (let k = 0; k < half; k++) { const d = cur[k] - older[k]; D[k] = d > 0 ? d : 0; }
      // ta bort brett brus (t.ex. hammarens smäll): behåll bara det som sticker upp över omgivningen
      const cs = this.cumsum || (this.cumsum = new Float64Array(half + 1));
      for (let k = 0; k < half; k++) cs[k + 1] = cs[k] + D[k];
      const flat = this.flat || (this.flat = new Float32Array(half));
      for (let k = 0; k < half; k++) {
        const w = Math.max(6, Math.round(k * 0.06));
        const a = Math.max(0, k - w), b = Math.min(half, k + w + 1);
        const local = (cs[b] - cs[a]) / (b - a);
        const v = D[k] - 1.5 * local;
        flat[k] = v > 0 ? v : 0;
      }
      D.set(flat);

      // brusnivå = median av alla tangenters salience i det nya ljudet
      const vals = [];
      for (let p = this.lo; p <= this.hi; p++) vals.push(this._salience(D, p));
      vals.sort((a, b) => a - b);
      const floor = vals[vals.length >> 1] + 1e-9;
      const thr = floor * Math.pow(10, this.thresholdDb() / 20);

      const found = [];
      const chosen = new Set();
      let firstV = 0;
      for (let it = 0; it < MAX_NOTES; it++) {
        let bp = -1, bv = 0;
        for (let p = this.lo; p <= this.hi; p++) {
          if (chosen.has(p)) continue;
          const v = this._salience(D, p);
          if (v > bv) { bv = v; bp = p; }
        }
        if (bp < 0 || bv < thr || (found.length && bv < firstV * 0.12)) break;
        if (!found.length) firstV = bv;
        chosen.add(bp);
        found.push({ p: bp, strength: 20 * Math.log10(bv / floor), expected: !!(expected && expected.has(bp)) });
        this._cancel(D, bp);
      }
      // En väntad ton en oktav (eller duodecim) ovanför en hittad ton döljs lätt av den lägre tonens
      // övertoner. Bara då räcker det med lite mindre energi i det som är kvar.
      if (expected && this.relaxed) {
        for (const p of expected) {
          if (chosen.has(p) || !this.bands[p]) continue;
          if (!(chosen.has(p - 12) || chosen.has(p - 19) || chosen.has(p - 24))) continue;
          const v = this._salience(D, p);
          if (v >= thr * 0.5 && v >= this._salience(D, p - 1) && v >= this._salience(D, p + 1)) {
            chosen.add(p);
            found.push({ p, strength: 20 * Math.log10(v / floor), expected: true });
          }
        }
      }
      const onsets = [];
      for (const o of found) {
        if (nowMs - this.lastOnset[o.p] > this.refractoryMs) { onsets.push(o); this.lastOnset[o.p] = nowMs; }
      }
      return onsets;
    }

    // Starkaste frekvensen mellan fLo och fHi i senaste analysen (för stämning).
    peak(fLo, fHi) {
      const N = this.N, sr = this.sr, m = this.cur;
      const k0 = Math.max(2, Math.floor(fLo * N / sr)), k1 = Math.min(N / 2 - 2, Math.ceil(fHi * N / sr));
      let bk = k0;
      for (let k = k0; k <= k1; k++) if (m[k] > m[bk]) bk = k;
      const a = Math.log(m[bk - 1] + 1e-12), b = Math.log(m[bk] + 1e-12), c = Math.log(m[bk + 1] + 1e-12);
      const den = a - 2 * b + c;
      const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
      let sum = 0;
      for (let k = k0; k <= k1; k++) sum += m[k];
      const avg = sum / (k1 - k0 + 1);
      return { f: (bk + Math.max(-0.5, Math.min(0.5, shift))) * sr / N, snr: 20 * Math.log10(m[bk] / (avg + 1e-12)) };
    }
  }

  g.PianoDetector = { PitchDetector };
})(typeof globalThis !== 'undefined' ? globalThis : window);
