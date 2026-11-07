// Pianoövning – fallande toner, fingersättning och ett lärläge som lyssnar på ditt piano.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const LEAD = 1.6;              // sekunder inräkning innan en del börjar
  const LOOK = 3.4;              // så många sekunder framåt syns
  const CHORD_TOL = 0.03;
  const MIC_LATENCY = 0.15;      // ungefärlig fördröjning i tonigenkänningen (s)
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = p => BLACK.has(p % 12);
  const COLORS = {
    R: { main: '#5aa8ff', dark: '#2f78cc', key: '#8cc3ff', text: '#0b2f57' },
    L: { main: '#ffa53d', dark: '#c77418', key: '#ffc27a', text: '#5a3000' },
  };

  // ---------- Inställningar ----------
  const S = { hand: 'R', mode: 'wait', tempo: 0.7, section: 0, loop: true, fingers: true, names: false,
    sound: 'on', accomp: true, sens: 0.5, tune: 0 };
  try { Object.assign(S, JSON.parse(localStorage.getItem('po-settings') || '{}')); } catch (e) { /* ingen lagring */ }
  function saveSettings() { try { localStorage.setItem('po-settings', JSON.stringify(S)); } catch (e) { /* ok */ } }

  // ---------- Exempellåt (fri från upphovsrätt) ----------
  function demoSong() {
    const bpm = 92, beat = 60 / bpm;
    const mel = [60, 60, 67, 67, 69, 69, 67, null, 65, 65, 64, 64, 62, 62, 60, null,
      67, 67, 65, 65, 64, 64, 62, null, 67, 67, 65, 65, 64, 64, 62, null,
      60, 60, 67, 67, 69, 69, 67, null, 65, 65, 64, 64, 62, 62, 60, null];
    const notes = [];
    mel.forEach((p, i) => {
      if (p === null) return;
      const len = mel[i + 1] === null ? 2 : 1;
      notes.push({ s: i * beat, e: (i + len) * beat - 0.05, p, h: 'R', v: 80 });
    });
    const lh = [[48, 48], [53, 48], [53, 48], [43, 48], [48, 53], [48, 43], [48, 53], [48, 43], [48, 48], [53, 48], [53, 48], [43, 48]];
    lh.forEach((pair, b) => pair.forEach((p, k) => {
      const s = (b * 4 + k * 2) * beat;
      notes.push({ s, e: s + 2 * beat - 0.05, p, h: 'L', v: 60 });
    }));
    const bars = [];
    for (let b = 0; b < 12; b++) bars.push(b * 4 * beat);
    return {
      title: 'Blinka lilla stjärna (exempel)', duration: 48 * beat, bpm, bars, pedal: [],
      markers: [{ t: 0, name: 'Del 1' }, { t: 16 * beat, name: 'Del 2' }, { t: 32 * beat, name: 'Del 3' }],
      notes: notes.sort((a, b) => a.s - b.s || a.p - b.p),
    };
  }

  function prettyMarker(name) {
    const map = { INTRO: 'Intro', VERSE: 'Vers', CHORUS: 'Refräng', STICK: 'Stick', BRIDGE: 'Stick', OUTRO: 'Outro',
      PRECHORUS: 'Brygga', 'PRE-CHORUS': 'Brygga', SOLO: 'Solo', ENDING: 'Slut' };
    const m = name.trim().toUpperCase().match(/^([A-Z-]+)\s*(\d*)$/);
    if (m && map[m[1]]) return map[m[1]] + (m[2] ? ' ' + m[2] : '');
    return name.trim();
  }

  // ---------- Låten ----------
  let title = '', notes = [], MAXDUR = 0, pedals = [], BARS = [0], DUR = 1, BPM = 100;
  let sections = [], markerAtBar = new Map(), LOW = 48, HIGH = 84;

  function lowerBound(arr, x, key) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function barAt(x) {
    if (x < BARS[0]) return 1;
    let lo = 0, hi = BARS.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (BARS[mid] <= x + 1e-6) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }

  function loadSong(data) {
    if (typeof setPlaying === 'function') setPlaying(false);
    PianoFingering.assignFingers(data.notes);
    title = data.title;
    notes = data.notes.map(n => ({ s: n.s, e: n.e, d: n.e - n.s, p: n.p, h: n.h, f: n.f || 0, v: n.v,
      hit: false, miss: false, _voice: null }))
      .sort((a, b) => a.s - b.s || a.p - b.p);
    MAXDUR = notes.reduce((m, n) => Math.max(m, n.d), 0);
    pedals = (data.pedal || []).map(([t, v]) => ({ t, v }));
    BARS = data.bars.length ? data.bars : [0];
    DUR = data.duration;
    BPM = data.bpm || 100;

    // klaviaturens omfång: låtens toner plus lite marginal, minst två oktaver
    let lo = Math.min(...notes.map(n => n.p)) - 2, hi = Math.max(...notes.map(n => n.p)) + 2;
    while (hi - lo < 24) { lo--; hi++; }
    while (lo > 21 && lo % 12 !== 0 && lo % 12 !== 5) lo--;
    while (hi < 108 && hi % 12 !== 11 && hi % 12 !== 4) hi++;
    LOW = Math.max(21, lo); HIGH = Math.min(108, hi);
    if (isBlack(LOW)) LOW--;
    if (isBlack(HIGH)) HIGH++;

    // delar
    sections = [{ name: 'Hela låten', start: 0, end: DUR }];
    const ms = (data.markers || []).filter(m => m.t < DUR - 1);
    if (ms.length) {
      const names = ms.map(m => prettyMarker(m.name));
      names.forEach((nm, i) => {     // "Vers" blir "Vers 1" om det också finns en "Vers 2"
        if (!/\d$/.test(nm) && names.includes(nm + ' 2')) names[i] = nm + ' 1';
      });
      ms.forEach((m, i) => sections.push({ name: names[i], start: i === 0 ? 0 : m.t, end: i + 1 < ms.length ? ms[i + 1].t : DUR }));
    } else {
      for (let b = 0; b < BARS.length; b += 8) {
        const end = b + 8 < BARS.length ? BARS[b + 8] : DUR;
        sections.push({ name: `Takt ${b + 1}–${Math.min(b + 8, BARS.length)}`, start: BARS[b], end, plain: true });
      }
    }
    sections.forEach(s => { s.b0 = barAt(s.start); s.b1 = barAt(s.end - 0.01); });
    markerAtBar = new Map();
    sections.slice(1).forEach(s => { if (!s.plain) markerAtBar.set(s.b0, s.name); });

    const sel = $('sectionSel');
    sel.innerHTML = '';
    sections.forEach((s, i) => {
      const o = document.createElement('option'); o.value = String(i);
      o.textContent = i === 0 ? `${s.name} (takt 1–${BARS.length})` : (s.plain ? s.name : `${s.name} (takt ${s.b0}–${s.b1})`);
      sel.appendChild(o);
    });
    if (!(S.section >= 0 && S.section < sections.length)) S.section = 0;
    sel.value = String(S.section);
    $('title').textContent = title;
    document.title = title + ' – Pianoövning';
    $('seek').max = String(DUR);
    showTempo();
    layout();
    if (mic.det) mic.det.setRange(LOW - 5, HIGH + 5);
    buildPractice();
    restartSection(false);
  }

  // ---------- Ljud från iPaden ----------
  const synth = (() => {
    let ac = null, master = null, sustain = false;
    const live = new Set(), held = new Set();
    function ctx() {
      if (!ac) {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -16; comp.ratio.value = 4;
        master = ac.createGain(); master.gain.value = 0.34;
        master.connect(comp); comp.connect(ac.destination);
      }
      if (ac.state !== 'running') ac.resume().catch(() => {});
      return ac;
    }
    function noteOn(p, vel) {
      ctx();
      const now = ac.currentTime, f = 440 * Math.pow(2, (p - 69) / 12), k = vel / 127;
      const amp = 0.06 + 0.45 * Math.pow(k, 1.4);
      const g = ac.createGain(), lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.4;
      lp.frequency.setValueAtTime(Math.min(10000, f * (3 + 7 * k)), now);
      lp.frequency.setTargetAtTime(Math.min(6000, f * 2.2), now, 0.5);
      const o1 = ac.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
      const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2; o2.detune.value = 3;
      const g2 = ac.createGain(); g2.gain.value = 0.28;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(master);
      const decay = Math.max(0.5, 2.6 - (p - 36) / 60 * 1.9);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(amp, now + 0.006);
      g.gain.setTargetAtTime(amp * 0.4, now + 0.006, 0.22);
      g.gain.setTargetAtTime(0.0001, now + 0.35, decay);
      o1.start(now); o2.start(now); o1.stop(now + 14); o2.stop(now + 14);
      const v = { g, oscs: [o1, o2], released: false };
      live.add(v);
      return v;
    }
    function release(v) {
      if (!v || v.released) return;
      v.released = true; live.delete(v); held.delete(v);
      const now = ac.currentTime;
      try {
        if (v.g.gain.cancelAndHoldAtTime) v.g.gain.cancelAndHoldAtTime(now);
        else { v.g.gain.cancelScheduledValues(now); v.g.gain.setValueAtTime(v.g.gain.value, now); }
        v.g.gain.setTargetAtTime(0, now, 0.08);
        v.oscs.forEach(o => o.stop(now + 0.6));
      } catch (e) { /* redan stoppad */ }
    }
    function noteOff(v) { if (!v) return; if (sustain) held.add(v); else release(v); }
    function setSustain(on) { sustain = on; if (!on) [...held].forEach(release); }
    function allOff() { [...live].forEach(release); held.clear(); sustain = false; }
    return { ctx, noteOn, noteOff, setSustain, allOff };
  })();

  // ---------- Mikrofon ----------
  const mic = { on: false, det: null, an: null, buf: null, stream: null, lastRun: 0, starting: false };
  const appPlayed = new Float64Array(128).fill(-1e9);    // när iPaden själv spelade en ton (för att inte höra sig själv)

  function setMicStatus(text, cls) {
    $('micText').textContent = text;
    $('micStatus').className = 'pill' + (cls ? ' ' + cls : '');
  }
  async function startMic() {
    if (mic.on || mic.starting) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicStatus('Mikrofonen stöds inte här', 'bad');
      toast('Mikrofonen fungerar bara när sidan öppnas via https, t.ex. i Safari på iPaden.');
      return false;
    }
    mic.starting = true;
    try {
      const ac = synth.ctx();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const det = new PianoDetector.PitchDetector(ac.sampleRate);
      det.setRange(LOW - 5, HIGH + 5);
      det.setTune(S.tune);
      det.sensitivity = S.sens;
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = det.N;
      an.smoothingTimeConstant = 0;
      const mute = ac.createGain(); mute.gain.value = 0;
      src.connect(an); an.connect(mute); mute.connect(ac.destination);
      Object.assign(mic, { on: true, det, an, stream, buf: new Float32Array(an.fftSize) });
      setMicStatus('Mikrofonen lyssnar', 'ok');
      $('micBtn').textContent = 'Stäng av mikrofonen';
      return true;
    } catch (e) {
      setMicStatus('Ingen tillgång till mikrofonen', 'bad');
      toast('Tillåt mikrofonen: Inställningar › Safari › Mikrofon, eller tryck på aA i adressfältet.');
      return false;
    } finally {
      mic.starting = false;
    }
  }
  function stopMic() {
    if (mic.stream) mic.stream.getTracks().forEach(tr => tr.stop());
    Object.assign(mic, { on: false, det: null, an: null, stream: null });
    setMicStatus('Mikrofonen är av', '');
    $('micBtn').textContent = 'Starta mikrofonen';
    $('micLevel').style.width = '0';
  }
  function expectedSet() {
    if (S.mode === 'wait') {
      const ev = practice[pendIdx];
      if (ev && (waiting || (ev.t - t) / S.tempo < 0.6)) return ev.pitches;
      return null;
    }
    if (S.mode === 'play') {
      const set = new Set(), win = 0.5 * S.tempo;
      for (let i = lowerBound(notes, t - win, n => n.s); i < notes.length && notes[i].s <= t + win; i++) {
        if (practiced(notes[i].h)) set.add(notes[i].p);
      }
      return set.size ? set : null;
    }
    return null;
  }
  function micTick(now) {
    if (!mic.on || now - mic.lastRun < 45) return;
    mic.lastRun = now;
    mic.an.getFloatTimeDomainData(mic.buf);
    const onsets = mic.det.analyze(mic.buf, now, expectedSet());
    $('micLevel').style.width = Math.max(0, Math.min(100, (mic.det.level + 70) * 1.8)) + '%';
    if (tuneDlg.open) tuneTick();
    if (S.mode === 'listen') return;
    for (const o of onsets) {
      if (now - appPlayed[o.p] < 400) continue;          // iPadens eget ljud
      userNoteOn(o.p, 'mic');
      setTimeout(() => userNoteOff(o.p, 'mic'), 260);
    }
  }

  // ---------- USB-klaviatur (Web MIDI, där det finns) ----------
  if (navigator.requestMIDIAccess) $('midiBtn').hidden = false;
  $('midiBtn').addEventListener('click', async () => {
    try {
      const access = await navigator.requestMIDIAccess();
      const bind = () => {
        let n = 0;
        access.inputs.forEach(inp => {
          n++;
          inp.onmidimessage = e => {
            const [st, a, b] = e.data, type = st & 0xF0;
            if (type === 0x90 && b > 0) userNoteOn(a, 'midi');
            else if (type === 0x80 || (type === 0x90 && b === 0)) userNoteOff(a, 'midi');
          };
        });
        toast(n ? 'USB-klaviaturen är ansluten.' : 'Ingen USB-klaviatur hittades.');
      };
      access.onstatechange = bind;
      bind();
    } catch (e) { toast('Fick inte tillgång till MIDI.'); }
  });

  // ---------- Uppspelning ----------
  let t = -LEAD, playing = false, waiting = false;
  let cursor = 0, pedalCursor = 0, pendIdx = 0, missIdx = 0;
  const active = new Set();
  let practice = [];
  const score = { ok: 0, bad: 0, miss: 0 };
  const pressed = new Map();
  const pressTime = new Float64Array(128);
  const pressId = new Uint32Array(128), consumed = new Uint32Array(128);
  let pressSeq = 0;
  const sec = () => sections[S.section] || sections[0];
  const practiced = h => S.mode !== 'listen' && (S.hand === 'B' || S.hand === h);

  function noteStart(n) {
    const audible = S.sound === 'on' && (S.mode === 'listen' || (!practiced(n.h) && S.accomp));
    if (audible) { n._voice = synth.noteOn(n.p, n.v); appPlayed[n.p] = performance.now(); }
    active.add(n);
  }
  function noteEnd(n) {
    if (n._voice) { synth.noteOff(n._voice); n._voice = null; }
    active.delete(n);
  }
  function advance(to) {
    while (cursor < notes.length && notes[cursor].s <= to) noteStart(notes[cursor++]);
    for (const n of active) if (n.e <= to) noteEnd(n);
    while (pedalCursor < pedals.length && pedals[pedalCursor].t <= to) synth.setSustain(pedals[pedalCursor++].v >= 64);
  }
  function stopAll() {
    [...active].forEach(noteEnd);
    synth.allOff();
  }
  function buildPractice() {
    practice = [];
    let cur = null;
    for (const n of notes) {
      n.hit = false; n.miss = false;
      if (!practiced(n.h)) continue;
      if (cur && n.s - cur.t <= CHORD_TOL) cur.notes.push(n);
      else { cur = { t: n.s, notes: [n], got: new Set() }; practice.push(cur); }
    }
    practice.forEach(ev => { ev.pitches = new Set(ev.notes.map(n => n.p)); });
  }
  function seek(newT, keepScore) {
    stopAll();
    waiting = false;
    t = newT;
    cursor = lowerBound(notes, t, n => n.s);
    pedalCursor = lowerBound(pedals, t, p => p.t);
    pendIdx = lowerBound(practice, Math.max(t, sec().start) - 1e-6, ev => ev.t);
    missIdx = pendIdx;
    for (let i = pendIdx; i < practice.length; i++) {
      practice[i].got.clear();
      practice[i].notes.forEach(n => { n.hit = false; n.miss = false; });
    }
    if (!keepScore) { score.ok = 0; score.bad = 0; score.miss = 0; }
  }
  function restartSection(keepPlaying) {
    seek(sec().start - LEAD, false);
    if (!keepPlaying) setPlaying(false);
  }
  let wakeLock = null;
  function setPlaying(on) {
    if (on === playing) return;
    if (on) {
      synth.ctx();
      if (t >= sec().end) seek(sec().start - LEAD, false);
      else seek(t, true);
      playing = true;
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {});
    } else {
      playing = false;
      stopAll();
      waiting = false;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
    $('playBtn').textContent = playing ? '❚❚ Pausa' : '▶ Spela';
  }
  function satisfied(ev) {
    if (ev.got.size >= ev.pitches.size) return true;
    if (!mic.on) return false;
    // med mikrofon: godkänn om bara en ton saknas i ett ackord med minst tre toner,
    // eller om det som saknas är en oktav av en ton som hörts (oktaver är svåra att höra isär)
    const missing = [...ev.pitches].filter(p => !ev.got.has(p));
    if (missing.length !== 1) return false;
    return ev.pitches.size >= 3 || [...ev.got].some(q => Math.abs(q - missing[0]) % 12 === 0);
  }
  function completeEvent(ev, skipped) {
    ev.notes.forEach(n => { n.hit = !skipped; });
    if (!skipped) score.ok += ev.pitches.size;
    pendIdx++;
    waiting = false;
  }
  function arriveAt(ev) {
    const now = performance.now();
    for (const p of ev.pitches) {
      if (pressId[p] > consumed[p] && now - pressTime[p] < 450) { ev.got.add(p); consumed[p] = pressId[p]; }
    }
    if (satisfied(ev)) completeEvent(ev);
    else waiting = true;
  }
  function checkMisses() {
    const win = (mic.on ? 0.45 + MIC_LATENCY : 0.35) * S.tempo;
    while (missIdx < practice.length && practice[missIdx].t + win < t) {
      practice[missIdx].notes.forEach(n => { if (!n.hit) { n.miss = true; score.miss++; } });
      missIdx++;
    }
  }
  function summary() {
    if (S.mode === 'wait') {
      const tot = score.ok + score.bad;
      return `${score.ok} rätt` + (score.bad ? `, ${score.bad} fel` : '') + (tot && score.bad ? ` (${Math.round(100 * score.ok / tot)} % rätt)` : '');
    }
    if (S.mode === 'play') {
      const tot = score.ok + score.miss;
      return `${score.ok} av ${tot} toner träffade` + (tot ? ` (${Math.round(100 * score.ok / tot)} %)` : '');
    }
    return '';
  }
  function sectionEnd() {
    const res = summary();
    if (S.loop) {
      if (res) toast(res + ' – en gång till!');
      restartSection(true);
    } else {
      setPlaying(false);
      toast(res ? 'Klart! ' + res : 'Klart!');
    }
  }

  // ---------- Det du spelar ----------
  const userVoices = new Map();
  function userNoteOn(p, src) {
    const now = performance.now();
    pressed.set(p, { wrong: false, src });
    pressTime[p] = now;
    pressId[p] = ++pressSeq;
    if (src === 'mouse' && S.sound === 'on') userVoices.set(p, synth.noteOn(p, 90));
    const countWrong = src !== 'mic';     // mikrofonen kan höra övertoner, så den räknar inte fel
    if (S.mode === 'wait') {
      const ev = practice[pendIdx];
      if (waiting && ev) {
        if (ev.pitches.has(p)) {
          ev.got.add(p); consumed[p] = pressId[p];
          if (satisfied(ev)) completeEvent(ev);
        } else if (countWrong && ![...active].some(n => n.p === p && practiced(n.h))) {
          score.bad++; pressed.get(p).wrong = true;
        }
      }
    } else if (S.mode === 'play') {
      const tt = src === 'mic' ? t - MIC_LATENCY * S.tempo : t;
      const win = (src === 'mic' ? 0.45 : 0.35) * S.tempo;
      let best = null;
      for (let i = lowerBound(notes, tt - win, n => n.s); i < notes.length && notes[i].s <= tt + win; i++) {
        const n = notes[i];
        if (n.p === p && !n.hit && practiced(n.h) && (!best || Math.abs(n.s - tt) < Math.abs(best.s - tt))) best = n;
      }
      if (best) { best.hit = true; best.miss = false; score.ok++; }
      else if (countWrong) { score.bad++; pressed.get(p).wrong = true; }
    }
  }
  function userNoteOff(p, src) {
    const pr = pressed.get(p);
    if (pr && pr.src === src) pressed.delete(p);
    if (src === 'mouse' && userVoices.has(p)) { synth.noteOff(userVoices.get(p)); userVoices.delete(p); }
  }

  // ---------- Ritning ----------
  const cv = $('cv'), ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, kbTop = 0, kbH = 0, keys = [], blackH = 0;

  function layout() {
    const r = cv.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    let whites = 0;
    for (let p = LOW; p <= HIGH; p++) if (!isBlack(p)) whites++;
    const ww = W / whites;
    kbH = Math.max(80, Math.min(190, H * 0.28, ww * 6.2));
    kbTop = H - kbH;
    const bw = ww * 0.62;
    blackH = kbH * 0.62;
    keys = [];
    let wi = 0;
    const off = { 1: -0.12, 3: 0.12, 6: -0.15, 8: 0, 10: 0.15 };
    for (let p = LOW; p <= HIGH; p++) {
      if (!isBlack(p)) { keys[p] = { x: wi * ww, w: ww, black: false }; wi++; }
      else keys[p] = { x: wi * ww - bw / 2 + off[p % 12] * bw, w: bw, black: true };
    }
  }
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }
  function badge(cx, cy, r, num, hand) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.fillStyle = COLORS[hand].text;
    ctx.font = `700 ${Math.round(r * 1.35)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(num), cx, cy + r * 0.06);
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pps = kbTop / LOOK;
    ctx.fillStyle = '#13161c'; ctx.fillRect(0, 0, W, kbTop);
    ctx.fillStyle = '#1b1e25';
    for (let p = LOW; p <= HIGH; p++) if (p % 12 === 0 && keys[p]) ctx.fillRect(Math.round(keys[p].x), 0, 1, kbTop);

    const s = sec();
    const yEnd = kbTop - (s.end - t) * pps;
    if (S.section > 0 && yEnd > 0) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, W, Math.min(kbTop, yEnd)); }

    // taktstreck
    ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    for (let b = Math.max(0, barAt(t) - 1); b < BARS.length; b++) {
      const y = kbTop - (BARS[b] - t) * pps;
      if (y < 0) break;
      if (y > kbTop) continue;
      ctx.fillStyle = '#262a33'; ctx.fillRect(0, Math.round(y), W, 1);
      ctx.fillStyle = '#6b7383'; ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.fillText(String(b + 1), 6, y - 2);
      const mk = markerAtBar.get(b + 1);
      if (mk) { ctx.fillStyle = '#c9d2e0'; ctx.font = '600 13px -apple-system, system-ui, sans-serif'; ctx.fillText(mk, 30, y - 2); }
    }

    // fallande toner
    for (let i = lowerBound(notes, t - MAXDUR - 0.1, n => n.s); i < notes.length; i++) {
      const n = notes[i];
      if (n.s > t + LOOK) break;
      if (n.e < t) continue;
      const k = keys[n.p]; if (!k) continue;
      const yBottom = Math.min(kbTop, kbTop - (n.s - t) * pps);
      const yTop = Math.max(0, kbTop - (n.e - t) * pps);
      if (yBottom - yTop < 1) continue;
      const mine = S.mode === 'listen' || practiced(n.h);
      const c = COLORS[n.h];
      const pad = k.black ? 1 : Math.max(1.5, k.w * 0.08);
      const x = k.x + pad, w = k.w - pad * 2;
      ctx.globalAlpha = mine ? 1 : 0.28;
      let fill = k.black ? c.dark : c.main;
      if (mine && n.hit) fill = '#46cf7d';
      else if (mine && n.miss) fill = '#c94a4a';
      ctx.fillStyle = fill;
      rr(x, yTop, w, yBottom - yTop, Math.min(5, w / 3)); ctx.fill();
      ctx.globalAlpha = 1;
      if (n.s > t && mine && (S.fingers || S.names)) {
        const r = Math.max(7, Math.min(12, w * 0.46));
        let cy = yBottom - r - 3;
        if (S.fingers && n.f) { badge(x + w / 2, cy, r, n.f, n.h); cy -= r * 2 + 2; }
        if (S.names && yBottom - yTop > 26) {
          ctx.fillStyle = '#0d1118'; ctx.font = `600 ${Math.round(Math.min(12, w * 0.42))}px -apple-system, system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(NAMES[n.p % 12], x + w / 2, cy);
        }
      }
    }

    ctx.fillStyle = waiting ? '#ffd166' : '#3a4150';
    ctx.fillRect(0, kbTop - 2, W, 2);

    // klaviatur
    const lit = new Map(), accompLit = new Map();
    for (const n of active) {
      if (S.mode === 'listen' || practiced(n.h)) lit.set(n.p, n); else accompLit.set(n.p, n);
    }
    const pulse = waiting ? 0.55 + 0.45 * Math.sin(now / 160) : 1;
    const pend = waiting ? practice[pendIdx] : null;
    function keyLook(p, black) {
      const pr = pressed.get(p);
      if (pr) {
        if (pr.wrong) return { fill: '#ff5c5c', a: 1 };
        if (pr.src !== 'mic' || lit.has(p)) return { fill: '#46cf7d', a: 1 };
      }
      if (pend && pend.got.has(p)) return { fill: '#46cf7d', a: 1 };
      const n = lit.get(p);
      if (n) return { fill: black ? COLORS[n.h].main : COLORS[n.h].key, a: pulse };
      return null;
    }
    for (let p = LOW; p <= HIGH; p++) {
      const k = keys[p]; if (k.black) continue;
      rr(k.x + 0.5, kbTop, k.w - 1, kbH - 1, [0, 0, 5, 5]);
      ctx.fillStyle = '#f2f3f5'; ctx.fill();
      const look = keyLook(p, false);
      if (look) { ctx.globalAlpha = look.a; ctx.fillStyle = look.fill; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.strokeStyle = '#8d939e'; ctx.lineWidth = 1; ctx.stroke();
      if (accompLit.has(p)) { ctx.fillStyle = COLORS[accompLit.get(p).h].main; ctx.globalAlpha = 0.5; ctx.fillRect(k.x + 2, kbTop, k.w - 4, 4); ctx.globalAlpha = 1; }
      if (p % 12 === 0) {
        ctx.fillStyle = p === 60 ? '#2f78cc' : '#8a909b';
        ctx.font = `${p === 60 ? 700 : 500} ${Math.round(Math.max(9, Math.min(12, k.w * 0.4)))}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText('C' + (p / 12 - 1), k.x + k.w / 2, kbTop + kbH - 4);
      }
    }
    for (let p = LOW; p <= HIGH; p++) {
      const k = keys[p]; if (!k.black) continue;
      rr(k.x, kbTop, k.w, blackH, [0, 0, 3, 3]);
      ctx.fillStyle = '#1c1f26'; ctx.fill();
      const look = keyLook(p, true);
      if (look) { ctx.globalAlpha = look.a; ctx.fillStyle = look.fill; ctx.fill(); ctx.globalAlpha = 1; }
      if (accompLit.has(p)) { ctx.fillStyle = COLORS[accompLit.get(p).h].main; ctx.globalAlpha = 0.6; ctx.fillRect(k.x + 1, kbTop, k.w - 2, 4); ctx.globalAlpha = 1; }
    }
    for (const [p, n] of lit) {
      const k = keys[p]; if (!k) continue;
      const r = Math.max(7, Math.min(12, k.w * (k.black ? 0.5 : 0.36)));
      const cy = k.black ? kbTop + blackH - r - 4 : kbTop + kbH - r - 20;
      if (S.fingers && n.f) badge(k.x + k.w / 2, cy, r, n.f, n.h);
      if (S.names) {
        ctx.fillStyle = k.black ? '#fff' : '#1d2230';
        ctx.font = `600 ${Math.round(Math.max(9, Math.min(12, k.w * 0.4)))}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(NAMES[p % 12], k.x + k.w / 2, cy - r - 2);
      }
    }
  }

  // ---------- HUD ----------
  function fmt(x) { x = Math.max(0, x); const m = Math.floor(x / 60), s = Math.floor(x % 60); return m + ':' + String(s).padStart(2, '0'); }
  let lastHud = '', seeking = false;
  function updateHud() {
    const bar = barAt(Math.max(0, t));
    let name = '';
    for (let i = sections.length - 1; i > 0; i--) if (t >= sections[i].start - 0.01) { name = sections[i].name; break; }
    if (!name && sections[1]) name = sections[1].name;
    const sc = S.mode === 'wait' ? `Rätt ${score.ok}` + (score.bad ? ` · Fel ${score.bad}` : '')
      : S.mode === 'play' ? `Träffar ${score.ok} · Missar ${score.miss}` : '';
    const wt = mic.on ? 'Väntar på dig – spela de tända tangenterna' : 'Väntar – starta mikrofonen eller tryck på tangenterna';
    const hud = `${name}|${bar}|${sc}|${waiting}|${fmt(t)}|${wt}|${kbTop}`;
    if (hud !== lastHud) {
      lastHud = hud;
      $('whereName').textContent = name;
      $('whereBar').textContent = `takt ${bar} av ${BARS.length}`;
      $('score').textContent = sc;
      $('waitBox').hidden = !waiting;
      $('waitText').textContent = wt;
      $('waitBox').style.top = Math.max(40, kbTop - 54) + 'px';
      $('timeVal').textContent = `${fmt(t)} / ${fmt(DUR)}`;
    }
    if (!seeking) $('seek').value = String(Math.max(0, t));
  }
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---------- Huvudloop ----------
  let lastTs = performance.now();
  function update(dt) {
    if (!playing || waiting) return;
    let to = t + dt * S.tempo;
    let arrive = null;
    if (S.mode === 'wait') {
      const ev = practice[pendIdx];
      if (ev && ev.t < sec().end && ev.t <= to) { to = ev.t; arrive = ev; }
    }
    advance(to);
    t = to;
    if (arrive) arriveAt(arrive);
    if (S.mode === 'play') checkMisses();
    if (t >= sec().end + 0.5) sectionEnd();
  }
  function frame(now) {
    const dt = Math.min(0.1, (now - lastTs) / 1000);
    lastTs = now;
    micTick(now);
    update(dt);
    draw(now);
    updateHud();
    requestAnimationFrame(frame);
  }

  // ---------- Stämning ----------
  const tuneDlg = $('tuneDlg');
  let tuneVals = [];
  function centsText(c) {
    const r = Math.round(c);
    if (Math.abs(r) <= 3) return 'Ditt piano är rent stämt.';
    return `Ditt piano är ${Math.abs(r)} cent ${r < 0 ? 'lågt' : 'högt'} stämt.` + (Math.abs(r) > 60 ? ' Det är mycket – spelade du verkligen A4?' : '');
  }
  function showSaved() { $('tuneSaved').textContent = (S.tune > 0 ? '+' : '') + S.tune + ' cent'; }
  function tuneTick() {
    const det = mic.det;
    const pk = det.peak(400, 482);
    if (det.level < -58 || pk.snr < 16) return;
    const c = 1200 * Math.log2(pk.f / 440);
    tuneVals.push(c);
    if (tuneVals.length > 60) tuneVals.shift();
    const sorted = tuneVals.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    $('tuneNow').textContent = (med > 0 ? '+' : '') + Math.round(med) + ' cent';
    $('tuneInfo').textContent = tuneVals.length < 8 ? 'Lyssnar … spela A4 igen.' : centsText(med);
    $('tuneSave').disabled = tuneVals.length < 8;
    tuneDlg.dataset.med = String(med);
  }
  $('tuneBtn').addEventListener('click', async () => {
    tuneVals = [];
    $('tuneNow').textContent = '–';
    $('tuneInfo').textContent = 'Väntar på tonen …';
    $('tuneSave').disabled = true;
    $('sens').value = String(Math.round(S.sens * 100));
    $('sensVal').textContent = Math.round(S.sens * 100) + ' %';
    showSaved();
    tuneDlg.showModal();
    if (!(await startMic())) $('tuneInfo').textContent = 'Mikrofonen behövs för att stämma av.';
  });
  $('tuneSave').addEventListener('click', () => {
    S.tune = Math.round(+tuneDlg.dataset.med || 0);
    if (mic.det) mic.det.setTune(S.tune);
    saveSettings(); showSaved();
    toast('Stämningen sparad: ' + centsText(S.tune));
    tuneDlg.close();
  });
  $('tuneReset').addEventListener('click', () => {
    S.tune = 0; if (mic.det) mic.det.setTune(0); saveSettings(); showSaved(); tuneVals = [];
    $('tuneNow').textContent = '–'; $('tuneSave').disabled = true;
  });
  $('tuneCancel').addEventListener('click', () => tuneDlg.close());
  $('sens').addEventListener('input', e => {
    S.sens = +e.target.value / 100;
    $('sensVal').textContent = Math.round(S.sens * 100) + ' %';
    if (mic.det) mic.det.sensitivity = S.sens;
    saveSettings();
  });

  // ---------- Kontroller ----------
  function setSeg(id, value) {
    document.querySelectorAll(`#${id} button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
  }
  function onSettingsChanged(rebuild) {
    saveSettings();
    if (rebuild) { buildPractice(); seek(t, false); }
  }
  function bindSeg(id, key) {
    document.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener('click', () => {
      S[key] = b.dataset.v; setSeg(id, S[key]); onSettingsChanged(true); b.blur();
    }));
    setSeg(id, S[key]);
  }
  bindSeg('handSeg', 'hand');
  bindSeg('modeSeg', 'mode');

  const secSel = $('sectionSel');
  secSel.addEventListener('change', () => { S.section = +secSel.value; saveSettings(); restartSection(false); secSel.blur(); });

  function bindChk(id, key, rebuild) {
    const el = $(id); el.checked = !!S[key];
    el.addEventListener('change', () => { S[key] = el.checked; onSettingsChanged(rebuild); el.blur(); });
  }
  bindChk('loopChk', 'loop', false);
  bindChk('fingerChk', 'fingers', false);
  bindChk('nameChk', 'names', false);
  bindChk('accompChk', 'accomp', true);

  const soundSel = $('soundSel');
  soundSel.value = S.sound;
  soundSel.addEventListener('change', () => { S.sound = soundSel.value; stopAll(); onSettingsChanged(true); soundSel.blur(); });

  const tempo = $('tempo');
  function showTempo() { $('tempoVal').textContent = `${Math.round(BPM * S.tempo)} BPM (${Math.round(S.tempo * 100)} %)`; }
  tempo.value = String(Math.round(S.tempo * 100));
  tempo.addEventListener('input', () => { S.tempo = +tempo.value / 100; showTempo(); saveSettings(); });

  $('playBtn').addEventListener('click', e => { setPlaying(!playing); e.currentTarget.blur(); });
  $('restartBtn').addEventListener('click', e => { restartSection(playing); e.currentTarget.blur(); });
  $('skipBtn').addEventListener('click', e => {
    const ev = practice[pendIdx];
    if (waiting && ev) completeEvent(ev, true);
    e.currentTarget.blur();
  });
  $('micBtn').addEventListener('click', e => { if (mic.on) stopMic(); else startMic(); e.currentTarget.blur(); });

  const seekEl = $('seek');
  seekEl.addEventListener('pointerdown', () => { seeking = true; });
  seekEl.addEventListener('pointerup', () => { seeking = false; seekEl.blur(); });
  seekEl.addEventListener('input', () => {
    const v = +seekEl.value;
    if (v < sec().start - LEAD || v > sec().end) { S.section = 0; secSel.value = '0'; saveSettings(); }
    seek(v, false);
  });

  const help = $('help');
  $('helpBtn').addEventListener('click', () => help.showModal());
  $('helpClose').addEventListener('click', () => help.close());

  document.addEventListener('keydown', e => {
    if (help.open || tuneDlg.open) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === 'r' || e.key === 'R') restartSection(playing);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const b = barAt(Math.max(0, t)) - 1 + (e.key === 'ArrowRight' ? 1 : -1);
      seek(BARS[Math.max(0, Math.min(BARS.length - 1, b))], false);
    }
  });

  // tryck på skärmens tangenter
  const pointerNotes = new Map();
  function keyAt(x, y) {
    if (y < kbTop) return -1;
    if (y < kbTop + blackH) {
      for (let p = LOW; p <= HIGH; p++) { const k = keys[p]; if (k.black && x >= k.x && x < k.x + k.w) return p; }
    }
    for (let p = LOW; p <= HIGH; p++) { const k = keys[p]; if (!k.black && x >= k.x && x < k.x + k.w) return p; }
    return -1;
  }
  function pointerPos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  cv.addEventListener('pointerdown', e => {
    const p = keyAt(...pointerPos(e)); if (p < 0) return;
    cv.setPointerCapture(e.pointerId);
    pointerNotes.set(e.pointerId, p); userNoteOn(p, 'mouse');
  });
  cv.addEventListener('pointermove', e => {
    if (!pointerNotes.has(e.pointerId)) return;
    const p = keyAt(...pointerPos(e)), old = pointerNotes.get(e.pointerId);
    if (p !== old && p >= 0) { userNoteOff(old, 'mouse'); pointerNotes.set(e.pointerId, p); userNoteOn(p, 'mouse'); }
  });
  function pointerEnd(e) {
    if (!pointerNotes.has(e.pointerId)) return;
    userNoteOff(pointerNotes.get(e.pointerId), 'mouse'); pointerNotes.delete(e.pointerId);
  }
  cv.addEventListener('pointerup', pointerEnd);
  cv.addEventListener('pointercancel', pointerEnd);

  // ---------- Öppna låt ----------
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function openMidi(bytes, name, remember) {
    const songData = PianoMidi.buildSong(PianoMidi.parseMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), name);
    S.section = 0;
    loadSong(songData);
    if (remember) {
      try { localStorage.setItem('po-song', JSON.stringify({ name, b64: toB64(bytes) })); } catch (e) { /* för stor eller ingen lagring */ }
    }
  }
  async function openFile(file) {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      openMidi(bytes, file.name.replace(/\.(mid|midi|kar)$/i, ''), true);
      toast('Öppnade ' + title + '. Tryck ▶ Spela när du är redo.');
    } catch (e) {
      toast('Kunde inte öppna filen: ' + e.message);
    }
  }
  $('songBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
  const stage = $('stage');
  window.addEventListener('dragover', e => { e.preventDefault(); $('dropHint').classList.add('show'); });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) $('dropHint').classList.remove('show'); });
  window.addEventListener('drop', e => {
    e.preventDefault(); $('dropHint').classList.remove('show');
    if (e.dataTransfer && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
  new ResizeObserver(() => { layout(); draw(performance.now()); }).observe(cv);

  // ---------- Start ----------
  let loaded = false;
  try {
    const saved = JSON.parse(localStorage.getItem('po-song') || 'null');
    if (saved && saved.b64) { const sec0 = S.section; openMidi(fromB64(saved.b64), saved.name, false); S.section = sec0; loaded = true; }
  } catch (e) { /* sparad låt gick inte att läsa */ }
  if (!loaded) loadSong(demoSong());
  if (S.section > 0 && S.section < sections.length) { secSel.value = String(S.section); restartSection(false); }
  try {
    if (!localStorage.getItem('po-help-seen')) { help.showModal(); localStorage.setItem('po-help-seen', '1'); }
  } catch (e) { /* ok */ }
  requestAnimationFrame(frame);

  // för felsökning och test
  window.__po = { S, get t() { return t; }, get waiting() { return waiting; }, get playing() { return playing; },
    get practice() { return practice; }, get notes() { return notes; }, get sections() { return sections; },
    get mic() { return mic; }, score, userNoteOn, userNoteOff, setPlaying, seek, update, startMic,
    micTick: now => micTick(now), loadDemo: () => loadSong(demoSong()) };
})();
