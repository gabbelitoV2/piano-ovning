// Simulering av vänta-läget mot ett syntetiskt piano (ostämda unisonsträngar, pedal, upprepade toner,
// ackompanjemang från appen). Mäter händelser som godkänns utan spel, som fastnar, och fel toner som godkänns.
// Simulerar vänta-läget med ett "riktigt" piano: ostämda unisonsträngar (svävningar), lång efterklang,
// upprepade toner, och en spelare som bara spelar när appen väntar.
// Mäter: händelser som godkändes utan att spelaren spelat (= buggen), och händelser som aldrig godkändes.
const fs = require('fs');
// Körs med: MIDI=sökväg/till/låt.mid node dev/test_wait.js   (valfritt: HAND=R|L START=n NEV=n BEAT=cent WRONG=1 HAMMER=x ACC_ATTACK=samples DEBUG=1|2|3)
const path = require('path');
require(path.join(__dirname, '..', 'midi.js')); require(process.env.DET ? path.resolve(process.env.DET) : path.join(__dirname, '..', 'detector.js'));   // DET=annan detector.js att jämföra med
if (!process.env.MIDI) { console.error('Ange MIDI=<fil.mid>'); process.exit(1); }
const SR = 48000;
const BEAT = +(process.env.BEAT || 2.5);
const HAMMER = process.env.HAMMER === undefined ? 1 : +process.env.HAMMER;   // hammarsmällens styrka
// Ostämt piano: GLOBAL = hela pianots stämning (cent), KEYDEV = största avvikelse per tangent utöver det (cent,
// slumpad men fast per tangent), TUNE = stämningen appen fått veta (standard: GLOBAL, dvs. "Stäm av" är gjord),
// INH = skalning av strängarnas inharmonicitet, HPF = mikrofonens basbortfall (Hz, 2:a ordningens högpass)
const GLOBAL = process.env.GLOBAL === undefined ? -30 : +process.env.GLOBAL;
const KEYDEV = +(process.env.KEYDEV || 0), INH = +(process.env.INH || 1), HPF = +(process.env.HPF || 0);
const TUNE = process.env.TUNE === undefined ? GLOBAL : +process.env.TUNE;
const strikes = [];   // tider för alla riktiga anslag i ljudet   // cent mellan unisonsträngarna (svävning)
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let seed2 = 7; const rnd2 = () => (seed2 = (seed2 * 48271) % 2147483647) / 2147483647;
const keyDev = new Float64Array(128);
for (let p = 0; p < 128; p++) keyDev[p] = (rnd2() - 0.5) * 2 * KEYDEV;

// iPadens eget ljud (appens synt): triangelvåg (udda deltoner 1/h²) + sinus på dubbla frekvensen, lågpass som
// sjunker från f·(3+7k) till 2,2f, 60 ms mjuk ansats. Inga jämna deltoner utöver den andra – det är det som
// gör att spelarens oktav ovanför kan höras på sina egna övertoner.
function addSynth(buf, t0, p, vel, amp) {
  const f0 = 440 * 2 ** ((p - 69) / 12), k = Math.min(1, vel / 127), i0 = Math.round(t0 * SR);
  const decay = Math.max(0.5, 2.6 - (p - 36) / 60 * 1.9), n = Math.round(Math.min(3, decay * 2) * SR);
  const fc0 = Math.min(10000, f0 * (3 + 7 * k)), fc1 = Math.min(6000, f0 * 2.2);
  const parts = [[1, 1], [2, 0.35], [3, 1 / 9], [5, 1 / 25], [7, 1 / 49], [9, 1 / 81]];
  for (const [h, a] of parts) {
    const f = h * f0; if (f > SR * 0.45) break;
    const w = 2 * Math.PI * f / SR, ph = rnd() * 6.28;
    for (let j = 0; j < n && i0 + j < buf.length; j++) {
      const t = j / SR;
      const fc = fc1 + (fc0 - fc1) * Math.exp(-t / 0.5), lp = 1 / Math.sqrt(1 + (f / fc) ** 2);
      const env = Math.min(1, t / 0.06) * (t < 0.06 ? 1 : 0.4 + 0.6 * Math.exp(-(t - 0.06) / 0.22)) * Math.exp(-Math.max(0, t - 0.35) / decay);
      buf[i0 + j] += amp * a * lp * env * Math.sin(w * j + ph);
    }
  }
}

