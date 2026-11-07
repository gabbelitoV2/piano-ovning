// Läser en Standard MIDI File och gör om den till en låt för övningsappen.
(function (g) {
  'use strict';

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } catch (e) { /* inte UTF-8 */ }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s.trim();
  }

  function parseMidi(buffer) {
    const d = new Uint8Array(buffer);
    let i = 0;
    const need = n => { if (i + n > d.length) throw new Error('MIDI-filen är trasig eller avkortad.'); };
    const str = n => { need(n); let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(d[i + k]); i += n; return s; };
    const u32 = () => { need(4); const v = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0; i += 4; return v; };
    const u16 = () => { need(2); const v = (d[i] << 8) | d[i + 1]; i += 2; return v; };
    const vlq = () => { let v = 0, b, n = 0; do { need(1); b = d[i++]; v = (v << 7) | (b & 0x7f); n++; } while ((b & 0x80) && n < 4); return v; };

    if (d.length < 14 || str(4) !== 'MThd') throw new Error('Det här är ingen MIDI-fil (.mid).');
    const hlen = u32();
    const format = u16(), ntrks = u16(), division = u16();
    i += Math.max(0, hlen - 6);
    if (division & 0x8000) throw new Error('MIDI-filer med SMPTE-tid stöds inte.');

    const tracks = [];
    while (i + 8 <= d.length && tracks.length < Math.max(ntrks, 1) + 64) {
      const id = str(4), len = u32(), end = Math.min(d.length, i + len);
      if (id !== 'MTrk') { i = end; continue; }
      const ev = [];
      let tick = 0, status = 0, name = '';
      while (i < end) {
        tick += vlq();
        need(1);
        const b = d[i];
        if (b === 0xFF) {
          i++; const type = d[i++]; const l = vlq(); need(l);
          const data = d.subarray(i, i + l); i += l;
          if (type === 0x51 && l === 3) ev.push({ tick, type: 'tempo', v: (data[0] << 16) | (data[1] << 8) | data[2] });
          else if (type === 0x58 && l >= 2) ev.push({ tick, type: 'ts', num: data[0], den: 1 << data[1] });
          else if (type === 0x06) ev.push({ tick, type: 'marker', text: decodeText(data) });
          else if (type === 0x03 && !name) name = decodeText(data);
          else if (type === 0x2F) break;
          continue;
        }
        if (b === 0xF0 || b === 0xF7) { i++; const l = vlq(); i += l; continue; }
        if (b & 0x80) { status = b; i++; }
        else if (!status) throw new Error('MIDI-filen är trasig (saknar status).');
        const hi = status & 0xF0, ch = status & 0x0F;
        need(1);
        const a = d[i++];
        const two = !(hi === 0xC0 || hi === 0xD0);
        const v = two ? d[i++] : 0;
        if (hi === 0x90 && v > 0) ev.push({ tick, type: 'on', ch, p: a, v });
        else if (hi === 0x80 || (hi === 0x90 && v === 0)) ev.push({ tick, type: 'off', ch, p: a });
        else if (hi === 0xB0 && a === 64) ev.push({ tick, type: 'pedal', ch, v });
      }
      i = end;
      tracks.push({ name, events: ev });
    }
    return { format, division, tracks };
  }

  // Delar upp tonerna på höger (R) och vänster (L) hand.
  function assignHands(notes) {
    const groups = new Map();
    for (const n of notes) {
      const k = n.tr + ':' + n.ch;
      if (!groups.has(k)) groups.set(k, { k, tr: n.tr, ch: n.ch, notes: [] });
      groups.get(k).notes.push(n);
    }
    const list = [...groups.values()].filter(gr => gr.ch !== 9);   // inga trummor
    const avg = gr => gr.notes.reduce((s, n) => s + n.p, 0) / gr.notes.length;
    // Casio-lektionsformat: kanal 4 = höger, kanal 3 = vänster
    const c4 = list.filter(gr => gr.ch === 3), c3 = list.filter(gr => gr.ch === 2);
    if (c4.length && c3.length) {
      c4.forEach(gr => gr.notes.forEach(n => { n.h = 'R'; }));
      c3.forEach(gr => gr.notes.forEach(n => { n.h = 'L'; }));
      return notes.filter(n => n.h);
    }
    list.sort((a, b) => b.notes.length - a.notes.length);
    if (list.length >= 2 && list[1].notes.length >= 0.1 * list[0].notes.length) {
      const [a, b] = list;
      const [r, l] = avg(a) >= avg(b) ? [a, b] : [b, a];
      r.notes.forEach(n => { n.h = 'R'; });
      l.notes.forEach(n => { n.h = 'L'; });
      return notes.filter(n => n.h);
    }
    // en enda stämma: dela vid mitt-C
    const main = list.length ? list[0].notes : [];
    main.forEach(n => { n.h = n.p >= 60 ? 'R' : 'L'; });
    return main;
  }

  function buildSong(parsed, title) {
    const tpb = parsed.division || 480;
    const all = [];
    parsed.tracks.forEach((t, tr) => t.events.forEach(e => all.push(Object.assign({ tr }, e))));

    const tempos = all.filter(e => e.type === 'tempo').sort((a, b) => a.tick - b.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, v: 500000 });
    const segs = [];
    let sec = 0;
    for (let k = 0; k < tempos.length; k++) {
      if (k > 0) sec += (tempos[k].tick - tempos[k - 1].tick) * tempos[k - 1].v / 1e6 / tpb;
      segs.push({ tick: tempos[k].tick, sec, v: tempos[k].v });
    }
    const t2s = tick => {
      let s = segs[0];
      for (let k = 1; k < segs.length && segs[k].tick <= tick; k++) s = segs[k];
      return s.sec + (tick - s.tick) * s.v / 1e6 / tpb;
    };

    // noter: para ihop på/av per spår, kanal och tonhöjd
    let notes = [];
    parsed.tracks.forEach((t, tr) => {
      const open = new Map();
      for (const e of t.events) {
        const key = e.ch * 128 + e.p;
        if (e.type === 'on') {
          if (!open.has(key)) open.set(key, []);
          open.get(key).push(e);
        } else if (e.type === 'off' && open.has(key) && open.get(key).length) {
          const on = open.get(key).shift();
          if (e.tick > on.tick) notes.push({ tr, ch: e.ch, p: e.p, v: on.v, st: on.tick, et: e.tick });
        }
      }
      for (const arr of open.values()) for (const on of arr) notes.push({ tr, ch: on.ch, p: on.p, v: on.v, st: on.tick, et: on.tick + tpb });
    });
    if (!notes.length) throw new Error('MIDI-filen innehåller inga toner.');
    notes = assignHands(notes);
    const endTick = notes.reduce((m, n) => Math.max(m, n.et), 0);

    // takter
    const tss = all.filter(e => e.type === 'ts').sort((a, b) => a.tick - b.tick);
    const bars = [];
    let tk = 0, num = 4, den = 4, ti = 0;
    while (tk < endTick && bars.length < 5000) {
      while (ti < tss.length && tss[ti].tick <= tk) { num = tss[ti].num || 4; den = tss[ti].den || 4; ti++; }
      bars.push(t2s(tk));
      tk += Math.max(1, Math.round(num * tpb * 4 / den));
    }
    const duration = t2s(Math.max(endTick, tk));

    // pedal: en gemensam pedal (som på ett riktigt piano), bara ändringar
    const pedalRaw = all.filter(e => e.type === 'pedal').sort((a, b) => a.tick - b.tick);
    const pedal = [];
    let down = false;
    for (const e of pedalRaw) {
      const on = e.v >= 64;
      if (on !== down) { pedal.push([t2s(e.tick), on ? 127 : 0]); down = on; }
    }

    const markers = all.filter(e => e.type === 'marker' && e.text).sort((a, b) => a.tick - b.tick)
      .map(e => ({ t: t2s(e.tick), name: e.text }));

    const firstTick = notes.reduce((m, n) => Math.min(m, n.st), Infinity);
    let tempoAtStart = segs[0];
    for (const s of segs) if (s.tick <= firstTick) tempoAtStart = s;

    return {
      title: title || 'Låt',
      duration,
      bpm: Math.round(60e6 / tempoAtStart.v),
      bars,
      markers,
      pedal,
      notes: notes.map(n => ({ s: t2s(n.st), e: t2s(n.et), p: n.p, h: n.h, v: n.v }))
        .sort((a, b) => a.s - b.s || a.p - b.p),
    };
  }

  g.PianoMidi = { parseMidi, buildSong };
})(typeof globalThis !== 'undefined' ? globalThis : window);
