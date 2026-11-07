// Räknar ut en fingersättning (1 = tumme … 5 = lillfinger) för varje ton.
// Dynamisk programmering med avståndsregler från Parncutt m.fl. (1997).
(function (g) {
  'use strict';

  // (MinPrac, MinComf, MinRel, MaxRel, MaxComf, MaxPrac) i halvtoner för höger hand
  const SPAN = {
    '1,2': [-5, -3, 1, 5, 8, 10],
    '1,3': [-4, -2, 3, 7, 10, 12],
    '1,4': [-3, -1, 5, 9, 12, 14],
    '1,5': [-1, 1, 7, 10, 13, 15],
    '2,3': [1, 1, 1, 2, 3, 5],
    '2,4': [1, 1, 3, 4, 5, 7],
    '2,5': [2, 2, 5, 6, 8, 10],
    '3,4': [1, 1, 1, 2, 2, 4],
    '3,5': [1, 1, 3, 4, 5, 7],
    '4,5': [1, 1, 1, 2, 3, 5],
  };
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = p => BLACK.has(p % 12);
  const REST = {
    R: { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7 },
    L: { 5: 0, 4: 2, 3: 4, 2: 5, 1: 7 },
  };

  function spanCost(fa, na, fb, nb, hand) {
    if (fa > fb) { [fa, na, fb, nb] = [fb, nb, fa, na]; }
    const d = hand === 'R' ? nb - na : na - nb;
    const [mnP, mnC, mnR, mxR, mxC, mxP] = SPAN[fa + ',' + fb];
    let c = 0;
    if (d < mnR) c += mnR - d;
    if (d > mxR) c += d - mxR;
    if (d < mnC) c += 2 * (mnC - d);
    if (d > mxC) c += 2 * (d - mxC);
    if (d < mnP) c += 10 + 3 * (mnP - d);
    if (d > mxP) c += 10 + 3 * (d - mxP);
    if (fa === 1 && d < 0) {            // tumme under / finger över tummen
      c += 1;
      if (isBlack(na) && !isBlack(nb)) c += 2;
    }
    return c;
  }

  function staticCost(fs, ps) {
    let c = 0;
    for (let k = 0; k < fs.length; k++) {
      if (fs[k] === 1 && isBlack(ps[k])) c += 1.5;
      if (fs[k] === 5 && isBlack(ps[k]) && ps.length === 1) c += 0.8;
    }
    if (ps.length === 1) c += ({ 4: 0.4, 5: 0.25 })[fs[0]] || 0;
    return c;
  }

  function chordCost(fs, ps, hand) {
    let c = 0;
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) c += spanCost(fs[a], ps[a], fs[b], ps[b], hand);
    return c;
  }

  function combos(k) {
    const out = [];
    const rec = (start, acc) => {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let f = start; f <= 5; f++) { acc.push(f); rec(f + 1, acc); acc.pop(); }
    };
    rec(1, []);
    return out;
  }
  const COMBOS = [null, combos(1), combos(2), combos(3), combos(4), combos(5)];

  function candidates(k, hand) {
    const cs = COMBOS[Math.min(k, 5)];
    return hand === 'R' ? cs : cs.map(c => c.slice().reverse());
  }

  function handPos(ev, fs, hand) {
    const rest = REST[hand];
    let s = 0;
    for (let k = 0; k < ev.length; k++) s += ev[k].p - rest[fs[k]];
    return s / ev.length;
  }

  function transitionCost(prev, pf, cur, cf, hand) {
    const onset = cur[0].s;
    const release = Math.min(Math.max(...prev.map(n => n.e)), onset);
    const gap = onset - release;
    const factor = 1 / (1 + 4 * Math.max(gap, 0));
    let cost = 0;
    if (prev.length === 1 && cur.length === 1) {
      const f1 = pf[0], f2 = cf[0], n1 = prev[0], n2 = cur[0];
      if (f1 === f2) cost += n1.p === n2.p ? 0 : 6;
      else {
        cost += spanCost(f1, n1.p, f2, n2.p, hand);
        if (f1 === 3 && f2 === 4) cost += 1;
        else if (f1 === 4 && f2 === 3) cost += 0.5;
      }
    } else {
      const dpos = Math.abs(handPos(cur, cf, hand) - handPos(prev, pf, hand));
      cost += 0.5 * Math.max(0, dpos - 1);
      for (let a = 0; a < prev.length; a++) for (let b = 0; b < cur.length; b++) {
        if (pf[a] === cf[b] && prev[a].p !== cur[b].p) cost += (prev.length > 1 && cur.length > 1) ? 0.5 : 1.5;
      }
    }
    let hard = 0;
    for (let a = 0; a < prev.length; a++) {
      if (prev[a].e <= onset + 0.01) continue;
      for (let b = 0; b < cur.length; b++) {
        if (pf[a] === cf[b] && prev[a].p !== cur[b].p) hard += 12;
        else if (pf[a] !== cf[b]) hard += 0.5 * spanCost(pf[a], prev[a].p, cf[b], cur[b].p, hand);
      }
    }
    return factor * cost + hard;
  }

  function makeEvents(notes) {
    const evs = [];
    let cur = null;
    for (const n of notes) {
      if (cur && Math.abs(n.s - cur[0].s) < 0.005) cur.push(n);
      else { cur = [n]; evs.push(cur); }
    }
    for (const ev of evs) ev.sort((a, b) => a.p - b.p);
    return evs;
  }

  function fingerHand(notes, hand) {
    const events = makeEvents(notes.slice().sort((a, b) => a.s - b.s || a.p - b.p));
    const layers = [];
    events.forEach((ev, i) => {
      if (ev.length > 5) {                          // fler än 5 toner: ta de 5 yttersta/viktigaste
        const keep = ev.slice(0, 2).concat(ev.slice(-3));
        ev.filter(n => !keep.includes(n)).forEach(n => { n.f = 0; });
        ev.splice(0, ev.length, ...keep);
      }
      const ps = ev.map(n => n.p);
      const layer = new Map();
      for (const cf of candidates(ev.length, hand)) {
        const base = staticCost(cf, ps) + 1.5 * chordCost(cf, ps, hand);
        if (i === 0) { layer.set(cf, [base, null]); continue; }
        let best = Infinity, bp = null;
        for (const [pf, [pc]] of layers[i - 1]) {
          const c = pc + transitionCost(events[i - 1], pf, ev, cf, hand);
          if (c < best) { best = c; bp = pf; }
        }
        layer.set(cf, [base + best, bp]);
      }
      layers.push(layer);
    });
    if (!layers.length) return;
    let cf = null, bc = Infinity;
    for (const [k, [c]] of layers[layers.length - 1]) if (c < bc) { bc = c; cf = k; }
    for (let i = events.length - 1; i >= 0; i--) {
      events[i].forEach((n, k) => { n.f = cf[k]; });
      cf = layers[i].get(cf)[1];
    }
  }

  function assignFingers(notes) {
    fingerHand(notes.filter(n => n.h === 'R'), 'R');
    fingerHand(notes.filter(n => n.h === 'L'), 'L');
    return notes;
  }

  g.PianoFingering = { assignFingers };
})(typeof globalThis !== 'undefined' ? globalThis : window);