// Varje ton = 2–3 strängar som är lite olika stämda -> svävning. Lång efterklang (pedal nere).
function addNote(buf, t0, p, vel, detune, keyDur, pedal, opts) {
  opts = opts || {}; const attack = opts.attack || 200, hammer = opts.hammer === undefined ? HAMMER : opts.hammer;
  if (opts.synth) { addSynth(buf, t0, p, vel, 0.07 * (vel / 127) ** 1.2); strikes.push(t0); return; }
  const base = 440 * 2 ** ((p - 69) / 12 + detune / 1200);
  const B = INH * Math.min(2e-3, Math.max(5e-5, 1.2e-4 * 2 ** ((p - 48) / 12)));
  const amp = 0.07 * (vel / 127) ** 1.2;
  const tau0 = Math.max(0.5, 3.5 - (p - 36) / 60 * 2.8);
  const len = Math.min(pedal ? 4.0 : 2.5, (pedal ? 4.0 : keyDur) + 0.6);
  const i0 = Math.round(t0 * SR), n = Math.round(len * SR);
  const nStr = p < 40 ? 1 : p < 52 ? 2 : 3;
  for (let s = 0; s < nStr; s++) {
    const f0 = base * 2 ** (((rnd() - 0.5) * 6 + (s - (nStr - 1) / 2) * BEAT) / 1200);   // strängar 2–3 cent isär
    for (let h = 1; h <= 14; h++) {
      const f = h * f0 * Math.sqrt(1 + B * h * h); if (f > SR * 0.45) break;
      const A = (p < 48 ? [0.3, 1, 0.8, 0.65, 0.5, 0.42, 0.35, 0.28, 0.22, 0.18, 0.14, 0.11, 0.09, 0.07][h - 1] : 1 / h ** 1.25) * amp / nStr;
      const tau = tau0 / (1 + 0.3 * (h - 1)), w = 2 * Math.PI * f / SR, ph = rnd() * 6.28;
      for (let k = 0; k < n && i0 + k < buf.length; k++) {
        const t = k / SR;
        let env = Math.min(1, k / attack) * Math.exp(-t / tau);
        if (!pedal && t > keyDur) env *= Math.exp(-(t - keyDur) / 0.1);
        buf[i0 + k] += A * env * Math.sin(w * k + ph);
      }
    }
  }
  strikes.push(t0);
  for (let k = 0; k < 700 && i0 + k < buf.length; k++) buf[i0 + k] += (rnd() - 0.5) * 0.05 * hammer * (vel / 127) * Math.exp(-k / 180);
}

const mbuf = fs.readFileSync(process.env.MIDI);
const song = PianoMidi.buildSong(PianoMidi.parseMidi(mbuf.buffer.slice(mbuf.byteOffset, mbuf.byteOffset + mbuf.length)));
const HAND = process.env.HAND || 'R', TEMPO = 0.7, PEDAL = process.env.PEDAL !== '0';
const pianoTune = p => GLOBAL + keyDev[p];   // spelarens piano; iPadens eget ljud är rent stämt
const START = +(process.env.START || 0), NEV = +(process.env.NEV || 40);
const hand = song.notes.filter(n => n.h === HAND);
const other = song.notes.filter(n => n.h !== HAND);
const evs = [];
for (const n of hand) { const e = evs[evs.length - 1]; if (e && Math.abs(e.t - n.s) < 0.03) e.ps.add(n.p); else evs.push({ t: n.s, ps: new Set([n.p]) }); }
const sel = evs.slice(START, START + NEV);

