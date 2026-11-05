/*
 * Retro SETI — a tribute to the classic (1999–2005) SETI@home screensaver.
 * All data is simulated. Nothing is downloaded or uploaded.
 *
 * URL parameters:
 *   ?name=Your+Name   user name shown in the User Info panel (remembered)
 *   ?wu=15            minutes per simulated work unit (0.5 – 600)
 *   ?panels=0         start with the text panels hidden (H toggles)
 */
(() => {
  'use strict';

  // ---------- config ----------
  const VW = 1600, VH = 1000;          // virtual canvas, letterboxed to the window
  const NF = 48, NT = 40;              // frequency bins x time rows in the 3D graph
  const ROWS_PER_SEC = 9;
  const params = new URLSearchParams(location.search);
  const WU_SECONDS = clamp(parseFloat(params.get('wu')) || 15, 0.5, 600) * 60;
  const FFTS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pad(n, w = 2) { return String(Math.floor(n)).padStart(w, '0'); }

  // ---------- persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('retroseti.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('retroseti.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const user = {
    name: params.get('name') || store.get('name', 'Anonymous Listener'),
    wus: store.get('wus', 0),
    cpu: store.get('cpu', 0),            // seconds
    since: store.get('since', Date.now()),
  };
  if (params.get('name')) store.set('name', user.name);
  store.set('since', user.since);

  // ---------- colour palette (height -> colour) ----------
  const STOPS = [[0, [20, 40, 200]], [0.22, [0, 150, 255]], [0.42, [0, 215, 90]],
                 [0.62, [240, 235, 0]], [0.8, [255, 130, 0]], [1, [255, 25, 25]]];
  function heat(t) {
    t = clamp(t, 0, 1);
    for (let i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i][0]) {
        const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
        const f = (t - t0) / (t1 - t0);
        return c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  const LEVELS = 64;
  const SHADES = [];
  for (let i = 0; i < LEVELS; i++) {
    const [r, g, b] = heat(i / (LEVELS - 1));
    const s = (k) => `rgb(${Math.min(255, Math.round(r * k))},${Math.min(255, Math.round(g * k))},${Math.min(255, Math.round(b * k))})`;
    SHADES.push({ front: s(0.85), top: s(1.25), side: s(0.55) });
  }

  // ---------- work unit simulation ----------
  const MONTHS = ['ja', 'fe', 'mr', 'ap', 'my', 'jn', 'jl', 'au', 'se', 'oc', 'no', 'de'];
  function jdToDate(jd) { return new Date((jd - 2440587.5) * 86400000); }

  function newWorkUnit() {
    const jd = rand(2451179.5, 2453550);
    const d = jdToDate(jd);
    const name = `${pad(d.getUTCDate())}${MONTHS[d.getUTCMonth()]}${pad(d.getUTCFullYear() % 100)}a${'abcdefgh'[Math.floor(rand(0, 8))]}` +
      `.${Math.floor(rand(10000, 32000))}.${Math.floor(rand(1000, 9999))}.${Math.floor(rand(100000, 999999))}.${Math.floor(rand(1, 250))}`;
    return {
      name, jd,
      ra: rand(0, 24), dec: rand(-1.5, 38),
      base: 1418750000 + Math.floor(rand(0, 256)) * 9765.625,
      angle: rand(0.003, 3.2),
      p: 0, cpu: 0,
      chirpSteps: Math.max(8, Math.round(WU_SECONDS / 20)),
      bestGauss: null, bestSpike: null,
      gauss: null,
    };
  }

  let wu = newWorkUnit();
  let phase = 'analyze';     // 'analyze' | 'sending' | 'receiving'
  let phaseT = 0;
  const rows = [];           // rows[0] = newest spectrum (Float32Array of powers)
  let rowAcc = 0;

  function analysisState(p) {
    if (p < 0.012) return { act: 'Doing baseline smoothing', chirp: 0, fft: 0 };
    const q = (p - 0.012) / 0.988 * wu.chirpSteps;
    const ci = Math.floor(q), fr = q - ci;
    const k = Math.ceil(ci / 2), sign = ci % 2 ? 1 : -1;
    const chirp = sign * k * (50 / (wu.chirpSteps / 2));
    const fx = fr * FFTS.length, fi = Math.min(FFTS.length - 1, Math.floor(fx)), ff = fx - fi;
    const act = ff < 0.5 ? 'Computing Fourier transforms'
      : ff < 0.68 ? 'Searching for spikes'
      : ff < 0.86 ? 'Searching for gaussians'
      : 'Searching for pulses and triplets';
    return { act, chirp, fft: FFTS[fi] };
  }

  function makeRow() {
    const row = new Float32Array(NF);
    for (let i = 0; i < NF; i++) row[i] = -Math.log(1 - Math.random()) * 1.2; // chi-square-ish noise
    const st = analysisState(wu.p);

    // occasional narrow spike
    if (Math.random() < 0.035) {
      const b = Math.floor(rand(0, NF));
      row[b] += rand(4, 14);
      if (b > 0) row[b - 1] += rand(0, 2);
      if (b < NF - 1) row[b + 1] += rand(0, 2);
    }
    // gaussian drifting through the telescope beam
    if (!wu.gauss && Math.random() < 0.025) {
      const len = Math.floor(rand(28, 44));
      wu.gauss = { bin: Math.floor(rand(2, NF - 2)), len, sigma: len / rand(5, 7), amp: rand(1.5, 7), i: 0, samples: [] };
    }
    if (wu.gauss) {
      const g = wu.gauss, c = g.len / 2;
      const v = g.amp * Math.exp(-0.5 * ((g.i - c) / g.sigma) ** 2);
      row[g.bin] += v;
      if (g.bin > 0) row[g.bin - 1] += v * 0.25;
      g.samples.push(row[g.bin]);
      if (++g.i >= g.len) {
        const fit = rand(0.4, 4.5);
        const power = g.amp + rand(-0.3, 0.3);
        const score = power / fit;
        if (!wu.bestGauss || score > wu.bestGauss.score) {
          wu.bestGauss = { power, fit, score, samples: g.samples, sigma: g.sigma, amp: g.amp, len: g.len,
                           chirp: st.chirp, freq: rand(-1.2e6, 1.2e6) };
        }
        wu.gauss = null;
      }
    }
    // track best spike
    let mi = 0;
    for (let i = 1; i < NF; i++) if (row[i] > row[mi]) mi = i;
    if (!wu.bestSpike || row[mi] > wu.bestSpike.power) {
      wu.bestSpike = { power: row[mi], bin: mi, spectrum: Float32Array.from(row), chirp: st.chirp,
                       fft: st.fft || 8, freq: rand(-1.2e6, 1.2e6), score: Math.log10(row[mi] + 1) };
    }
    return row;
  }

  for (let i = 0; i < NT; i++) rows.push(makeRow().map(() => 0));

  // ---------- simulation tick ----------
  let saveAcc = 0;
  function tick(dt) {
    phaseT += dt;
    if (phase === 'analyze') {
      wu.p += dt / WU_SECONDS;
      wu.cpu += dt;
      user.cpu += dt;
      rowAcc += dt * ROWS_PER_SEC;
      while (rowAcc >= 1) {
        rowAcc -= 1;
        rows.unshift(makeRow());
        if (rows.length > NT + 1) rows.length = NT + 1;
      }
      if (wu.p >= 1) {
        wu.p = 1; phase = 'sending'; phaseT = 0;
        user.wus++; store.set('wus', user.wus); store.set('cpu', user.cpu);
      }
    } else if (phase === 'sending' && phaseT > 4) {
      phase = 'receiving'; phaseT = 0;
    } else if (phase === 'receiving' && phaseT > 4) {
      wu = newWorkUnit(); phase = 'analyze'; phaseT = 0;
    }
    if (phase !== 'analyze') {
      // let the graph drain away while "talking to the server"
      rowAcc += dt * ROWS_PER_SEC;
      while (rowAcc >= 1) { rowAcc -= 1; rows.unshift(new Float32Array(NF)); rows.length = Math.min(rows.length, NT + 1); }
    }
    saveAcc += dt;
    if (saveAcc > 5) { saveAcc = 0; store.set('cpu', user.cpu); }
  }

  // ---------- drawing helpers ----------
  const FONT = 'Verdana, Tahoma, "DejaVu Sans", Arial, sans-serif';
  const C = {
    panel: 'rgba(0, 8, 40, 0.92)', border: '#3d5aa0', title: '#ffd040', titleBar: '#0b1d5c',
    label: '#8fa8e8', value: '#ffffff', dim: '#5b6fa8', accent: '#ffd040',
  };

  function font(px, bold) { ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT}`; }

  function panel(x, y, w, h, title) {
    ctx.fillStyle = C.panel; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.titleBar; ctx.fillRect(x, y, w, 30);
    ctx.strokeStyle = C.border; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.beginPath(); ctx.moveTo(x, y + 30); ctx.lineTo(x + w, y + 30); ctx.stroke();
    font(17, true); ctx.fillStyle = C.title; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(title, x + 12, y + 16);
  }

  function kv(x, y, label, value, labelW = 150) {
    font(16); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillStyle = C.label; ctx.fillText(label, x, y);
    ctx.fillStyle = C.value; ctx.fillText(value, x + labelW, y);
  }

  function fmtDuration(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return `${h} hr ${pad(m)} min ${s.toFixed(1).padStart(4, '0')} sec`;
  }
  function fmtRA(ra) { const h = Math.floor(ra), m = Math.floor((ra - h) * 60), s = Math.floor(((ra - h) * 60 - m) * 60); return `${h} hr ${pad(m)} min ${pad(s)} sec RA`; }
  function fmtDec(dec) { return `${dec >= 0 ? '+' : ''}${dec.toFixed(2)} Dec`; }
  function fmtHz(hz) { return `${hz >= 0 ? '+' : ''}${hz.toFixed(2)} Hz`; }

  // ---------- panels ----------
  function drawHeader(now) {
    font(34, true); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd040'; ctx.fillText('RETRO', 24, 38);
    const w = ctx.measureText('RETRO ').width;
    ctx.fillStyle = '#ff3a2a'; ctx.fillText('SETI', 24 + w, 38);
    font(15); ctx.fillStyle = C.dim;
    ctx.fillText('Search for Extraterrestrial Intelligence  •  classic screensaver tribute', 24 + w + ctx.measureText('SETI').width * 2.3 + 14, 41);
    ctx.textAlign = 'right'; font(16); ctx.fillStyle = C.label;
    ctx.fillText(now.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }), VW - 24, 40);
  }

  function drawAnalysis(x, y, w, h) {
    panel(x, y, w, h, 'Data Analysis');
    const st = analysisState(wu.p);
    font(20, true); ctx.fillStyle = C.accent; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let act = st.act;
    if (phase === 'sending') act = 'Work unit complete — sending results';
    if (phase === 'receiving') act = 'Receiving new work unit';
    const dots = '.'.repeat(1 + Math.floor(performance.now() / 400) % 3);
    ctx.fillText(act + dots, x + 16, y + 64);
    kv(x + 16, y + 98, 'Chirp rate:', phase === 'analyze' ? `${st.chirp.toFixed(4)} Hz/sec` : '—');
    kv(x + 16, y + 124, 'FFT length:', phase === 'analyze' && st.fft ? String(st.fft) : '—');
    kv(x + 16, y + 150, 'CPU time:', fmtDuration(wu.cpu));
    kv(x + 16, y + 176, 'Work unit:', wu.name);
    // progress bar
    const bx = x + 16, by = y + h - 46, bw = w - 32 - 110, bh = 22;
    ctx.fillStyle = '#000418'; ctx.fillRect(bx, by, bw, bh);
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, '#1428c8'); g.addColorStop(0.5, '#00a0ff'); g.addColorStop(1, '#00dc5a');
    ctx.fillStyle = g; ctx.fillRect(bx, by, bw * wu.p, bh);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    font(18, true); ctx.fillStyle = C.value; ctx.textAlign = 'right';
    ctx.fillText(`${(wu.p * 100).toFixed(3)}%`, x + w - 16, by + 18);
  }

  function drawDataInfo(x, y, w, h) {
    panel(x, y, w, h, 'Data Info');
    const d = jdToDate(wu.jd);
    kv(x + 16, y + 64, 'From:', fmtRA(wu.ra), 130);
    kv(x + 16, y + 90, '', fmtDec(wu.dec), 130);
    kv(x + 16, y + 120, 'Recorded on:', wu.jd.toFixed(5), 130);
    kv(x + 16, y + 146, '', d.toUTCString().replace(' GMT', ' UTC'), 130);
    kv(x + 16, y + 176, 'Source:', 'Arecibo Radio Observatory', 130);
    kv(x + 16, y + 206, 'Base freq.:', `${(wu.base / 1e9).toFixed(9)} GHz`, 130);
    kv(x + 16, y + 236, 'Angle range:', wu.angle.toFixed(3), 130);
  }

  function drawUserInfo(x, y, w, h) {
    panel(x, y, w, h, 'User Info');
    kv(x + 16, y + 64, 'Name:', user.name.slice(0, 28), 160);
    kv(x + 16, y + 94, 'Work units:', user.wus.toLocaleString(), 160);
    const hrs = Math.floor(user.cpu / 3600), mins = Math.floor(user.cpu / 60) % 60;
    kv(x + 16, y + 124, 'Total CPU time:', `${hrs.toLocaleString()} hr ${pad(mins)} min`, 160);
    kv(x + 16, y + 154, 'Avg per unit:', user.wus ? fmtDuration(user.cpu / user.wus).replace(/\.\d sec/, ' sec') : '—', 160);
    kv(x + 16, y + 184, 'Listening since:', new Date(user.since).toLocaleDateString(), 160);
    font(13); ctx.fillStyle = C.dim; ctx.textAlign = 'left';
    ctx.fillText('Simulated data — no real signals were harmed.', x + 16, y + h - 18);
  }

  function drawGraph(x, y, w, h) {
    panel(x, y, w, h, 'Power vs. Frequency vs. Time');
    const DX = 6.6, DY = 5.6;                      // per-row depth offset
    const left = x + 70, base = y + h - 70;        // front-left floor corner
    const cw = (w - 110 - NT * DX) / NF;           // column pitch
    const bw = cw * 0.72;
    const maxH = base - (y + 50) - NT * DY;
    const fw = NF * cw;
    const ddx = DX * 0.7, ddy = DY * 0.7;          // bar depth

    // floor
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(20, 40, 110, 0.35)';
    ctx.beginPath();
    ctx.moveTo(left, base); ctx.lineTo(left + fw, base);
    ctx.lineTo(left + fw + NT * DX, base - NT * DY); ctx.lineTo(left + NT * DX, base - NT * DY);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(80, 110, 190, 0.45)';
    ctx.beginPath();
    for (let i = 0; i <= NF; i += 6) { ctx.moveTo(left + i * cw, base); ctx.lineTo(left + i * cw + NT * DX, base - NT * DY); }
    for (let t = 0; t <= NT; t += 5) { ctx.moveTo(left + t * DX, base - t * DY); ctx.lineTo(left + fw + t * DX, base - t * DY); }
    ctx.stroke();
    // back wall (power axis)
    ctx.beginPath();
    const bwx = left + NT * DX, bwy = base - NT * DY;
    for (let k = 0; k <= 4; k++) { ctx.moveTo(bwx, bwy - maxH * k / 4); ctx.lineTo(bwx + fw, bwy - maxH * k / 4); }
    ctx.moveTo(bwx, bwy); ctx.lineTo(bwx, bwy - maxH);
    ctx.strokeStyle = 'rgba(80, 110, 190, 0.22)'; ctx.stroke();

    // bars, back to front, left to right
    const frac = rowAcc % 1;
    for (let t = rows.length - 1; t >= 0; t--) {
      const tt = t + frac;
      if (tt > NT - 0.5) continue;
      const row = rows[t];
      const ox = left + tt * DX, oy = base - tt * DY;
      for (let i = 0; i < NF; i++) {
        const v = 1 - Math.exp(-row[i] / 5.5);
        const hgt = Math.max(1.5, v * maxH);
        const sh = SHADES[Math.min(LEVELS - 1, Math.floor(v * LEVELS))];
        const bx = ox + i * cw, by = oy;
        ctx.fillStyle = sh.side;
        ctx.beginPath();
        ctx.moveTo(bx + bw, by); ctx.lineTo(bx + bw + ddx, by - ddy);
        ctx.lineTo(bx + bw + ddx, by - hgt - ddy); ctx.lineTo(bx + bw, by - hgt); ctx.fill();
        ctx.fillStyle = sh.top;
        ctx.beginPath();
        ctx.moveTo(bx, by - hgt); ctx.lineTo(bx + bw, by - hgt);
        ctx.lineTo(bx + bw + ddx, by - hgt - ddy); ctx.lineTo(bx + ddx, by - hgt - ddy); ctx.fill();
        ctx.fillStyle = sh.front;
        ctx.fillRect(bx, by - hgt, bw, hgt);
      }
    }

    // axes labels
    font(15); ctx.fillStyle = C.label; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center'; ctx.fillText('Frequency →', left + fw / 2, base + 30);
    ctx.save(); ctx.translate(left + fw + NT * DX / 2 + 26, base - NT * DY / 2 + 10);
    ctx.rotate(-Math.atan2(DY, DX)); ctx.fillText('← Time', 0, 0); ctx.restore();
    ctx.save(); ctx.translate(left - 26, base - maxH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Power →', 0, 0); ctx.restore();
    font(13); ctx.fillStyle = C.dim; ctx.textAlign = 'left';
    ctx.fillText(`${(wu.base / 1e9).toFixed(6)} GHz`, left, base + 52);
    ctx.textAlign = 'right'; ctx.fillText(`+${(NF * 9765.625 / 1000 / 4).toFixed(1)} kHz`, left + fw, base + 52);

    // colour legend
    const lx = x + w - 40, ly = y + 50, lh = 140;
    for (let k = 0; k < lh; k++) { const [r, g, b] = heat(1 - k / lh); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(lx, ly + k, 14, 1); }
    ctx.strokeStyle = C.border; ctx.strokeRect(lx - 0.5, ly - 0.5, 15, lh + 1);
  }

  function plotFrame(x, y, w, h) {
    ctx.fillStyle = '#000418'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(80,110,190,0.25)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let k = 1; k < 4; k++) { ctx.moveTo(x, y + h * k / 4); ctx.lineTo(x + w, y + h * k / 4); }
    ctx.stroke();
    ctx.strokeStyle = C.border; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function drawGaussian(x, y, w, h) {
    panel(x, y, w, h, 'Best Gaussian');
    const g = wu.bestGauss;
    const px = x + 16, py = y + 44, pw = w - 32, ph = h - 130;
    plotFrame(px, py, pw, ph);
    if (!g) { font(15); ctx.fillStyle = C.dim; ctx.textAlign = 'center'; ctx.fillText('No gaussians found yet', px + pw / 2, py + ph / 2); }
    else {
      const n = g.samples.length;
      const maxV = Math.max(g.amp + 1.5, ...g.samples) * 1.08;
      const sw = pw / n;
      for (let i = 0; i < n; i++) {
        const v = g.samples[i] / maxV, bh = v * (ph - 4);
        const sh = SHADES[Math.min(LEVELS - 1, Math.floor(clamp(v, 0, 0.999) * LEVELS))];
        ctx.fillStyle = sh.front; ctx.fillRect(px + i * sw + 1, py + ph - bh - 2, Math.max(1, sw - 2), bh);
      }
      ctx.strokeStyle = '#ff3a2a'; ctx.lineWidth = 2.5; ctx.beginPath();
      for (let k = 0; k <= 120; k++) {
        const i = k / 120 * n, c = g.len / 2;
        const v = (1.2 + g.amp * Math.exp(-0.5 * ((i - c) / g.sigma) ** 2)) / maxV;
        const xx = px + i * sw, yy = py + ph - 2 - v * (ph - 4);
        k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      }
      ctx.stroke();
      kv(px, y + h - 54, 'Power:', g.power.toFixed(3), 70);
      kv(px + pw / 2, y + h - 54, 'Fit:', g.fit.toFixed(3), 50);
      kv(px, y + h - 26, 'Score:', g.score.toFixed(3), 70);
      kv(px + pw / 2, y + h - 26, 'Chirp:', g.chirp.toFixed(3), 60);
    }
  }

  function drawSpike(x, y, w, h) {
    panel(x, y, w, h, 'Best Spike');
    const s = wu.bestSpike;
    const px = x + 16, py = y + 44, pw = w - 32, ph = h - 130;
    plotFrame(px, py, pw, ph);
    if (!s) return;
    const maxV = s.power * 1.08, sw = pw / NF;
    for (let i = 0; i < NF; i++) {
      const v = s.spectrum[i] / maxV, bh = v * (ph - 4);
      ctx.fillStyle = i === s.bin ? '#ff3a2a' : '#0090ee';
      ctx.fillRect(px + i * sw + 1, py + ph - bh - 2, Math.max(1, sw - 2), bh);
    }
    kv(px, y + h - 54, 'Power:', s.power.toFixed(3), 70);
    kv(px + pw / 2, y + h - 54, 'FFT len:', String(s.fft), 80);
    kv(px, y + h - 26, 'Freq:', fmtHz(s.freq), 70);
    kv(px + pw / 2, y + h - 26, 'Chirp:', s.chirp.toFixed(3), 80);
  }

  function drawOverlay() {
    if (phase === 'analyze') return;
    const msg = phase === 'sending' ? 'Sending results to the server' : 'Receiving a new work unit';
    const t = phaseT / 4;
    const w = 640, h = 130, x = (VW - w) / 2, y = 470;
    ctx.fillStyle = 'rgba(0, 6, 30, 0.95)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    font(24, true); ctx.fillStyle = C.accent; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(msg + '...', VW / 2, y + 52);
    ctx.fillStyle = '#000418'; ctx.fillRect(x + 40, y + 76, w - 80, 20);
    ctx.fillStyle = '#00dc5a'; ctx.fillRect(x + 40, y + 76, (w - 80) * clamp(t, 0, 1), 20);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.strokeRect(x + 40.5, y + 76.5, w - 81, 19);
  }

  let showPanels = params.get('panels') !== '0';

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    const s = Math.min(cw / VW, ch / VH);
    ctx.setTransform(s, 0, 0, s, (cw - VW * s) / 2, (ch - VH * s) / 2);

    drawHeader(new Date());
    if (showPanels) {
      drawAnalysis(20, 76, 600, 262);
      drawDataInfo(636, 76, 468, 262);
      drawUserInfo(1120, 76, 460, 262);
      drawGraph(20, 354, 1064, 626);
      drawGaussian(1100, 354, 480, 305);
      drawSpike(1100, 675, 480, 305);
    } else {
      drawGraph(20, 76, 1560, 904);
    }
    drawOverlay();
  }

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    tick(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // keep simulating (slowly) if the tab is hidden; rAF pauses then
  setInterval(() => { if (document.hidden) { const now = performance.now(); tick(Math.min(5, (now - last) / 1000)); last = now; } }, 1000);

  // ---------- keep the display awake ----------
  const wakeBtn = document.getElementById('wakeBtn');
  let wakeLock = null, wakeWanted = store.get('awake', true), fallbackVideo = null;

  function setWakeLabel(state) { wakeBtn.textContent = 'Display awake: ' + state; }

  async function acquireWake() {
    if (!wakeWanted) { setWakeLabel('off'); return; }
    if (wakeLock) return;
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        setWakeLabel('ON');
        wakeLock.addEventListener('release', () => { wakeLock = null; setWakeLabel(wakeWanted ? 'paused' : 'off'); });
        return;
      } catch (e) { /* fall through to video fallback */ }
    }
    startVideoFallback();
  }

  // Fallback for browsers without the Wake Lock API: a tiny, muted, looping
  // video stream generated from a canvas. Needs a user gesture on some browsers.
  function startVideoFallback() {
    try {
      if (!fallbackVideo) {
        const c = document.createElement('canvas'); c.width = c.height = 2;
        const cx = c.getContext('2d');
        setInterval(() => { cx.fillStyle = `rgb(0,0,${Math.floor(Math.random() * 3)})`; cx.fillRect(0, 0, 2, 2); }, 1000);
        fallbackVideo = document.createElement('video');
        fallbackVideo.muted = true; fallbackVideo.playsInline = true; fallbackVideo.loop = true;
        fallbackVideo.setAttribute('playsinline', '');
        Object.assign(fallbackVideo.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0.01', left: '0', top: '0', pointerEvents: 'none' });
        fallbackVideo.srcObject = c.captureStream(1);
        document.body.appendChild(fallbackVideo);
      }
      fallbackVideo.play().then(() => setWakeLabel('ON (video)'), () => setWakeLabel('click to enable'));
    } catch (e) { setWakeLabel('unsupported'); }
  }

  function releaseWake() {
    if (wakeLock) { const l = wakeLock; wakeLock = null; l.release().catch(() => {}); }
    if (fallbackVideo) fallbackVideo.pause();
    setWakeLabel('off');
  }

  wakeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    wakeWanted = !wakeWanted; store.set('awake', wakeWanted);
    wakeWanted ? acquireWake() : releaseWake();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquireWake(); });
  document.addEventListener('pointerdown', () => acquireWake());
  document.addEventListener('keydown', () => acquireWake());
  setInterval(() => { if (wakeWanted && !wakeLock && document.visibilityState === 'visible') acquireWake(); }, 15000);
  acquireWake();

  // ---------- controls ----------
  function toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else { const el = d.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); }
  }
  function askName() {
    const n = prompt('User name for the User Info panel:', user.name);
    if (n && n.trim()) { user.name = n.trim().slice(0, 40); store.set('name', user.name); }
  }
  document.getElementById('fsBtn').addEventListener('click', toggleFullscreen);
  document.getElementById('nameBtn').addEventListener('click', askName);
  canvas.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') toggleFullscreen();
    else if (k === 'h') showPanels = !showPanels;
    else if (k === 'n') askName();
  });

  // hide cursor and buttons when idle
  let idleTimer = 0;
  function poke() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  ['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));
  poke();
})();
