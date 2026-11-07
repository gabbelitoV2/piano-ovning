// Hör vilka pianotangenter som slås an, från mikrofonljud.
//
// Nya toner: varje analys jämför spektrumet nu med det starkaste det var för 90–180 ms sedan. Bara ljud
// som tillkommit sedan dess ("nytt ljud") används för att leta toner, en i taget: den tangent vars
// deltoner (grundton + övertoner) förklarar mest energi väljs, dess deltoner tas bort, och sedan letas
// nästa. En kandidat godkänns bara om tonen blivit tydligt starkare än den nyss var – totalt, i
// grundtonen och i de flesta deltonerna samtidigt. En svävning (ostämda unisonsträngar) rör deltonerna
// i otakt och räknas därför inte som ett nytt anslag.
//
// Omslag: en tangent som slås om medan tonen fortfarande klingar blir inte nödvändigtvis starkare (den nya
// svängningen läggs till den gamla med slumpmässig fas). Det som alltid finns är själva anslaget: en
// plötslig förändring. Därför mäts anslag i korta rutor (43 ms) som bredbandig "smäll" 1–8 kHz, och när
// en smäll hörts jämförs varje väntad, klingande tons deltoner i den långa rutan före smällen med dem
// i den första långa rutan helt efter – ett steg som är klart större än tonens egen långsamma drift
// räknas som omslag. Det tar ca 0,4 s, vilket är fullt tillräckligt i vänta-läget.
//
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
  // Baslinje = det starkaste i analyserna 2–10 steg bakåt (ca 90–450 ms). En svävning är periodisk, så en
  // så lång baslinje innehåller alltid dess senaste topp – en ny ton överskrider den ändå med god marginal.
  const BASE_FROM = 2, BASE_TO = 4;
  const RING = 12;                    // sparade långa spektrum (ca 0,55 s), även för före/efter-jämförelsen
  const MAX_NOTES = 10;
  const S_FRAMES = 5;                 // korta rutor per analys (nyast först)
  const HARM = [12, 19, 24, 28, 31, 34, 36, 38, 40];   // halvtonsavstånd till deltonerna 2–10

  class PitchDetector {
    constructor(sampleRate, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.N = opts.fftSize || (sampleRate > 30000 ? 16384 : 8192);
      const N = this.N, half = N / 2;
      this.winMs = N / sampleRate * 1000;
      this.fft = makeFFT(N);
      this.re = new Float64Array(N);
      this.im = new Float64Array(N);
      this.win = new Float32Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));   // Hann
      this.ring = [];
      for (let r = 0; r < RING; r++) this.ring.push(new Float32Array(half));
      this.ringT = new Float64Array(RING).fill(-1e9);
      this.base = new Float32Array(half);
      this.diff = new Float32Array(half);
      this.cumsum = new Float64Array(half + 1);
      // korta rutor (43 ms, halvt överlapp) för att höra själva anslaget
      this.sN = 2048;
      this.sHop = this.sN / 2;
      this.sfft = makeFFT(this.sN);
      this.sre = new Float64Array(this.sN); this.sim = new Float64Array(this.sN);
      this.swin = new Float32Array(this.sN);
      for (let i = 0; i < this.sN; i++) this.swin[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.sN - 1));
      this.sSpec = [];
      for (let j = 0; j < S_FRAMES; j++) this.sSpec.push(new Float32Array(this.sN / 2));
      this.thumpRatio = 0.3;      // flux (1–8 kHz) som krävs för att räknas som ett anslag
      this.lastThump = -1e9;
      this.lastThumpRatio = 0;
      this.ignoreThumpUntil = -1e9;   // (äldre sätt) appen kan be att smällar ignoreras en stund
      this.ownOnsets = [];            // appens egna anslag {t, p}: en smäll samtidigt med ett sådant får inte
                                      // bevisa ett omslag av en ton som är harmoniskt släkt med det
      this.pending = null;            // smäll som väntar på före/efter-jämförelse
      this.lastUnexpected = -1e9;     // när en oväntad ny ton senast hördes
      this.pendingUnexpected = new Map();   // oväntade kandidater som väntar på bekräftelse i nästa analys
      this.recentUnexpected = new Map();    // bekräftat oväntade toner (fel tangenter) som kan klinga ännu
      this.lastRestrikeEval = [];
      this.frames = 0;
      this.tune = 0;              // hela pianots stämning i cent (negativt = lågt stämt)
      this.tolCents = 45;         // hur mycket varje enskild ton får avvika
      this.sensitivity = 0.5;     // 0..1
      this.refractoryMs = 180;    // samma tangent rapporteras inte oftare än så
      this.riseDb = 4;            // en ny ton måste bli minst så här mycket starkare än den nyss var
      this.coherence = 0.6;       // ...i minst så stor (viktad) andel av sina hörbara deltoner samtidigt
      this.seenPrev = new Map();  // kandidater i förra analysen: en ton rapporteras först när den hörts två analyser i rad
      this.stepDb = 1.5;          // ett omslag måste ge minst så här stort steg i deltonerna
      this.relaxed = true;        // väntade toner en oktav över en hörd ton får lite mildare krav
      this.lo = 21; this.hi = 108;
      this.lastOnset = new Float64Array(128).fill(-1e9);
      this.level = -120;
      this.quiet = 0;             // ljudnivå i vila (följer ner snabbt, upp långsamt)
      this.cur = this.ring[0];
      this._plan();
    }

    setRange(lo, hi) { this.lo = Math.max(21, lo); this.hi = Math.min(108, hi); this._plan(); }
    setTune(cents) { this.tune = cents; this._plan(); }

    // Appen anropar detta när den vet att spelaren spelat tonen (t.ex. ett ackord som godkänts fast någon ton
    // inte hördes), så att tonen räknas som klingande och ett senare omslag av den kan bedömas.
    markPlayed(p, tMs) {
      if (p >= 0 && p < 128 && tMs > this.lastOnset[p]) this.lastOnset[p] = tMs;
    }

    // Appen anropar detta när den själv börjar spela en ton (ackompanjemanget).
    markOwnOnset(tMs, p) {
      this.ownOnsets = this.ownOnsets.filter(o => tMs - o.t < 1500);
      this.ownOnsets.push({ t: tMs, p });
    }

    // Är tonen p harmoniskt släkt med q (samma, oktav, duodecim …), så att q:s anslag kan ändra p:s deltoner?
    static _related(p, q) {
      const d = Math.abs(p - q);
      return d === 0 || HARM.includes(d);
    }

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
          list.push({ h, use: h <= H, a: Math.max(1, Math.floor(c - t)), b: Math.min(N / 2 - 2, Math.ceil(c + t)),
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

    // Starkaste värdet i ett band – men bara om toppen ligger inne i bandet, inte på kanten.
    // En riktig delton hamnar alltid inne i sitt band; en topp på kanten hör till en grannton
    // (i basen ligger halvtonerna bara någon bin isär).
    static _bandPeak(spec, a, b) {
      let mx = 0, mk = -1;
      for (let k = a; k <= b; k++) if (spec[k] > mx) { mx = spec[k]; mk = k; }
      if (b - a >= 2 && (mk === a || mk === b)) return 0;
      return mx;
    }

    _peaks(spec, p, all) {
      const bands = this.bands[p], n = all ? bands.length : this.nUse[p], amps = new Float32Array(n);
      for (let j = 0; j < n; j++) amps[j] = PitchDetector._bandPeak(spec, bands[j].a, bands[j].b);
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
      if (p < 48 && amps[0] < 0.08 * mx) return 0;   // även en baston har en hörbar grundton (annars är det en oktav upp som klingar)
      let s = 0;
      for (let j = 0; j < amps.length; j++) s += W[j] * amps[j];
      return s;
    }

    // Tar bort tangentens deltoner ur spektrumet. En deltonsamplitud som är mycket större än
    // grannarnas antas delas med en annan ton, så bara en "rimlig" del tas bort.
    _cancel(spec, p) {
      const bands = this.bands[p], amps = this._peaks(spec, p, true);
      for (let j = 0; j < bands.length; j++) {
        const nb = j === 0 ? amps[0] : (amps[j - 1] + (amps[j + 1] !== undefined ? amps[j + 1] : amps[j - 1])) / 2;
        const take = j === 0 ? amps[0] : Math.min(amps[j], 2 * nb + 1e-9);
        for (let k = bands[j].ca; k <= bands[j].cb; k++) spec[k] = Math.max(0, spec[k] - take);
      }
    }

    thresholdDb() { return 24 - 12 * Math.min(1, Math.max(0, this.sensitivity)); }

    // Vilken tangent ligger toppen av det nya ljudet närmast, inom ±1,5 halvton runt tonens grundton
    // (för bastoner: dess starkaste av de tre första deltonerna)? Ett anslags topp är bred i början,
    // och då får bara den tangent som toppen ligger närmast räknas.
    _nearestPitch(spec, p) {
      const bands = this.bands[p];
      let j = 0;
      if (p < 48) {
        let best = 0;
        for (let k = 0; k < 3 && k < bands.length; k++) { const v = PitchDetector._bandPeak(spec, bands[k].a, bands[k].b); if (v > best) { best = v; j = k; } }
      }
      const h = bands[j].h, N = this.N, sr = this.sr;
      const fc = h * this.freq(p), k0 = Math.max(1, Math.floor(fc * Math.pow(2, -1.5 / 12) * N / sr)), k1 = Math.min(N / 2 - 2, Math.ceil(fc * Math.pow(2, 1.5 / 12) * N / sr));
      let km = k0;
      for (let k = k0; k <= k1; k++) if (spec[k] > spec[km]) km = k;
      if (spec[km] <= 0) return p;
      const a = spec[km - 1], b = spec[km], c = spec[km + 1], den = a - 2 * b + c;
      const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      const f = (km + shift) * sr / N / h;
      return Math.round(12 * Math.log2(f / this.freq(p))) + p;
    }

    // Korta rutor ur slutet av bufferten (nyast = index 0, halvt överlapp). Returnerar anslagsmåttet:
    // nytt ljud 1–8 kHz i någon av de tre nyaste rutorna, jämfört med det starkaste i de två rutorna strax före.
    _thump(samples) {
      const n = this.sN, hop = this.sHop, len = samples.length;
      if (len < (S_FRAMES - 1) * hop + n) return { ratio: 0, j: -1 };
      for (let j = 0; j < S_FRAMES; j++) {
        const off = len - j * hop - n;
        for (let i = 0; i < n; i++) { this.sre[i] = samples[off + i] * this.swin[i]; this.sim[i] = 0; }
        this.sfft(this.sre, this.sim);
        const m = this.sSpec[j];
        for (let k = 0; k < n / 2; k++) m[k] = Math.sqrt(this.sre[k] * this.sre[k] + this.sim[k] * this.sim[k]);
      }
      const k0 = Math.round(1000 * n / this.sr), k1 = Math.min(n / 2 - 1, Math.round(8000 * n / this.sr));
      let best = 0, bj = -1;
      for (let j = 0; j < 3; j++) {
        const S = this.sSpec[j], B1 = this.sSpec[j + 1], B2 = this.sSpec[j + 2];
        let up = 0, before = 0;
        for (let k = k0; k <= k1; k++) {
          const b = B1[k] > B2[k] ? B1[k] : B2[k];
          if (S[k] > b) up += S[k] - b;
          before += b;
        }
        const r = up / (before + 1e-9);
        if (r > best) { best = r; bj = j; }
      }
      return { ratio: best, j: bj };
    }

    // Genomsnittlig förändring (dB, oavsett riktning) i tonens deltoner mellan två rutor,
    // viktad med deltonernas styrka så att deltoner som klingat ut (brus) inte påverkar.
    _stepDb(a, b) {
      let s = 0, w = 0;
      for (let j = 0; j < a.length; j++) {
        const amp = Math.max(a[j], b[j]);
        if (amp <= 0) continue;
        const wt = W[j] * amp;
        s += wt * Math.min(20, Math.abs(20 * Math.log10((a[j] + 1e-7) / (b[j] + 1e-7))));   // en delton som saknas före/efter får inte dominera
        w += wt;
      }
      return w > 0 ? s / w : 0;
    }

    // Har tonen p blivit tydligt starkare än den var i baslinjen – totalt, i grundtonen och i de flesta
    // deltonerna samtidigt?
    _risen(p) {
      const a = this._peaks(this.cur, p), b = this._peaks(this.base, p);
      let mx = 0, sa = 0, sb = 0;
      for (let j = 0; j < a.length; j++) { if (a[j] > mx) mx = a[j]; sa += W[j] * a[j]; sb += W[j] * b[j]; }
      const need = Math.pow(10, this.riseDb / 20);
      if (sa < sb * need) return false;
      const needPart = Math.pow(10, (this.riseDb - 1) / 20);
      const fund = p < 48 ? Math.max(a[0], a[1] || 0, a[2] || 0) : a[0];
      const fundB = p < 48 ? Math.max(b[0], b[1] || 0, b[2] || 0) : b[0];
      if (fund < fundB * needPart) return false;
      let wUp = 0, wAll = 0;
      for (let j = 0; j < a.length; j++) {
        if (a[j] < 0.05 * mx) continue;      // deltoner som inte hörs räknas inte
        if (j > 0 && b[j] > fundB) continue; // bandet var redan starkare än grundtonen: en annan ton klingar där, säger inget
        wAll += W[j];
        if (a[j] >= b[j] * needPart) wUp += W[j];
      }
      return wAll > 0 && wUp / wAll >= this.coherence;
    }

    // Analyserar de senaste N ljudproverna. `expected` = tangenter som väntas just nu,
    // `own` = tangenter som appen själv spelar just nu (rapporteras inte och räknas inte som oväntade).
    // Returnerar nya anslag: [{p, strength(dB), expected, restrike?, ghost?}]
    analyze(samples, nowMs, expected, own) {
      this._spectrum(samples);
      const half = this.N / 2, cur = this.cur, fr = this.frames;
      this.ringT[fr % RING] = nowMs;
      this.frames++;
      this.lastRestrikeEval = [];
      if (fr < BASE_TO || this.level < -62) return [];

      // --- anslag (smäll) i korta rutor ---
      const th = this._thump(samples);
      this.lastThumpRatio = th.ratio;
      const msPer = 1000 / this.sr;
      if (th.ratio >= this.thumpRatio && nowMs >= this.ignoreThumpUntil) {
        const fresh = nowMs - this.lastThump > 150;   // samma anslag syns i flera analyser i rad – räkna det en gång
        this.lastThump = nowMs;
        this.thumpTimes = (this.thumpTimes || []).filter(t => nowMs - t < 1500);
        if (fresh) this.thumpTimes.push(nowMs);
        // före/efter-jämförelsen sätts upp bara första gången smällen hörs – senare analyser ser samma
        // anslag igen, och deras "före"-ruta skulle redan innehålla det
        if (fresh && expected && expected.size) {
          const at = nowMs - (th.j * this.sHop + this.sN / 2) * msPer;   // ungefärlig tidpunkt för anslaget
          const ownNear = new Set(this.ownOnsets.filter(o => at >= o.t - 40 && at <= o.t + 130).map(o => o.p));
          // nyaste långa rutan som slutar före anslaget, och en som slutar ett fönster tidigare (för driften)
          let bi = -1, di = -1;
          for (let k = 1; k < RING && fr - k >= 0; k++) {
            const idx = fr - k, T = this.ringT[idx % RING];
            if (bi < 0 && T <= at) bi = idx;
            if (bi >= 0 && T <= at - this.winMs) { di = idx; break; }
          }
          if (bi >= 0) {
            const before = new Map(), drift = new Map(), wrongBefore = new Map();
            for (const p of expected) {
              if (!this.bands[p]) continue;
              const b = this._peaks(this.ring[bi % RING], p);
              before.set(p, b);
              drift.set(p, di >= 0 ? this._stepDb(b, this._peaks(this.ring[di % RING], p)) : 0);
            }
            // fel tangenter som nyss hörts och kan klinga ännu: slås en sådan om igen hörs ingen ny ton,
            // så vi jämför hur mycket de ändras med hur mycket de väntade tonerna ändras
            for (const [p, t] of this.recentUnexpected) {
              if (nowMs - t > 4000) { this.recentUnexpected.delete(p); continue; }
              if (!this.bands[p] || expected.has(p)) continue;
              if (this._salience(this.ring[bi % RING], p) < this.quiet * 4) continue;   // bara om den klingar före smällen
              const wb = this._peaks(this.ring[bi % RING], p);
              wrongBefore.set(p, { b: wb, drift: di >= 0 ? this._stepDb(wb, this._peaks(this.ring[di % RING], p)) : 0 });
            }
            this.pending = { at, before, drift, wrongBefore, ownNear, evals: 0, accepted: new Set(), blocked: false };
          }
        }
      }

      // --- nya toner ur det som tillkommit sedan baslinjen ---
      const base = this.base;
      base.set(this.ring[(fr - BASE_FROM) % RING]);
      for (let o = BASE_FROM + 1; o <= BASE_TO; o++) {
        const m = this.ring[(fr - o) % RING];
        for (let k = 0; k < half; k++) if (m[k] > base[k]) base[k] = m[k];
      }
      const D = this.diff;
      for (let k = 0; k < half; k++) { const d = cur[k] - base[k]; D[k] = d > 0 ? d : 0; }
      // brett brus (hammarsmäll, klick) tas bort: behåll bara toppar som sticker upp över omgivningen
      const cs = this.cumsum;
      for (let k = 0; k < half; k++) cs[k + 1] = cs[k] + D[k];
      for (let k = 0; k < half; k++) {
        const w = Math.max(6, Math.round(k * 0.06));
        const a = Math.max(0, k - w), b = Math.min(half, k + w + 1);
        const v = D[k] - 1.5 * (cs[b] - cs[a]) / (b - a);
        D[k] = v > 0 ? v : 0;
      }
      // nivåer: medianen av tangenternas styrka i det nya ljudet, och i hela ljudet (vilonivå)
      const dvals = [], fvals = [];
      for (let p = this.lo; p <= this.hi; p++) { dvals.push(this._salience(D, p)); fvals.push(this._salience(cur, p)); }
      dvals.sort((a, b) => a - b); fvals.sort((a, b) => a - b);
      const medDiff = dvals[dvals.length >> 1], medFull = fvals[fvals.length >> 1], maxFull = fvals[fvals.length - 1];
      if (this.quiet === 0 || medFull < this.quiet) this.quiet = medFull;
      else this.quiet += (medFull - this.quiet) * 0.003;
      // golv: över det nya ljudets median, över vilonivån, och minst 46 dB under den starkaste klingande tonen
      // (utan det räcker fönstrets sidolober – 70 dB under – som "nytt ljud" i en brusfri signal)
      const thr = Math.max(medDiff * Math.pow(10, this.thresholdDb() / 20), this.quiet * Math.pow(10, 12 / 20), maxFull * 0.005, 1e-7);
      const D0 = this.diff0 || (this.diff0 = new Float32Array(half));
      D0.set(D);   // det nya ljudet innan några toner tagits bort
      // toner som varit väntade nyligen: om de hörs först efter att appen gått vidare är de inte "oväntade"
      this.recentExpected = (this.recentExpected || []).filter(e => nowMs - e.t < 600);
      if (expected) this.recentExpected.push({ t: nowMs, set: expected });

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
        chosen.add(bp);
        this._cancel(D, bp);
        if (!this._risen(bp)) continue;    // bara en svängning i en ton som redan klingar
        if (own && own.has(bp)) continue;  // appens eget ljud
        // ligger toppen av det nya ljudet närmare en granntangent är det dess (breda) topp vi ser
        const s0 = this._salience(D0, bp);
        if (this._nearestPitch(D0, bp) !== bp) continue;
        const strength = 20 * Math.log10(bv / (medDiff + 1e-9));
        const exp = !!(expected && expected.has(bp));
        // en "ton" som ligger som en överton (eller en oktav under) till en ton som nyss slogs an, som appen
        // spelar, eller som har mer nytt ljud i samma ruta, är troligen bara den tonens deltoner
        // övertoner till appens eget ljud (medan det stiger) rapporteras aldrig – de är inte spelarens toner
        if (own && HARM.some(d => own.has(bp - d))) continue;
        if (!found.length) firstV = bv;
        found.push({ p: bp, strength, expected: exp, s0, bv, ghost: false, unexpected: false });
      }
      // Spöken och oväntade toner bedöms nerifrån och upp, så att en lägre ton med eget ljud gör den övre
      // till spöke – aldrig tvärtom (oktaven över en ton dyker ofta upp en ruta före tonen själv).
      found.sort((a, b) => a.p - b.p);
      for (const o of found) {
        // en ton som nyss slagits an, som väntas just nu, eller som har eget nytt ljud (inklusive egen
        // grundton) i samma ruta kan vara upphov till den här som överton
        const parent = q => q >= 0 && (found.some(f => f.p === q && !f.ghost) || nowMs - this.lastOnset[q] < 400 ||
          this.recentExpected.some(e => e.set.has(q)) || (!!this.bands[q] && this._salience(D0, q) >= 0.3 * o.s0));
        o.ghost = HARM.some(d => parent(o.p - d));
        // oväntad = en ny ton som varken väntats nyligen eller är en överton, och som hörs i tre analyser
        // i rad (en riktig ton stiger i 3–5 analyser; hammarsmällen ger falska kandidater i en eller två)
        const wasExpected = this.recentExpected.some(e => e.set.has(o.p));
        if (!wasExpected && !o.ghost) {
          const seen = (this.pendingUnexpected.get(o.p) || []).filter(t => nowMs - t < 200);
          seen.push(nowMs);
          this.pendingUnexpected.set(o.p, seen);
          o.unexpected = seen.length >= 3;
        }
        if (o.unexpected) { this.lastUnexpected = nowMs; this.recentUnexpected.set(o.p, nowMs); }
      }
      // En väntad ton en oktav (eller duodecim) ovanför en hörd ton döljs lätt av den lägre tonens
      // övertoner. Bara då räcker det med lite mindre energi i det som är kvar.
      if (expected && this.relaxed) {
        for (const p of expected) {
          if (chosen.has(p) || !this.bands[p]) continue;
          if (!(chosen.has(p - 12) || chosen.has(p - 19) || chosen.has(p - 24))) continue;
          const v = this._salience(D, p);
          if (v >= thr * 0.5 && v >= this._salience(D, p - 1) && v >= this._salience(D, p + 1) && this._risen(p)) {
            chosen.add(p);
            found.push({ p, strength: 20 * Math.log10(v / (medDiff + 1e-9)), expected: true });
          }
        }
      }

      // --- omslag: väntade, klingande toner jämförs före/efter smällen ---
      const pd = this.pending;
      if (pd && expected) {
        if (this.lastUnexpected >= pd.at - 100) pd.blocked = true;   // någon annan ton slogs an – då var det den
        if ((this.thumpTimes || []).length > 3) pd.blocked = true;   // många smällar i rad: tal, knackningar – inte pianospel
        if (nowMs - pd.at > this.winMs + 450 || pd.evals >= 3) this.pending = null;
        else if (nowMs - pd.at >= this.winMs + 20) {                 // den långa rutan ligger nu helt efter anslaget
          pd.evals++;
          const foundSet = new Set(found.map(o => o.p));
          // hur mycket mer än sin egen drift ändrades någon klingande fel tangent? (slogs den om igen?)
          let wrongExcess = -Infinity;
          for (const [p, w] of pd.wrongBefore) {
            if (this._salience(cur, p) < this.quiet * 4) continue;
            wrongExcess = Math.max(wrongExcess, this._stepDb(this._peaks(cur, p), w.b) - w.drift);
          }
          for (const [p, b] of pd.before) {
            if (foundSet.has(p) || pd.accepted.has(p) || !expected.has(p)) continue;
            if (this.lastOnset[p] >= pd.at - 50) continue;           // redan rapporterad för just det här anslaget
            if (nowMs - this.lastOnset[p] > 3500) continue;          // bara toner som nyss hörts slås an (klingar)
            if ([...pd.ownNear].some(q => PitchDetector._related(p, q))) continue;   // appens egen ton samtidigt kan ha ändrat den här
            if (this._salience(cur, p) < this.quiet * 4) continue;   // tonen måste höras
            const step = this._stepDb(this._peaks(cur, p), b);
            // rimlighetskontroll: något ska ha hänt med just den här tonen – och, om en fel tangent klingar,
            // mer utöver sin egen drift än vad den fel tangenten ändrades utöver sin. Hördes smällen samtidigt
            // som appen själv spelade en ton kan smällen vara appens: då krävs en ändring klart över driften.
            let need = this.stepDb;
            if (wrongExcess > -Infinity) need = Math.max(need, pd.drift.get(p) + Math.max(0, wrongExcess) + 0.5);
            if (pd.ownNear.size) need = Math.max(need, pd.drift.get(p) + 2.5);
            this.lastRestrikeEval.push({ p, step, need, drift: pd.drift.get(p), blocked: pd.blocked });
            if (!pd.blocked && step >= need) { pd.accepted.add(p); found.push({ p, strength: step, expected: true, restrike: true }); }
          }
        }
      }

      this.lastFound = found;   // alla kandidater som godkändes i den här analysen (för felsökning)
      const onsets = [];
      const seenNow = new Map();
      for (const o of found) {
        seenNow.set(o.p, nowMs);
        // en överton rapporteras bara om den väntas och har eget ljud kvar när den lägre tonens deltoner
        // räknats bort (en riktig oktav har det, en ren överton har det inte)
        if (o.ghost && !(o.expected && o.bv >= 0.25 * o.s0)) continue;
        // en ny ton stiger i flera analyser; det som bara syns i en enda är smällen eller en överton
        // som dök upp före sin grundton. Omslag (via smällen) är redan bedömda och rapporteras direkt.
        const prev = this.seenPrev.get(o.p);
        if (!o.restrike && !(prev !== undefined && nowMs - prev < 150)) continue;
        if (nowMs - this.lastOnset[o.p] > this.refractoryMs) { onsets.push(o); this.lastOnset[o.p] = nowMs; }
      }
      this.seenPrev = seenNow;
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