// Spelaren: spelar den väntade händelsen 450 ms efter att appen börjat vänta – eller, med EARLY=sekunder, i takt
// med musiken: så många sekunder (±0,15) innan appen når händelsen. Hörs inte tonen slår spelaren an den en gång
// till efter RETRY sekunder ("andra anslag" – det är de gånger appen "inte reagerar").
// Appen: går i tempo mellan händelserna, väntar vid varje händelse tills alla (eller nästan alla) toner hörts.
const OLDAPP = process.env.OLDAPP === '1';   // appens äldre tidslogik (förtrycksfönster 0,35 s, alla tryck glöms, ingen fördröjningskompensation)
const REACT = 0.45, PRE_WINDOW = +(process.env.PRE || (OLDAPP ? 0.35 : 0.6)), CLEAR = process.env.CLEAR !== '0', LENIENT = process.env.LENIENT !== '0';
const EARLY = +(process.env.EARLY || 0), RETRY = +(process.env.RETRY || 1.2), KEEP = OLDAPP ? -1 : 0.15, LAT = OLDAPP ? 0 : 0.15, LAT_RESTRIKE = OLDAPP ? 0 : 0.45;
const ACC_GAIN = +(process.env.ACC_GAIN || 1);
const hop = 2400;   // 50 ms
const det = new PianoDetector.PitchDetector(SR, process.env.N ? { fftSize: +process.env.N } : {});
if (process.env.RISE) det.riseDb = +process.env.RISE;
if (process.env.DEBUG === '4' || process.env.DEBUG === '5') det.debug = true;
if (process.env.THUMP) det.thumpRatio = +process.env.THUMP;
const thumpAt = [], thumpQuiet = [], accompAt = [], playerStrikes = [], thumpTimes = [], playerStrikeNotes = [];
const evTrue = [], evFalse = [], accompNotes = [], wrongStrikes = [];
const WRONG = process.env.WRONG === '1';   // spelaren tar först fel ton, sedan rätt
let playedRight = false, wrongAccepted = 0; det.setRange(33, 96); det.setTune(TUNE);
if (process.env.SENS) det.sensitivity = +process.env.SENS;
const audio = new Float32Array(SR * 400);
for (let i = 0; i < audio.length; i++) audio[i] = (rnd() - 0.5) * 0.004;
// mikrofonens basbortfall: högpassfiltrerad kopia som fylls på allt eftersom (ljudet skrivs bara framåt i tiden)
const micAudio = HPF ? new Float32Array(audio.length) : audio;
let filtTo = 0, hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
const hw = Math.tan(Math.PI * HPF / SR), hq = Math.SQRT1_2, hn = 1 / (1 + hw / hq + hw * hw);
const hb0 = hn, hb1 = -2 * hn, hb2 = hn, ha1 = 2 * (hw * hw - 1) * hn, ha2 = (1 - hw / hq + hw * hw) * hn;
function filterTo(end) {
  if (!HPF) return;
  for (let i = filtTo; i < end; i++) {
    const x = audio[i], y = hb0 * x + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
    hx2 = hx1; hx1 = x; hy2 = hy1; hy1 = y; micAudio[i] = y;
  }
  filtTo = Math.max(filtTo, end);
}
// ackompanjemang (andra handen) spelas av "iPaden" i takt: läggs in i ljudet när tiden passerar
const pressId = new Uint32Array(128), consumed = new Uint32Array(128), pressT = new Float64Array(128);
let seq = 0, songT = sel[0].t - 1.0, real = 1.0, idx = 0, waiting = false, waitSince = 0, played = false;
let autoOK = 0, playedOK = 0, stuck = 0, skipped = 0;
const log = [];
let nextAudio = 1.0;   // tid i ljudet fram till vilken noter lagts in
const otherQ = other.filter(n => n.s >= sel[0].t - 1 && n.s < sel[sel.length - 1].t + 1).sort((a, b) => a.s - b.s);
let oq = 0;
function scheduleOther(toSong, realAt) {
  while (oq < otherQ.length && otherQ[oq].s <= toSong) {
    const n = otherQ[oq++];
    // ACC_SYNTH=0: ackompanjemanget låter som ett (pianoliknande) piano i stället för appens synt
    if (process.env.ACCOMP !== '0') { const at = realAt + (n.s - toSong) / TEMPO; addNote(audio, at, n.p, n.v * 0.8 * ACC_GAIN, +(process.env.ACC_TUNE || 0), (n.e - n.s) / TEMPO, false, { attack: +(process.env.ACC_ATTACK || 1200), hammer: 0, synth: process.env.ACC_SYNTH !== '0' }); accompAt.push(at); accompNotes.push({ t: at, p: n.p }); }
  }
}
function satisfied(ev, got) {
  if (got.size >= ev.ps.size) return true;
  if (!LENIENT) return false;
  const missing = [...ev.ps].filter(p => !got.has(p));
  if (missing.length !== 1) return false;
  return ev.ps.size >= 3 || [...got].some(q => Math.abs(q - missing[0]) % 12 === 0);
}
let got = new Set();
const dt = hop / SR;
let retries = 0, secondStrikes = 0, earlyT = EARLY > 0 ? Math.max(0, EARLY + (rnd() - 0.5) * 0.3) : 0, lastLat = LAT;
function strike(ev, label) {
  if (process.env.DEBUG) console.log(`  ${real.toFixed(2)}s ${label} [${[...ev.ps]}]`);
  for (const p of ev.ps) addNote(audio, real, p, 85 + rnd() * 30, pianoTune(p) + (rnd() - 0.5) * 4, 0.5, PEDAL);
  playedRight = true; playerStrikes.push(real); for (const p of ev.ps) playerStrikeNotes.push({ t: real, p });
}
function nextEvent() {
  idx++; got = new Set(); played = false; retries = 0; earlyT = EARLY > 0 ? Math.max(0, EARLY + (rnd() - 0.5) * 0.3) : 0;
  if (CLEAR) for (let p = 0; p < 128; p++) if (real - pressT[p] > KEEP) consumed[p] = pressId[p];
}
while (idx < sel.length && real < 380) {
  const ev = sel[idx];
  // framåt i tiden
  const realNow = real;
  const samplesEnd = Math.round(real * SR);
  if (samplesEnd >= det.N) {
    const exp = (waiting || (ev.t - songT) / TEMPO < 0.6) ? ev.ps : null;
    for (const n of accompNotes) if (n.t <= real && real - n.t < dt + 1e-6) det.markOwnOnset(n.t * 1000, n.p);
    const own = new Set(accompNotes.filter(n => n.t <= real && real - n.t < 0.5).map(n => n.p));
    filterTo(samplesEnd);
    const ons = det.analyze(micAudio.subarray(samplesEnd - det.N, samplesEnd), real * 1000, exp, own);
    if (det.lastThump === real * 1000) thumpTimes.push(real);
    if (process.env.DEBUG === '3') for (const o of (det.lastFound || []).filter(o => o.unexpected)) {
      const acc = accompNotes.filter(n => Math.abs(n.t - real) < 0.6).map(n => n.p + '@' + (n.t - real).toFixed(2)); const pl = playerStrikeNotes.filter(n => real - n.t >= 0 && real - n.t < 1.5).map(n => n.p + '@' + (n.t - real).toFixed(2));
      console.log(`    ${real.toFixed(2)}s OVÄNTAD ${o.p} | ackomp [${acc}] | spelaren [${pl}] | väntade [${exp ? [...exp] : ''}]`); }
    if (process.env.DEBUG === '5' && det.lastThump === real * 1000) console.log(`    ${real.toFixed(2)}s SMÄLL ${det.lastThumpRatio.toFixed(2)} väntade [${exp ? [...exp] : ''}] egna [${[...own]}] pågående ${det.pendings.length}`);
    if (process.env.DEBUG === '5') for (const e of det.lastRestrikeEval.filter(e => e.skipped)) console.log(`    ${real.toFixed(2)}s omslag ${e.p} hoppades över: ${e.skipped}`);
    if (process.env.DEBUG === '5') for (const e of det.lastRestrikeEval.filter(e => !e.skipped)) console.log(`    ${real.toFixed(2)}s omslag ${e.p}: steg ${e.step.toFixed(1)} krav ${e.need.toFixed(1)} drift ${e.drift.toFixed(1)} ryck ${e.jolt.toFixed(1)} krav ${e.needJolt}${e.fresh ? ' färsk' : ''}${e.blocked ? ' BLOCK:' + e.blocked : ''} egna [${e.own}] mask [${e.mask}] före [${e.before.map(v => (20 * Math.log10(v + 1e-9)).toFixed(0))}] efter [${e.after.map(v => (20 * Math.log10(v + 1e-9)).toFixed(0))}]${playerStrikeNotes.some(n => n.p === e.p && real - n.t >= 0 && real - n.t < 0.9) ? ' ÄKTA' : ' falsk'}`);
    if (process.env.DEBUG === '4') { const near = playerStrikes.concat(wrongStrikes).some(st => real - st >= -0.05 && real - st < 0.8);
      if (near && det.trace.length) console.log(`    ${real.toFixed(2)}s rå: ${det.trace.map(c => c.p + '(' + (20 * Math.log10(c.bv / det.traceThr)).toFixed(0) + 'dB ' + c.why + ')').join(', ')} | väntade [${exp ? [...exp] : ''}] | egna [${[...own]}] | smäll ${det.lastThumpRatio.toFixed(2)}${det.lastRestrikeEval.length ? ' | omslag ' + det.lastRestrikeEval.map(e => e.p + ':' + e.step.toFixed(1) + '/' + e.need.toFixed(1) + (e.blocked ? 'B' : '')).join(' ') : ''}`); }
    if (process.env.DEBUG === '2') { const all = det.lastFound || []; const near = playerStrikes.concat(wrongStrikes).some(st => real - st >= -0.05 && real - st < 0.6);
      if (all.length && near) console.log(`    ${real.toFixed(2)}s kand: ${all.map(o => o.p + (o.expected ? 'E' : '') + (o.ghost ? 'g' : '') + (o.unexpected ? '!' : '') + (o.restrike ? 'R' : '')).join(' ')} | väntade [${exp ? [...exp] : ''}] | smäll ${det.lastThumpRatio.toFixed(2)}${det.lastRestrikeEval.length ? ' | omslag ' + det.lastRestrikeEval.map(e => e.p + ':' + e.step.toFixed(1) + (e.blocked ? 'B' : '')).join(' ') : ''}`); }
    if (process.env.DEBUG) { const un = (det.lastFound || []).filter(o => o.unexpected); const near = playerStrikes.some(st => real - st >= -0.05 && real - st < 0.5);
      if (un.length && near) console.log(`    ${real.toFixed(2)}s OVÄNTAD: ${un.map(o => o.p + '(' + o.strength.toFixed(0) + 'dB)').join(' ')} | väntade [${exp ? [...exp] : ''}] | egna [${[...own]}] | smäll ${det.lastThumpRatio.toFixed(2)}`); }
    for (const e of (det.lastRestrikeEval || []).filter(e => !e.skipped)) { const isTrue = playerStrikeNotes.some(n => n.p === e.p && real - n.t >= 0 && real - n.t < 0.9); (isTrue ? evTrue : evFalse).push(e); }
    { let since = Infinity; for (const st of strikes) { const d = real - st; if (d >= 0 && d < since) since = d; }
      if (since <= 0.1) thumpAt.push(det.lastThumpRatio); else if (since > 0.4 && det.level > -55) thumpQuiet.push(det.lastThumpRatio); }
    for (const o of ons) {
      pressId[o.p] = ++seq; pressT[o.p] = real;
      if (waiting && ev.ps.has(o.p)) { got.add(o.p); consumed[o.p] = pressId[o.p]; lastLat = o.restrike ? LAT_RESTRIKE : LAT; }
    }
    if (waiting && satisfied(ev, got)) {
      if (played && WRONG && !playedRight) { wrongAccepted++; log.push(`FEL-GODKÄND ev${START + idx} [${[...ev.ps]}] hörde ${[...got]}`); }
      if (played) for (const p of ev.ps) det.markPlayed(p, real * 1000);
      if (played) playedOK++; else { autoOK++; log.push(`AUTO ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde ${[...got]} ${real.toFixed(2)}s`); }
      // som appen: musiken stod stilla medan tonen hördes – hoppa fram lika mycket
      const nx = sel[idx + 1]; songT = Math.min(ev.t + lastLat * TEMPO, nx ? Math.max(ev.t, nx.t - 1e-3) : ev.t);
      waiting = false; nextEvent();
      continue;
    }
  }
  if (!waiting) {
    // spelaren i takt: slår an tonen innan appen hunnit fram
    if (EARLY > 0 && !played && (ev.t - songT) / TEMPO <= earlyT) { strike(ev, 'SPELAR (tidigt)'); played = true; }
    let to = songT + dt * TEMPO;
    if (ev.t <= to) {
      to = ev.t;
      scheduleOther(to, real + (to - songT) / TEMPO);
      songT = to; real += (to - songT) / TEMPO;
      // ankomst: nyligen hörda toner räknas
      for (const p of ev.ps) if (pressId[p] > consumed[p] && real - pressT[p] < PRE_WINDOW) { got.add(p); consumed[p] = pressId[p]; }
      if (satisfied(ev, got)) {
        if (played) { playedOK++; for (const p of ev.ps) det.markPlayed(p, real * 1000); }
        else { autoOK++; log.push(`AUTO(förtryck) ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde ${[...got]} ${real.toFixed(2)}s`); }
        nextEvent();
        continue;
      }
      waiting = true; waitSince = real;
    } else { scheduleOther(to, real + dt); songT = to; }
  } else if (!played && real - waitSince >= REACT) {
    if (WRONG) { if (process.env.DEBUG) console.log(`  ${real.toFixed(2)}s FEL TON för [${[...ev.ps]}]`); wrongStrikes.push(real); for (const p of ev.ps) { const q = p + 1 + Math.round(rnd()); addNote(audio, real, q, 85 + rnd() * 30, pianoTune(q) + (rnd() - 0.5) * 4, 0.5, PEDAL); } playedRight = false; }
    else strike(ev, 'SPELAR');
    played = true;
  } else if (played && WRONG && !playedRight && real - waitSince >= REACT + 0.9) {
    strike(ev, 'RÄTT TON');
  } else if (played && playedRight && retries === 0 && real - waitSince >= RETRY && real - playerStrikes[playerStrikes.length - 1] >= RETRY) {
    // appen reagerade inte: spelaren slår an tonen en gång till
    retries = 1; secondStrikes++; log.push(`ANDRA ANSLAG ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde bara ${[...got]} ${real.toFixed(2)}s`);
    strike(ev, 'SPELAR IGEN');
  } else if (played && real - waitSince > REACT + 2.5) {
    stuck++; log.push(`FAST ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde bara ${[...got]}`);
    waiting = false; nextEvent();
  }
  real += dt;
}
let accGate = 0; for (const at of accompAt) if (thumpTimes.some(t => t >= at && t - at < 0.15)) accGate++;
let gateHits = 0; for (const st of playerStrikes) { let hit = false; for (const t of thumpTimes) if (t >= st && t - st < 0.2) hit = true; if (hit) gateHits++; }
console.log(`${HAND}-hand ev ${START}-${START + sel.length} (piano ${GLOBAL}c ±${KEYDEV}c, appen tror ${TUNE}c${HPF ? ', HPF ' + HPF + ' Hz' : ''}${INH !== 1 ? ', INH ' + INH : ''}${EARLY ? ', spelar ' + EARLY + ' s tidigt' : ''}${ACC_GAIN !== 1 ? ', ackomp x' + ACC_GAIN : ''}): spelade&godkända ${playedOK}, AUTO-godkända utan att spela ${autoOK}, andra anslag ${secondStrikes}, fastnade ${stuck}` + (WRONG ? `, godkända på FEL ton ${wrongAccepted}` : '') + `  | smällgrind: ${gateHits}/${playerStrikes.length} av spelarens anslag, ${accGate}/${accompAt.length} av ackompanjemangets  (N=${det.N})`);
{ const learned = []; for (let p = 0; p < 128; p++) if (det.keyConf[p] >= 1) learned.push(p);
  const errs = learned.map(p => Math.abs(det.tune + det.keyOff[p] - (GLOBAL + keyDev[p])));
  const mean = errs.length ? (errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1) : '-', mx = errs.length ? Math.max(...errs).toFixed(1) : '-';
  console.log(`  inlärt: stämning ${det.tune.toFixed(1)}c (pianot ${GLOBAL}c), ${learned.length} tangenter, fel per tangent medel ${mean}c max ${mx}c`); }
