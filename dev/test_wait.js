// Simulering av vänta-läget mot ett syntetiskt piano (ostämda unisonsträngar, pedal, upprepade toner,
// ackompanjemang från appen). Mäter händelser som godkänns utan spel, som fastnar, och fel toner som godkänns.
// Simulerar vänta-läget med ett "riktigt" piano: ostämda unisonsträngar (svävningar), lång efterklang,
// upprepade toner, och en spelare som bara spelar när appen väntar.
// Mäter: händelser som godkändes utan att spelaren spelat (= buggen), och händelser som aldrig godkändes.
const fs = require('fs');
// Körs med: MIDI=sökväg/till/låt.mid node dev/test_wait.js   (valfritt: HAND=R|L START=n NEV=n BEAT=cent WRONG=1 HAMMER=x ACC_ATTACK=samples DEBUG=1|2|3)
const path = require('path');
require(path.join(__dirname, '..', 'midi.js')); require(path.join(__dirname, '..', 'detector.js'));
if (!process.env.MIDI) { console.error('Ange MIDI=<fil.mid>'); process.exit(1); }
const SR = 48000;
const BEAT = +(process.env.BEAT || 2.5);
const HAMMER = process.env.HAMMER === undefined ? 1 : +process.env.HAMMER;   // hammarsmällens styrka
const strikes = [];   // tider för alla riktiga anslag i ljudet   // cent mellan unisonsträngarna (svävning)
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Varje ton = 2–3 strängar som är lite olika stämda -> svävning. Lång efterklang (pedal nere).
function addNote(buf, t0, p, vel, detune, keyDur, pedal, opts) {
  opts = opts || {}; const attack = opts.attack || 200, hammer = opts.hammer === undefined ? HAMMER : opts.hammer;
  const base = 440 * 2 ** ((p - 69) / 12 + detune / 1200);
  const B = Math.min(2e-3, Math.max(5e-5, 1.2e-4 * 2 ** ((p - 48) / 12)));
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
const HAND = process.env.HAND || 'R', TEMPO = 0.7, GLOBAL = -30, PEDAL = process.env.PEDAL !== '0';
const START = +(process.env.START || 0), NEV = +(process.env.NEV || 40);
const hand = song.notes.filter(n => n.h === HAND);
const other = song.notes.filter(n => n.h !== HAND);
const evs = [];
for (const n of hand) { const e = evs[evs.length - 1]; if (e && Math.abs(e.t - n.s) < 0.03) e.ps.add(n.p); else evs.push({ t: n.s, ps: new Set([n.p]) }); }
const sel = evs.slice(START, START + NEV);

// Spelaren: spelar den väntade händelsen 450 ms efter att appen börjat vänta.
// Appen: går i tempo mellan händelserna, väntar vid varje händelse tills alla (eller nästan alla) toner hörts.
const REACT = 0.45, PRE_WINDOW = +(process.env.PRE || 0.35), CLEAR = process.env.CLEAR !== '0', LENIENT = process.env.LENIENT !== '0';
const hop = 2400;   // 50 ms
const det = new PianoDetector.PitchDetector(SR, process.env.N ? { fftSize: +process.env.N } : {});
if (process.env.RISE) det.riseDb = +process.env.RISE;
if (process.env.THUMP) det.thumpRatio = +process.env.THUMP;
const thumpAt = [], thumpQuiet = [], accompAt = [], playerStrikes = [], thumpTimes = [], playerStrikeNotes = [];
const evTrue = [], evFalse = [], accompNotes = [], wrongStrikes = [];
const WRONG = process.env.WRONG === '1';   // spelaren tar först fel ton, sedan rätt
let playedRight = false, wrongAccepted = 0; det.setRange(33, 96); det.setTune(GLOBAL);
if (process.env.SENS) det.sensitivity = +process.env.SENS;
const audio = new Float32Array(SR * 400);
for (let i = 0; i < audio.length; i++) audio[i] = (rnd() - 0.5) * 0.004;
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
    if (process.env.ACCOMP !== '0') { const at = realAt + (n.s - toSong) / TEMPO; addNote(audio, at, n.p, n.v * 0.8, GLOBAL, (n.e - n.s) / TEMPO, false, { attack: +(process.env.ACC_ATTACK || 1200), hammer: 0 }); accompAt.push(at); accompNotes.push({ t: at, p: n.p }); }
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
while (idx < sel.length && real < 380) {
  const ev = sel[idx];
  // framåt i tiden
  const realNow = real;
  const samplesEnd = Math.round(real * SR);
  if (samplesEnd >= det.N) {
    const exp = (waiting || (ev.t - songT) / TEMPO < 0.6) ? ev.ps : null;
    for (const n of accompNotes) if (n.t <= real && real - n.t < dt + 1e-6) det.markOwnOnset(n.t * 1000, n.p);
    const own = new Set(accompNotes.filter(n => n.t <= real && real - n.t < 0.5).map(n => n.p));
    const ons = det.analyze(audio.subarray(samplesEnd - det.N, samplesEnd), real * 1000, exp, own);
    if (det.lastThump === real * 1000) thumpTimes.push(real);
    if (process.env.DEBUG === '3') for (const o of (det.lastFound || []).filter(o => o.unexpected)) {
      const acc = accompNotes.filter(n => Math.abs(n.t - real) < 0.6).map(n => n.p + '@' + (n.t - real).toFixed(2)); const pl = playerStrikeNotes.filter(n => real - n.t >= 0 && real - n.t < 1.5).map(n => n.p + '@' + (n.t - real).toFixed(2));
      console.log(`    ${real.toFixed(2)}s OVÄNTAD ${o.p} | ackomp [${acc}] | spelaren [${pl}] | väntade [${exp ? [...exp] : ''}]`); }
    if (process.env.DEBUG === '2') { const all = det.lastFound || []; const near = playerStrikes.concat(wrongStrikes).some(st => real - st >= -0.05 && real - st < 0.6);
      if (all.length && near) console.log(`    ${real.toFixed(2)}s kand: ${all.map(o => o.p + (o.expected ? 'E' : '') + (o.ghost ? 'g' : '') + (o.unexpected ? '!' : '') + (o.restrike ? 'R' : '')).join(' ')} | väntade [${exp ? [...exp] : ''}] | smäll ${det.lastThumpRatio.toFixed(2)}${det.lastRestrikeEval.length ? ' | omslag ' + det.lastRestrikeEval.map(e => e.p + ':' + e.step.toFixed(1) + (e.blocked ? 'B' : '')).join(' ') : ''}`); }
    if (process.env.DEBUG) { const un = (det.lastFound || []).filter(o => o.unexpected); const near = playerStrikes.some(st => real - st >= -0.05 && real - st < 0.5);
      if (un.length && near) console.log(`    ${real.toFixed(2)}s OVÄNTAD: ${un.map(o => o.p + '(' + o.strength.toFixed(0) + 'dB)').join(' ')} | väntade [${exp ? [...exp] : ''}] | egna [${[...own]}] | smäll ${det.lastThumpRatio.toFixed(2)}`); }
    for (const e of det.lastRestrikeEval || []) { const isTrue = playerStrikeNotes.some(n => n.p === e.p && real - n.t >= 0 && real - n.t < 0.9); (isTrue ? evTrue : evFalse).push(e); }
    { let since = Infinity; for (const st of strikes) { const d = real - st; if (d >= 0 && d < since) since = d; }
      if (since <= 0.1) thumpAt.push(det.lastThumpRatio); else if (since > 0.4 && det.level > -55) thumpQuiet.push(det.lastThumpRatio); }
    for (const o of ons) {
      pressId[o.p] = ++seq; pressT[o.p] = real;
      if (waiting && ev.ps.has(o.p)) { got.add(o.p); consumed[o.p] = pressId[o.p]; }
    }
    if (waiting && satisfied(ev, got)) {
      if (played && WRONG && !playedRight) { wrongAccepted++; log.push(`FEL-GODKÄND ev${START + idx} [${[...ev.ps]}] hörde ${[...got]}`); }
      if (played) for (const p of ev.ps) det.markPlayed(p, real * 1000);
      if (played) playedOK++; else { autoOK++; log.push(`AUTO ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde ${[...got]} ${real.toFixed(2)}s`); }
      waiting = false; idx++; got = new Set(); played = false;
      if (CLEAR) for (let p = 0; p < 128; p++) consumed[p] = pressId[p];
      continue;
    }
  }
  if (!waiting) {
    let to = songT + dt * TEMPO;
    if (ev.t <= to) {
      to = ev.t;
      scheduleOther(to, real + (to - songT) / TEMPO);
      songT = to; real += (to - songT) / TEMPO;
      // ankomst: nyligen hörda toner räknas
      for (const p of ev.ps) if (pressId[p] > consumed[p] && real - pressT[p] < PRE_WINDOW) { got.add(p); consumed[p] = pressId[p]; }
      if (satisfied(ev, got)) {
        autoOK++; log.push(`AUTO(förtryck) ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde ${[...got]} ${real.toFixed(2)}s`);
        idx++; got = new Set(); if (CLEAR) for (let p = 0; p < 128; p++) consumed[p] = pressId[p];
        continue;
      }
      waiting = true; waitSince = real; played = false;
    } else { scheduleOther(to, real + dt); songT = to; }
  } else if (!played && real - waitSince >= REACT) {
    if (process.env.DEBUG) console.log(`  ${real.toFixed(2)}s SPELAR [${[...ev.ps]}]`);
    if (WRONG) { if (process.env.DEBUG) console.log(`  ${real.toFixed(2)}s FEL TON för [${[...ev.ps]}]`); wrongStrikes.push(real); for (const p of ev.ps) addNote(audio, real, p + 1 + Math.round(rnd()), 85 + rnd() * 30, GLOBAL + (rnd() - 0.5) * 14, 0.5, PEDAL); playedRight = false; }
    else { for (const p of ev.ps) addNote(audio, real, p, 85 + rnd() * 30, GLOBAL + (rnd() - 0.5) * 14, 0.5, PEDAL); playedRight = true; playerStrikes.push(real); for (const p of ev.ps) playerStrikeNotes.push({ t: real, p }); }
    played = true;
  } else if (played && WRONG && !playedRight && real - waitSince >= REACT + 0.9) {
    for (const p of ev.ps) addNote(audio, real, p, 85 + rnd() * 30, GLOBAL + (rnd() - 0.5) * 14, 0.5, PEDAL);
    playedRight = true; playerStrikes.push(real); for (const p of ev.ps) playerStrikeNotes.push({ t: real, p });
  } else if (played && real - waitSince > REACT + 2.5) {
    stuck++; log.push(`FAST ev${START + idx} t=${ev.t.toFixed(2)} [${[...ev.ps]}] hörde bara ${[...got]}`);
    waiting = false; idx++; got = new Set(); played = false;
    if (CLEAR) for (let p = 0; p < 128; p++) consumed[p] = pressId[p];
  }
  real += dt;
}
let accGate = 0; for (const at of accompAt) if (thumpTimes.some(t => t >= at && t - at < 0.15)) accGate++;
let gateHits = 0; for (const st of playerStrikes) { let hit = false; for (const t of thumpTimes) if (t >= st && t - st < 0.2) hit = true; if (hit) gateHits++; }
console.log(`${HAND}-hand ev ${START}-${START + sel.length}: spelade&godkända ${playedOK}, AUTO-godkända utan att spela ${autoOK}, fastnade ${stuck}` + (WRONG ? `, godkända på FEL ton ${wrongAccepted}` : '') + `  | smällgrind: ${gateHits}/${playerStrikes.length} av spelarens anslag, ${accGate}/${accompAt.length} av ackompanjemangets  (N=${det.N})`);
log.slice(0, 12).forEach(l => console.log('  ' + l));
const pctN = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(1) : '-'; };
console.log(`  omslag äkta (${evTrue.length} bedömningar): steg p10 ${pctN(evTrue.map(e=>e.step),0.1)} p25 ${pctN(evTrue.map(e=>e.step),0.25)} p50 ${pctN(evTrue.map(e=>e.step),0.5)} | krav p50 ${pctN(evTrue.map(e=>e.need),0.5)} | drift p50 ${pctN(evTrue.map(e=>e.drift),0.5)} | blockerade ${evTrue.filter(e=>e.blocked).length}`);
console.log(`  omslag falska (${evFalse.length} bedömningar): steg p50 ${pctN(evFalse.map(e=>e.step),0.5)} p90 ${pctN(evFalse.map(e=>e.step),0.9)} p99 ${pctN(evFalse.map(e=>e.step),0.99)} max ${pctN(evFalse.map(e=>e.step),1)} | krav p50 ${pctN(evFalse.map(e=>e.need),0.5)} | godkända ${evFalse.filter(e=>!e.blocked && e.step>=e.need).length}`);
const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(2) : '-'; };
console.log(`  smäll vid anslag (0–100 ms): p10 ${pct(thumpAt, 0.1)} p50 ${pct(thumpAt, 0.5)} | utan anslag (>400 ms efter): p50 ${pct(thumpQuiet, 0.5)} p90 ${pct(thumpQuiet, 0.9)} p99 ${pct(thumpQuiet, 0.99)} max ${pct(thumpQuiet, 1)}`);
