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
// så ett lite ostämt piano fungerar. Dessutom lär sig detektorn pianot medan man spelar: varje väntad ton
// som hörs mäts, tangenten får en egen avvikelse, och hela stämningen följer medianen av de inlärda
// tangenterna. Väntade tangenter som inte lärts in ännu söks med bredare band, så att även en tangent som
// ligger 50–70 cent fel hittas första gången.
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
  const OWN_PARTIALS = new Set([1, 2, 3, 5]);           // deltoner med hörbar styrka i appens eget ljud (triangelvåg + sinus på dubbla frekvensen)

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
      this.pendings = [];             // hörda smällar som väntar på före/efter-jämförelse
      this.lastUnexpected = -1e9;     // när en oväntad ny ton senast hördes
      this.pendingUnexpected = new Map();   // oväntade kandidater som väntar på bekräftelse i nästa analys
      this.recentUnexpected = new Map();    // bekräftat oväntade toner (fel tangenter) som kan klinga ännu
      this.lastRestrikeEval = [];
      this.frames = 0;
      this.tune = 0;              // hela pianots stämning i cent (negativt = lågt stämt)
      this.tolCents = 45;         // hur mycket varje enskild ton får avvika
      this.wideCents = 75;        // sökbredd för väntade tangenter som inte lärts in ännu
      this.keyOff = new Float32Array(128);    // inlärd avvikelse per tangent (cent, utöver stämningen)
      this.keyConf = new Float32Array(128);   // hur många gånger tangenten mätts
      this.autoTune = true;       // låt hela stämningen följa de inlärda tangenterna
      this.onLearn = null;        // anropas när stämningen eller en tangent lärts om
      this.learnQueue = [];       // rapporterade väntade toner som ska mätas lite senare (när tonen fyllt rutan)
      this.joltHist = new Map();  // senaste ryck-mätningarna per väntad tangent
      this.frameMs = 50;          // uppmätt tid mellan analyserna (bekräftelsefönstren följer den)
      this.lastNow = NaN;
      this.sensitivity = 0.5;     // 0..1
      this.refractoryMs = 180;    // samma tangent rapporteras inte oftare än så
      this.riseDb = 4;            // en ny ton måste bli minst så här mycket starkare än den nyss var
      this.coherence = 0.6;       // ...i minst så stor (viktad) andel av sina hörbara deltoner samtidigt
      this.seenPrev = new Map();  // kandidater i förra analysen: en ton rapporteras först när den hörts två analyser i rad
      this.stepDb = 1.5;          // ett omslag måste ge minst så här stort steg i deltonerna
      this.relaxed = true;        // väntade toner en oktav över en hörd ton får lite mildare krav
      this.lo = 21; this.hi = 108;
      this.lastOnset = new Float64Array(128).fill(-1e9);    // när tangenten senast rapporterades
      this.lastStrike = new Float64Array(128).fill(-1e9);   // ungefär när det anslaget skedde
      this.lastMarked = new Float64Array(128).fill(-1e9);   // när appen senast sa att tangenten spelats (markPlayed)
      this.level = -120;
      this.quiet = 0;             // ljudnivå i vila (följer ner snabbt, upp långsamt)
      this.cur = this.ring[0];
      this._plan();
    }

    setRange(lo, hi) { this.lo = Math.max(21, lo); this.hi = Math.min(108, hi); this._plan(); }
    setTune(cents) { this.tune = cents; this._plan(); }
    // Glöm de inlärda tangenterna (t.ex. när stämningen ställs om för hand).
    resetKeys() { this.keyOff.fill(0); this.keyConf.fill(0); this._plan(); }
    // Inlärda tangenter som {tangent: cent}, för att sparas mellan gångerna – och läsas tillbaka.
    getKeyOffsets() {
      const o = {};
      for (let p = 0; p < 128; p++) if (this.keyConf[p] >= 1) o[p] = Math.round(this.keyOff[p] * 10) / 10;
      return o;
    }
    setKeyOffsets(o) {
      this.keyOff.fill(0); this.keyConf.fill(0);
      for (const k in o || {}) { const p = +k, c = +o[k]; if (p >= 0 && p < 128 && isFinite(c)) { this.keyOff[p] = Math.max(-60, Math.min(60, c)); this.keyConf[p] = 2; } }
      this._plan();
    }

    // Appen anropar detta när den vet att spelaren spelat tonen (t.ex. ett ackord som godkänts fast någon ton
    // inte hördes), så att tonen räknas som klingande och ett senare omslag av den kan bedömas.
    markPlayed(p, tMs) {
      if (p < 0 || p > 127) return;
      this.lastMarked[p] = tMs;
      // själva anslaget skedde en stund innan appen godkände händelsen
      if (tMs - 300 > this.lastOnset[p]) this.lastOnset[p] = tMs - 300;
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

    freq(p) { return 440 * Math.pow(2, (p - 69) / 12 + (this.tune + this.keyOff[p]) / 1200); }

    // Förberäknar vilka frekvensband varje tangents deltoner ligger i: normala band (tolerans) och breda
    // (för väntade tangenter som inte lärts in ännu).
    _plan() {
      this.bands = []; this.bandsW = []; this.nUse = []; this.sBands = [];
      for (let p = 0; p < 128; p++) this._planKey(p);
    }
    _planKey(p) {
      if (p < this.lo || p > this.hi) { this.bands[p] = null; this.bandsW[p] = null; this.sBands[p] = null; return; }
      this.bands[p] = this._bandList(p, this.tolCents);
      this.bandsW[p] = this._bandList(p, this.wideCents);
      this.nUse[p] = this.bands[p].filter(b => b.use).length;
      // samma deltoner i de korta rutornas grova upplösning (för att höra plötsliga förändringar)
      const sN = this.sN, sr = this.sr, tol = Math.pow(2, this.tolCents / 1200) - 1;
      this.sBands[p] = this.bands[p].filter(b => b.use).map(b => {
        const c = (b.a + b.b) / 2 * sN / this.N, t = Math.max(0.5, Math.min(2, c * tol));
        return { a: Math.max(1, Math.floor(c - t)), b: Math.min(sN / 2 - 1, Math.ceil(c + t)) };
      });
    }
    _bandList(p, tolCents) {
      const N = this.N, sr = this.sr, tol = Math.pow(2, tolCents / 1200) - 1;
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
      return list;
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

    _peaks(spec, p, all, wide) {
      const bands = wide ? this.bandsW[p] : this.bands[p], n = all ? bands.length : this.nUse[p], amps = new Float32Array(n);
      for (let j = 0; j < n; j++) amps[j] = PitchDetector._bandPeak(spec, bands[j].a, bands[j].b);
      return amps;
    }

    _salience(spec, p, wide) {
      if (!this.bands[p]) return 0;
      const amps = this._peaks(spec, p, false, wide);
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
    _cancel(spec, p, wide) {
      const bands = wide ? this.bandsW[p] : this.bands[p], amps = this._peaks(spec, p, true, wide);
      for (let j = 0; j < bands.length; j++) {
        const nb = j === 0 ? amps[0] : (amps[j - 1] + (amps[j + 1] !== undefined ? amps[j + 1] : amps[j - 1])) / 2;
        const take = j === 0 ? amps[0] : Math.min(amps[j], 2 * nb + 1e-9);
        for (let k = bands[j].ca; k <= bands[j].cb; k++) spec[k] = Math.max(0, spec[k] - take);
      }
    }

    thresholdDb() { return 24 - 12 * Math.min(1, Math.max(0, this.sensitivity)); }

    // Var ligger toppen av tangentens grundton (för bastoner: dess starkaste av de tre första deltonerna)
    // inom ±`cents` runt den väntade frekvensen? Returnerar {f: frekvens räknat om till grundton, snr} eller
    // null om ingen tydlig topp finns inne i området.
    _fundPeak(spec, p, cents, allowEdge) {
      const bands = this.bandsW[p];
      let j = 0;
      if (p < 48) {
        let best = 0;
        for (let k = 0; k < 3 && k < bands.length; k++) { const v = PitchDetector._bandPeak(spec, bands[k].a, bands[k].b); if (v > best) { best = v; j = k; } }
      }
      const h = bands[j].h, N = this.N, sr = this.sr;
      const fc = h * this.freq(p), k0 = Math.max(1, Math.floor(fc * Math.pow(2, -cents / 1200) * N / sr)), k1 = Math.min(N / 2 - 2, Math.ceil(fc * Math.pow(2, cents / 1200) * N / sr));
      let km = k0, sum = 0;
      for (let k = k0; k <= k1; k++) { sum += spec[k]; if (spec[k] > spec[km]) km = k; }
      if (spec[km] <= 0) return null;
      const edge = km === k0 || km === k1;
      if (edge && !allowEdge) return null;
      const a = spec[km - 1], b = spec[km], c = spec[km + 1], den = a - 2 * b + c;
      const shift = edge ? 0 : den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      return { f: (km + shift) * sr / N / h, snr: spec[km] / (sum / (k1 - k0 + 1) + 1e-12) };
    }

    // Vilken tangent ligger toppen av det nya ljudet närmast, inom ±1,5 halvton runt tonens grundton?
    // Ett anslags topp är bred i början, och då får bara den tangent som toppen ligger närmast räknas.
    // Grannarna jämförs med sina egna (inlärda) frekvenser.
    // `lenient` (väntad tangent som inte lärts in): toppen får ligga upp till 60 cent fel även om det råkar vara
    // närmare grannen – pianot kan vara stämt så lågt att varje ton ligger mitt emellan, och då avgör vad som väntas.
    _nearestPitch(spec, p, lenient) {
      const pk = this._fundPeak(spec, p, 150, true);
      if (!pk) return p;
      let best = p, bd = Math.abs(Math.log2(pk.f / this.freq(p)));
      if (lenient && bd * 1200 <= 60) return p;
      for (const q of [p - 1, p + 1]) {
        if (q < 0 || q > 127) continue;
        const d = Math.abs(Math.log2(pk.f / this.freq(q)));
        if (d < bd) { bd = d; best = q; }
      }
      return best;
    }

    // Lär in hur tangenten p verkligen är stämd, ur spektrumet `spec` (en ton som nyss hörts och klingar).
    _learn(spec, p) {
      if (!this.bands[p]) return false;
      if (this.ownOnsets.some(o => PitchDetector._related(p, o.p))) return false;   // appens eget ljud kan ligga i bandet
      const pk = this._fundPeak(spec, p, this.wideCents);
      if (!pk || pk.snr < 4) return false;
      const cents = Math.max(-this.wideCents, Math.min(this.wideCents, 1200 * Math.log2(pk.f / this.freq(p))));
      const c = this.keyConf[p], alpha = Math.max(0.25, 1 / (c + 1));
      this.keyOff[p] = Math.max(-60, Math.min(60, this.keyOff[p] + alpha * cents));
      this.keyConf[p] = Math.min(12, c + 1);
      this._planKey(p);
      if (this.autoTune) {
        // hela stämningen följer medianen av de inlärda tangenterna; de som inte lärts in följer med
        const learned = [];
        for (let q = 0; q < 128; q++) if (this.keyConf[q] >= 1) learned.push(q);
        if (learned.length >= 3) {
          const offs = learned.map(q => this.keyOff[q]).sort((a, b) => a - b);
          const med = offs[offs.length >> 1];
          if (Math.abs(med) >= 3) {
            this.tune += med;
            for (const q of learned) this.keyOff[q] -= med;
            this._plan();
          }
        }
      }
      if (this.onLearn) this.onLearn();
      return true;
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

    // Vilka av tangentens deltoner delar band med någon av tangenterna i `own` (appens egna toner)?
    // Returnerar en mängd index, eller null om ingen.
    _ownMask(p, own, wide) {
      const bands = wide ? this.bandsW[p] : this.bands[p];
      if (!bands) return null;
      let m = null;
      for (const q of own) {
        const qb = this.bands[q];
        if (!qb) continue;
        for (let j = 0; j < this.nUse[p]; j++) {
          const a = bands[j].a, b = bands[j].b;
          if (qb.some(o => OWN_PARTIALS.has(o.h) && o.a <= b && o.b >= a)) (m || (m = new Set())).add(j);
        }
      }
      return m;
    }

    // Plötslig förändring (dB) i tangentens deltoner mellan den korta rutan j (där smällen hördes) och rutan
    // två steg före (43 ms tidigare, helt före anslaget). En svävning eller utklingning ändrar inget på 43 ms;
    // ett anslag ändrar de flesta deltonerna med en gång (upp eller ner, beroende på fas).
    // Deltoner nära någon av appens egna toner (`own`) räknas inte – de korta rutorna är grova (23 Hz).
    _jolt(p, own) {
      const sb = this.sBands[p];
      if (!sb) return 0;
      const use = sb.filter(bd => !(own && [...own].some(q => { const qb = this.bands[q]; return qb && qb.some(o => { if (!OWN_PARTIALS.has(o.h)) return false; const c = (o.a + o.b) / 2 * this.sN / this.N; return c >= bd.a - 2 && c <= bd.b + 2; }); })));
      if (!use.length) return 0;
      let best = 0;
      for (let j = 0; j + 2 < S_FRAMES; j++) {   // anslaget kan ligga i vilken som helst av de tre nyaste rutorna
        const A = this.sSpec[j], B = this.sSpec[j + 2];
        let s = 0, w = 0;
        for (let k = 0; k < use.length; k++) {
          let a = 0, b = 0;
          for (let i = use[k].a; i <= use[k].b; i++) { if (A[i] > a) a = A[i]; if (B[i] > b) b = B[i]; }
          const amp = Math.max(a, b);
          if (amp <= 0) continue;
          const wt = W[k] * amp;
          s += wt * Math.min(20, Math.abs(20 * Math.log10((a + 1e-7) / (b + 1e-7))));
          w += wt;
        }
        if (w > 0 && s / w > best) best = s / w;
      }
      return best;
    }

    // Genomsnittlig förändring (dB, oavsett riktning) i tonens deltoner mellan två rutor,
    // viktad med deltonernas styrka så att deltoner som klingat ut (brus) inte påverkar.
    // `mask` = deltoner som inte ska räknas (appens eget ljud ligger där).
    _stepDb(a, b, mask) {
      let s = 0, w = 0;
      for (let j = 0; j < a.length; j++) {
        if (mask && mask.has(j)) continue;
        const amp = Math.max(a[j], b[j]);
        if (amp <= 0) continue;
        const wt = W[j] * amp;
        s += wt * Math.min(20, Math.abs(20 * Math.log10((a[j] + 1e-7) / (b[j] + 1e-7))));   // en delton som saknas före/efter får inte dominera
        w += wt;
      }
      return w > 0 ? s / w : 0;
    }

    // Har tonen p blivit tydligt starkare än den var i baslinjen – totalt, i grundtonen och i de flesta
    // deltonerna samtidigt? `wide` = använd de breda banden. `noFund` = grundtonens band räknas inte (där
    // ligger en delton av appens eget ljud); då måste övertonerna själva bära beviset.
    _risen(p, wide, noFund) {
      const a = this._peaks(this.cur, p, false, wide), b = this._peaks(this.base, p, false, wide);
      const j0 = noFund ? 1 : 0;
      let mx = 0, sa = 0, sb = 0;
      for (let j = j0; j < a.length; j++) { if (a[j] > mx) mx = a[j]; sa += W[j] * a[j]; sb += W[j] * b[j]; }
      const need = Math.pow(10, this.riseDb / 20);
      if (sa < sb * need) return false;
      const needPart = Math.pow(10, (this.riseDb - 1) / 20);
      const fund = p < 48 ? Math.max(a[0], a[1] || 0, a[2] || 0) : a[0];
      const fundB = p < 48 ? Math.max(b[0], b[1] || 0, b[2] || 0) : b[0];
      if (noFund) {
        if (a.length < 3 || sa < 0.15 * a[0]) return false;   // övertonerna måste vara en rimlig del av det som hörs i grundtonsbandet
      } else if (fund < fundB * needPart) return false;
      let wUp = 0, wAll = 0, nAud = 0;
      for (let j = j0; j < a.length; j++) {
        if (a[j] < 0.05 * mx) continue;      // deltoner som inte hörs räknas inte
        if (j > 0 && b[j] > fundB) continue; // bandet var redan starkare än grundtonen: en annan ton klingar där, säger inget
        wAll += W[j]; nAud++;
        if (a[j] >= b[j] * needPart) wUp += W[j];
      }
      if (noFund && nAud < 2) return false;
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
      // hur tätt analyserna kommer (en långsam iPad hinner färre): bekräftelsefönstren följer det
      if (!isNaN(this.lastNow)) { const d = Math.max(20, Math.min(400, nowMs - this.lastNow)); this.frameMs += (d - this.frameMs) * 0.1; }
      this.lastNow = nowMs;
      const confirmMs = Math.max(150, 2.6 * this.frameMs);
      if (fr < BASE_TO || this.level < -62) return [];
      // toner som rapporterats nyss mäts nu, när de hunnit fylla rutan: så lär sig detektorn pianots stämning
      this.ownOnsets = this.ownOnsets.filter(o => nowMs - o.t < 1500);
      for (let i = this.learnQueue.length - 1; i >= 0; i--) {
        const q = this.learnQueue[i];
        if (nowMs < q.t) continue;
        this.learnQueue.splice(i, 1);
        if (nowMs - q.t < 300 && this._salience(cur, q.p, this.keyConf[q.p] < 2) >= this.quiet * 4) this._learn(cur, q.p);
      }
      // väntade tangenter som inte lärts in ännu söks med bredare band
      const wideFor = p => !!(expected && expected.has(p)) && this.keyConf[p] < 2;

      // --- anslag (smäll) i korta rutor ---
      const th = this._thump(samples);
      this.lastThumpRatio = th.ratio;
      const msPer = 1000 / this.sr;
      // rycket i varje väntad tons deltoner mäts i varje analys och sparas en stund: smällen kan höras först
      // en analys eller två efter anslaget (en klingande ton döljer den), och då har de korta rutorna redan
      // passerat själva ögonblicket. Analyser nära appens egna anslag utelämnas (de rycker i egna band).
      if (expected) {
        const nearOwn = this.ownOnsets.some(o => Math.abs(o.t - nowMs) < 120);
        for (const p of expected) {
          if (!this.bands[p]) continue;
          const h = (this.joltHist.get(p) || []).filter(e => nowMs - e.t < 400);
          if (!nearOwn) h.push({ t: nowMs, v: this._jolt(p, null) });
          this.joltHist.set(p, h);
        }
      }
      if (th.ratio >= this.thumpRatio && nowMs >= this.ignoreThumpUntil) {
        const at = nowMs - (th.j * this.sHop + this.sN / 2) * msPer;   // ungefärlig tidpunkt för anslaget
        // samma anslag syns i flera analyser i rad – räkna det en gång. Ett nytt anslag strax efter ett annat
        // (t.ex. spelarens strax efter appens egen ton) får en egen bedömning.
        this.thumpAts = (this.thumpAts || []).filter(t => nowMs - t < 1500);
        const fresh = !this.thumpAts.some(t => Math.abs(t - at) < 80);
        this.lastThump = nowMs;
        if (fresh) this.thumpAts.push(at);
        this.thumpTimes = this.thumpAts;
        // före/efter-jämförelsen sätts upp bara första gången smällen hörs – senare analyser ser samma
        // anslag igen, och deras "före"-ruta skulle redan innehålla det
        if (fresh && expected && expected.size) {
          const ownNear = new Set(this.ownOnsets.filter(o => at >= o.t - 40 && at <= o.t + 130).map(o => o.p));
          const ownNow = new Set(this.ownOnsets.filter(o => Math.abs(o.t - at) <= 60).map(o => o.p));   // i själva anslagsögonblicket (de korta rutorna)
          // nyaste långa rutan som slutar före anslaget, och en som slutar ett fönster tidigare (för driften)
          let bi = -1, di = -1;
          for (let k = 1; k < RING && fr - k >= 0; k++) {
            const idx = fr - k, T = this.ringT[idx % RING];
            if (bi < 0 && T <= at) bi = idx;
            if (bi >= 0 && T <= at - this.winMs) { di = idx; break; }
          }
          if (bi >= 0) {
            const before = new Map(), drift = new Map(), wrongBefore = new Map(), jolt = new Map(), ringing = new Map();
            for (const p of expected) {
              if (!this.bands[p]) continue;
              const w = wideFor(p), b = this._peaks(this.ring[bi % RING], p, false, w);
              before.set(p, b);
              drift.set(p, di >= 0 ? this._stepDb(b, this._peaks(this.ring[di % RING], p, false, w)) : 0);
              let jv = this._jolt(p, ownNow.size ? ownNow : null);
              for (const e of this.joltHist.get(p) || []) if (e.t >= at - 100 && e.v > jv) jv = e.v;
              jolt.set(p, jv);
              ringing.set(p, this._salience(this.ring[bi % RING], p, w) >= this.quiet * 4);   // klingade tonen redan före anslaget?
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
            this.pendings.push({ at, before, drift, wrongBefore, ownNear, ownNow, jolt, ringing, evals: 0, accepted: new Set(), blocked: false });
            if (this.pendings.length > 4) this.pendings.shift();
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
      for (let p = this.lo; p <= this.hi; p++) { dvals.push(this._salience(D, p, wideFor(p))); fvals.push(this._salience(cur, p)); }
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
      const trace = this.debug ? (this.trace = []) : null;   // felsökning: alla kandidater och varför de föll bort
      if (trace) this.traceThr = thr;
      for (let it = 0; it < MAX_NOTES; it++) {
        let bp = -1, bv = 0;
        for (let p = this.lo; p <= this.hi; p++) {
          if (chosen.has(p)) continue;
          const v = this._salience(D, p, wideFor(p));
          if (v > bv) { bv = v; bp = p; }
        }
        if (bp < 0 || bv < thr || (found.length && bv < firstV * 0.12)) { if (trace && bp >= 0) trace.push({ p: bp, bv, why: bv < thr ? 'under golvet' : 'svag mot första' }); break; }
        chosen.add(bp);
        const wide = wideFor(bp);
        this._cancel(D, bp, wide);
        if (own && own.has(bp)) { if (trace) trace.push({ p: bp, bv, why: 'egen' }); continue; }  // appens eget ljud
        const exp = !!(expected && expected.has(bp));
        // en överton till appens eget ljud (medan det stiger) är inte spelarens ton. Men väntas tangenten kan
        // spelaren ha slagit an den samtidigt: då måste övertonerna, där iPadens ljud inte ligger, själva ha stigit
        const overOwn = !!own && HARM.some(d => own.has(bp - d));
        if (overOwn && !exp) { if (trace) trace.push({ p: bp, bv, why: 'överton till egen' }); continue; }
        if (!this._risen(bp, wide, overOwn)) { if (trace) trace.push({ p: bp, bv, why: 'ej stigit' + (overOwn ? ' (utan grundton)' : '') }); continue; }    // bara en svängning i en ton som redan klingar
        // ligger toppen av det nya ljudet närmare en granntangent är det dess (breda) topp vi ser
        const s0 = this._salience(D0, bp, wide);
        if (this._nearestPitch(D0, bp, wide) !== bp) { if (trace) trace.push({ p: bp, bv, why: 'närmare granne' }); continue; }
        if (trace) trace.push({ p: bp, bv, why: 'ok' });
        const strength = 20 * Math.log10(bv / (medDiff + 1e-9));
        if (!found.length) firstV = bv;
        found.push({ p: bp, strength, expected: exp, s0, bv, ghost: false, unexpected: false, overOwn });
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
          const seen = (this.pendingUnexpected.get(o.p) || []).filter(t => nowMs - t < Math.max(200, 3.6 * this.frameMs));
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
          const w = wideFor(p), v = this._salience(D, p, w);
          if (v >= thr * 0.5 && v >= this._salience(D, p - 1) && v >= this._salience(D, p + 1) && this._risen(p, w, !!own && HARM.some(d => own.has(p - d)))) {
            chosen.add(p);
            found.push({ p, strength: 20 * Math.log10(v / (medDiff + 1e-9)), expected: true });
          }
        }
      }

      // --- omslag: väntade, klingande toner jämförs före/efter smällen (en bedömning per hörd smäll) ---
      for (let pi = this.pendings.length - 1; pi >= 0; pi--) {
        const pd = this.pendings[pi];
        if (!expected) { this.pendings.splice(pi, 1); continue; }
        if (this.lastUnexpected >= pd.at - 100) pd.blocked = 'fel ton';   // någon annan ton slogs an – då var det den
        if ((this.thumpTimes || []).length > 6) pd.blocked = 'många smällar';   // många smällar i rad: tal, knackningar – inte pianospel
        if (nowMs - pd.at > this.winMs + 450 || pd.evals >= 3) this.pendings.splice(pi, 1);
        else if (nowMs - pd.at >= this.winMs + 20) {                 // den långa rutan ligger nu helt efter anslaget
          pd.evals++;
          const foundSet = new Set(found.map(o => o.p));
          // appens egna toner som börjat mellan smällen och nu ligger i "efter"-rutan: deras band räknas inte
          const ownSince = new Set(this.ownOnsets.filter(o => o.t >= pd.at - 40 && o.t <= nowMs).map(o => o.p));
          // hur mycket mer än sin egen drift ändrades någon klingande fel tangent? (slogs den om igen?)
          let wrongExcess = -Infinity;
          for (const [p, w] of pd.wrongBefore) {
            if (this._salience(cur, p) < this.quiet * 4) continue;
            wrongExcess = Math.max(wrongExcess, this._stepDb(this._peaks(cur, p), w.b) - w.drift);
          }
          const skip = (p, why) => { if (this.debug) this.lastRestrikeEval.push({ p, skipped: why }); };
          for (const [p, b] of pd.before) {
            if (foundSet.has(p) || pd.accepted.has(p) || !expected.has(p)) continue;
            if (Math.abs(this.lastStrike[p] - pd.at) < 250) { skip(p, 'samma anslag'); continue; }   // redan rapporterad för just det här anslaget
            // appen godkände nyss en händelse med den här tonen utan att tonen hördes: anslaget strax före det
            // var den tonen, och får inte rapporteras i efterhand (det skulle räknas för nästa händelse)
            if (this.lastStrike[p] < this.lastMarked[p] - 600 && pd.at >= this.lastMarked[p] - 600 && pd.at <= this.lastMarked[p] + 50) { skip(p, 'nyss godkänd ohörd'); continue; }
            // slog spelaren an en annan, harmoniskt släkt tangent i samma ögonblick (oktaven, duodeciman …) förklarar
            // den förändringen i den här tonens deltoner
            if (found.some(o => o.p !== p && !o.ghost && !o.restrike && PitchDetector._related(p, o.p))) { skip(p, 'släkt ton slagen'); continue; }
            let relatedStruck = false;
            for (let q = Math.max(0, p - 40); q <= Math.min(127, p + 40); q++) if (q !== p && Math.abs(this.lastStrike[q] - pd.at) < 150 && PitchDetector._related(p, q)) relatedStruck = true;
            if (relatedStruck) { skip(p, 'släkt ton slagen'); continue; }
            // appens egna toner som börjat under jämförelsen (ofta melodin en oktav ovanför basen): de deltoner
            // där de ligger räknas inte, resten måste räcka
            // har en granntangent (fel ton) börjat höras sedan smällen, även om den inte bekräftats ännu, är det
            // troligen den som slogs an – dess ljud spiller över i den här tonens band
            let neighbour = false;
            for (const [q, ts] of this.pendingUnexpected) if (q !== p && Math.abs(q - p) <= 2 && ts.filter(t => t >= pd.at - 50).length >= 2) neighbour = true;
            if (neighbour) { skip(p, 'granne hörd'); continue; }
            const w = wideFor(p), mask = ownSince.size ? this._ownMask(p, ownSince, w) : null;
            if (mask && b.length - mask.size < 2) { skip(p, 'egen ton överallt'); continue; }   // för lite kvar att döma på
            if (this._salience(cur, p, w) < this.quiet * 4) { skip(p, 'hörs inte'); continue; }   // tonen måste höras
            if (this._nearestPitch(cur, p, w) !== p) { skip(p, 'närmare granne'); continue; }   // det som hörs är en granntangent
            const after = this._peaks(cur, p, false, w), step = this._stepDb(after, b, mask), jolt = pd.jolt.get(p);
            // Driften (tonens egen förändring över en ruta) är opålitlig om tonen själv slogs an alldeles nyss –
            // då innehöll jämförelserutorna anslaget; en färsk ton svävar ändå lite i början.
            const fresh = pd.at - Math.max(this.lastStrike[p], this.lastMarked[p] - 300) < 750;
            // (en mycket stor drift är en svävningsnoll i en av rutorna, inte en trend – räknas bara till en gräns)
            const driftEst = fresh ? Math.min(pd.drift.get(p), 2) : Math.min(pd.drift.get(p), 6);
            // Ett anslag av just den här tangenten ger ett ryck i dess deltoner på 43 ms; svävning, utklingning
            // och andra tangenters anslag gör det inte. Började appen en egen ton samtidigt krävs ett tydligare ryck.
            // Utan tydligt ryck måste steget dessutom överskrida tonens egen drift. Klingar en fel tangent måste
            // den här tonen ha ändrats mer utöver sin drift än den fel tangenten utöver sin.
            let need = this.stepDb;
            if (jolt < 3) need = Math.max(need, driftEst + 0.5);
            if (wrongExcess > -Infinity) need = Math.max(need, driftEst + Math.max(0, wrongExcess) + 0.5);
            let needJolt = pd.ownNow.size ? 2.5 : 1.5;   // började appen en egen ton i samma ögonblick krävs ett tydligare ryck
            // klingade tonen inte före anslaget är det en ny ton som det vanliga spåret borde ha hört; här är den
            // reservutgången (t.ex. när grundtonen döljs av appens eget ljud), med höga krav: tyst -> ton är stort
            if (!pd.ringing.get(p)) { need = Math.max(need, 6); needJolt = Math.max(needJolt, 3); }
            this.lastRestrikeEval.push({ p, step, need, jolt, needJolt, drift: pd.drift.get(p), fresh, blocked: pd.blocked, mask: mask ? [...mask] : [], own: [...ownSince], before: Array.from(b), after: Array.from(after) });
            if (!pd.blocked && step >= need && jolt >= needJolt) {
              pd.accepted.add(p);
              // andra smällar mellan den här och nu hör till samma händelse (t.ex. appens egen ton strax före
              // spelarens anslag): de får inte rapportera tonen en gång till
              for (const q of this.pendings) if (q !== pd && q.at > pd.at && q.at <= nowMs) q.accepted.add(p);
              found.push({ p, strength: step, expected: true, restrike: true, at: pd.at });
            }
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
        if (!o.restrike && !(prev !== undefined && nowMs - prev < confirmMs)) continue;
        // en ton som rapporterats nyss kan bara rapporteras igen (som ny ton) om det hörts ett anslag sedan dess:
        // annars är det samma ton som fortsätter stiga medan rutan fylls
        if (!o.restrike && nowMs - this.lastOnset[o.p] < 700 && this.lastThump <= this.lastOnset[o.p]) continue;
        if (nowMs - this.lastOnset[o.p] > this.refractoryMs) {
          onsets.push(o); this.lastOnset[o.p] = nowMs;
          this.lastStrike[o.p] = o.restrike ? o.at : prev - 60;   // en ny ton syns första gången ca en analys efter anslaget
          if (o.expected) this.learnQueue.push({ p: o.p, t: nowMs + 150 });   // mäts strax, när tonen fyllt rutan
        }
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