log.slice(0, 12).forEach(l => console.log('  ' + l));
const pctN = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(1) : '-'; };
const okEval = e => !e.blocked && e.step >= e.need && e.jolt >= e.needJolt;
const blockWhy = arr => { const m = {}; for (const e of arr) if (e.blocked) m[e.blocked] = (m[e.blocked] || 0) + 1; return Object.entries(m).map(([k, v]) => k + ' ' + v).join(', ') || '0'; };
console.log(`  omslag äkta (${evTrue.length} bedömningar, ${evTrue.filter(okEval).length} godkända): steg p10 ${pctN(evTrue.map(e=>e.step),0.1)} p25 ${pctN(evTrue.map(e=>e.step),0.25)} p50 ${pctN(evTrue.map(e=>e.step),0.5)} | krav p50 ${pctN(evTrue.map(e=>e.need),0.5)} | drift p50 ${pctN(evTrue.map(e=>e.drift),0.5)} | ryck p10 ${pctN(evTrue.map(e=>e.jolt),0.1)} p25 ${pctN(evTrue.map(e=>e.jolt),0.25)} p50 ${pctN(evTrue.map(e=>e.jolt),0.5)} | blockerade: ${blockWhy(evTrue)}`);
console.log(`  omslag falska (${evFalse.length} bedömningar): steg p50 ${pctN(evFalse.map(e=>e.step),0.5)} p90 ${pctN(evFalse.map(e=>e.step),0.9)} p99 ${pctN(evFalse.map(e=>e.step),0.99)} max ${pctN(evFalse.map(e=>e.step),1)} | krav p50 ${pctN(evFalse.map(e=>e.need),0.5)} | ryck p50 ${pctN(evFalse.map(e=>e.jolt),0.5)} p90 ${pctN(evFalse.map(e=>e.jolt),0.9)} p99 ${pctN(evFalse.map(e=>e.jolt),0.99)} max ${pctN(evFalse.map(e=>e.jolt),1)} | godkända ${evFalse.filter(okEval).length}`);
const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(2) : '-'; };
console.log(`  smäll vid anslag (0–100 ms): p10 ${pct(thumpAt, 0.1)} p50 ${pct(thumpAt, 0.5)} | utan anslag (>400 ms efter): p50 ${pct(thumpQuiet, 0.5)} p90 ${pct(thumpQuiet, 0.9)} p99 ${pct(thumpQuiet, 0.99)} max ${pct(thumpQuiet, 1)}`);
