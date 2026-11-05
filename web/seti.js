/*
 * Retro SETI — a tribute to the classic (v3.x, 1999–2005) SETI@home screensaver.
 * Layout and palette are matched to screenshots of the original v3.07 client.
 * All data is simulated; nothing is downloaded or uploaded.
 *
 * URL parameters:
 *   ?name=Your+Name   user name shown in User Info (remembered)
 *   ?wu=15            minutes per simulated data unit (0.5 – 600)
 */
(() => {
  'use strict';

  // ---------- config ----------
  const VW = 1500, VH = 885;            // virtual canvas (same aspect as the original 753x444)
  const NF = 128, NT = 48;              // frequency columns x time rows in the 3D graph
  const params = new URLSearchParams(location.search);
  const WU_SECONDS = clamp(parseFloat(params.get('wu')) || 15, 0.5, 600) * 60;
  const SLOT_SECONDS = 12;              // one (drift rate, FFT length) pass
  const FFTS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  const BANDWIDTH = 9765.625;           // Hz per data unit
  const WU_TIME = 107.374;              // seconds of telescope data per data unit

  const PURPLE = '#9a66f6', GREEN = '#35dea7', WHITE = '#ffffff', LINE_RED = '#c83232', GREY = '#a0a0a0';
  const FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif';
  const TITLE_FONT = '"Arial Black", "Arial", "Liberation Sans", Helvetica, sans-serif';

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pad(n, w = 2) { return String(Math.floor(n)).padStart(w, '0'); }
  function expo() { return -Math.log(1 - Math.random()); }

  // ---------- persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('retroseti.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('retroseti.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const user = {
    name: params.get('name') || store.get('name', 'anonymous'),
    wus: store.get('wus', 0),
    cpu: store.get('cpu', 0),
  };
  if (params.get('name')) store.set('name', user.name);

  // ---------- graph palette: hue by frequency, paler with power ----------
  const HUES = [[0, [255, 30, 40]], [0.2, [245, 40, 170]], [0.33, [210, 40, 250]], [0.52, [130, 60, 250]],
                [0.65, [40, 60, 245]], [0.83, [60, 160, 245]], [1, [70, 235, 240]]];
  function hue(t) {
    for (let i = 1; i < HUES.length; i++) {
      if (t <= HUES[i][0]) {
        const [t0, c0] = HUES[i - 1], [t1, c1] = HUES[i];
        const f = (t - t0) / (t1 - t0);
        return c0.map((v, j) => v + (c1[j] - v) * f);
      }
    }
    return HUES[HUES.length - 1][1];
  }
  const LEVELS = 12;
  // COLS[i][level] = {front, top, side}
  const COLS = [];
  for (let i = 0; i < NF; i++) {
    const base = hue(i / (NF - 1));
    const lv = [];
    for (let l = 0; l < LEVELS; l++) {
      const w = (l / (LEVELS - 1)) ** 3 * 0.75;           // whiten tall bars
      const c = base.map((v) => v + (255 - v) * w);
      const s = (k) => `rgb(${c.map((v) => Math.round(clamp(v * k, 0, 255))).join(',')})`;
      lv.push({ front: s(0.8), top: s(1.2), side: s(0.38) });
    }
    COLS.push(lv);
  }

  // ---------- data unit simulation ----------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function newWorkUnit() {
    return {
      ra: rand(0, 24), dec: rand(-1.5, 38),
      recorded: new Date(Date.UTC(1999, 0, 1) + rand(0, 7 * 365.25 * 86400000)),
      base: 1418750000 + Math.floor(rand(0, 256)) * BANDWIDTH,
      p: 0, cpu: 0,
      slots: Math.max(6, Math.round(WU_SECONDS / SLOT_SECONDS)),
      bestPeak: 0,
    };
  }

  let wu = newWorkUnit();
  let phase = 'analyze';    // 'analyze' | 'sending' | 'receiving'
  let phaseT = 0;

  // 3D graph data, rows[0] = time 0 (front)
  const rows = [];
  for (let t = 0; t < NT; t++) rows.push(new Float32Array(NF));
  let sweepRow = 0, sweepAcc = 0, graphDirty = true, lastSlot = -1;

  function slotState(p) {
    const q = p * wu.slots, k = Math.min(wu.slots - 1, Math.floor(q)), f = q - k;
    const fft = FFTS[k % FFTS.length];
    const ci = Math.floor(k / FFTS.length);
    const n = Math.ceil(ci / 2), sign = ci % 2 ? 1 : -1;
    const drift = sign * n * 0.0833 * (1 + (ci % 3) * 0.5);
    let act, sub;
    if (p < 0.004) { act = 'Doing baseline smoothing'; sub = p / 0.004; }
    else if (f < 0.45) { act = 'Computing Fourier transforms'; sub = f / 0.45; }
    else if (f < 0.65 && fft >= 128) { act = 'Searching for Gaussians'; sub = (f - 0.45) / 0.2; }
    else { act = 'Searching for Pulses / Triplets'; sub = (f - (fft >= 128 ? 0.65 : 0.45)) / (fft >= 128 ? 0.35 : 0.55); }
    return { k, fft, drift, act, sub: clamp(sub, 0, 1), res: BANDWIDTH / fft };
  }

  // A spectrum row: fewer independent bins at short FFT lengths (blocky), plus the odd spike.
  function makeRow(fft) {
    const row = new Float32Array(NF);
    // short FFTs give coarse, smoother spectra; long FFTs give noisier ones
    const k = fft < 256 ? 4 : 3;
    for (let i = 0; i < NF; i++) { let v = 0; for (let j = 0; j < k; j++) v += expo(); row[i] = v / k; }
    if (Math.random() < 0.5) { const b = Math.floor(rand(0, NF)); row[b] += rand(2.5, 4.5); }
    return row;
  }

  // Data Analysis panel detail line + mini graph (regenerated as the search advances)
  const detail = { key: '', text: '', series: [], curve: null, next: 0 };
  function updateDetail(st, now) {
    const key = st.act + st.k;
    if (key === detail.key && now < detail.next) return;
    const fresh = key !== detail.key;
    detail.key = key;
    detail.next = now + (st.act.startsWith('Searching for Pulses') ? 450 : 900);
    detail.curve = null;
    if (st.act === 'Computing Fourier transforms' || st.act === 'Doing baseline smoothing') {
      const row = rows[Math.max(0, sweepRow - 1)];
      detail.series = Array.from(row);
      let mi = 0;
      for (let i = 1; i < NF; i++) if (row[i] > row[mi]) mi = i;
      const power = row[mi] * rand(9, 14);
      wu.bestPeak = Math.max(wu.bestPeak, power);
      detail.text = `Strongest peak: power ${power.toFixed(2)}  (${(mi / NF * BANDWIDTH).toFixed(1)} Hz at ${(sweepRow / NT * WU_TIME).toFixed(2)} sec)`;
    } else if (st.act === 'Searching for Gaussians') {
      const n = 64, c = rand(22, 42), sig = rand(5, 9), amp = rand(0.5, 3.5);
      detail.series = Array.from({ length: n }, (_, i) => 1 + amp * Math.exp(-0.5 * ((i - c) / sig) ** 2) + (expo() - 1) * 0.7);
      detail.curve = Array.from({ length: n }, (_, i) => 1 + amp * Math.exp(-0.5 * ((i - c) / sig) ** 2));
      const fit = rand(0.6, 9);
      detail.text = `Gaussian: power ${amp.toFixed(2)}, fit ${fit.toFixed(3)}, score ${(amp / Math.sqrt(fit)).toFixed(2)}`;
    } else {
      const n = 96;
      if (fresh || !detail.series.length) detail.series = Array.from({ length: n }, () => 1 + (expo() - 1) * 0.35);
      else detail.series = detail.series.map((v) => clamp(v * 0.6 + (1 + (expo() - 1) * 0.35) * 0.4 + (Math.random() < 0.04 ? rand(0.6, 1.4) : 0), 0, 4));
      const power = rand(0.4, 1.6), period = rand(0.02, 1.2);
      detail.text = Math.random() < 0.25
        ? `Triplet: power ${(power * 6).toFixed(2)}, period ${period.toFixed(4)}`
        : `Pulse: power ${power.toFixed(2)}, period ${period.toFixed(4)}, score ${(power * rand(0.3, 0.6)).toFixed(2)}`;
    }
  }

  // ---------- simulation tick ----------
  let saveAcc = 0;
  function tick(dt) {
    phaseT += dt;
    if (phase === 'analyze') {
      wu.p += dt / WU_SECONDS;
      wu.cpu += dt;
      user.cpu += dt;
      const st = slotState(Math.min(wu.p, 0.99999));
      if (st.k !== lastSlot) { lastSlot = st.k; sweepRow = 0; }
      if (st.act === 'Computing Fourier transforms' && sweepRow < NT) {
        sweepAcc += dt * NT / (SLOT_SECONDS * 0.45 * 0.9);
        while (sweepAcc >= 1 && sweepRow < NT) { sweepAcc -= 1; rows[sweepRow++] = makeRow(st.fft); graphDirty = true; }
      }
      if (wu.p >= 1) {
        wu.p = 1; phase = 'sending'; phaseT = 0;
        user.wus++; store.set('wus', user.wus); store.set('cpu', user.cpu);
      }
    } else if (phase === 'sending' && phaseT > 5) {
      phase = 'receiving'; phaseT = 0;
    } else if (phase === 'receiving' && phaseT > 5) {
      wu = newWorkUnit(); phase = 'analyze'; phaseT = 0; lastSlot = -1;
    }
    saveAcc += dt;
    if (saveAcc > 5) { saveAcc = 0; store.set('cpu', user.cpu); }
  }

  // ---------- drawing helpers ----------
  function font(px, bold, fam = FONT) { ctx.font = `${bold ? 'bold ' : ''}${px}px ${fam}`; }
  function text(s, x, y, px, color = WHITE, align = 'left', bold = false) {
    font(px, bold); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---------- header ----------
  function drawLogo() {
    // globe
    const g = ctx.createRadialGradient(44, 30, 4, 52, 38, 34);
    g.addColorStop(0, '#9ff3ff'); g.addColorStop(0.45, '#2fa6b8'); g.addColorStop(1, '#14306a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(54, 38, 31, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(60, 200, 150, 0.75)';
    ctx.beginPath(); ctx.ellipse(46, 30, 12, 17, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(66, 50, 8, 10, 0.4, 0, Math.PI * 2); ctx.fill();
    // purple signal wave trailing off to the right
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let x = 70; x <= 250; x += 2) {
        const f = (x - 70) / 180;
        const y = 38 - Math.sin(f * Math.PI * 4.2) * (16 - f * 6);
        x === 70 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      const lg = ctx.createLinearGradient(70, 0, 250, 0);
      lg.addColorStop(0, pass ? '#c9a8ff' : '#6a3fd0'); lg.addColorStop(1, 'rgba(110, 70, 220, 0)');
      ctx.strokeStyle = lg; ctx.lineWidth = pass ? 3 : 10; ctx.lineCap = 'round'; ctx.stroke();
    }
  }

  function drawDish(x, y) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.35);
    ctx.fillStyle = GREEN;
    ctx.beginPath(); ctx.ellipse(0, 0, 24, 11, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#1d8f68';
    ctx.beginPath(); ctx.ellipse(0, 0, 24, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = GREEN; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, -16); ctx.stroke();
    ctx.restore();
  }

  function drawHeader() {
    drawLogo();
    ctx.letterSpacing = '1.5px';
    font(27, true, TITLE_FONT); ctx.fillStyle = WHITE; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('The Search for', 198, 32);
    ctx.fillText('Extraterrestrial Intelligence', 285, 63);
    const w = ctx.measureText('Extraterrestrial Intelligence ').width;
    ctx.fillStyle = GREEN; ctx.fillText('at HOME', 285 + w + 6, 63);
    const w2 = ctx.measureText('at HOME').width;
    ctx.letterSpacing = '0px';
    drawDish(285 + w + w2 + 40, 40);
    text('Press F1 for info', 995, 31, 21);
    text('Version 3.08', 1435, 31, 21, WHITE, 'right');
    text(location.host ? (location.host + location.pathname).replace(/\/(index\.html)?$/, '') : 'retro-seti', 1210, 58, 17, WHITE, 'center');
  }

  // ---------- purple frame (the classic "console" look) ----------
  function drawFrame() {
    ctx.fillStyle = PURPLE;
    roundRect(14, 87, 1471, 13, 6.5); ctx.fill();          // top bar
    roundRect(14, 437, 1471, 13, 6.5); ctx.fill();         // bottom bar
    ctx.fillRect(790, 92, 120, 352);                       // vertical spine
    roundRect(860, 268, 625, 16, 8); ctx.fill();           // right divider
    ctx.fillStyle = '#000';
    roundRect(-60, 100, 882, 337, 30); ctx.fill();        // Data Analysis
    roundRect(882, 100, 700, 168, 30); ctx.fill();        // Data Info
    roundRect(882, 284, 700, 153, 30); ctx.fill();        // User Info
  }

  // ---------- Data Analysis ----------
  function drawAnalysis() {
    const st = slotState(Math.min(wu.p, 0.99999));
    text('Data Analysis', 361, 140, 22, WHITE, 'center');
    let act = st.act, sub = st.sub;
    if (phase === 'sending') { act = 'Sending result to server'; sub = clamp(phaseT / 5, 0, 1); }
    if (phase === 'receiving') { act = 'Getting new data unit'; sub = clamp(phaseT / 5, 0, 1); }
    text(act, 24, 167, 21);
    text(`${Math.floor(sub * 100)}%`, 565, 167, 21, WHITE, 'right');
    ctx.fillStyle = WHITE; ctx.fillRect(582, 153, Math.max(2, 200 * sub), 11);

    if (phase === 'analyze') {
      text(`Doppler drift rate: ${st.drift.toFixed(4)} Hz/sec`, 24, 195, 21);
      text(`Resolution: ${st.res < 1 ? st.res.toFixed(3) : st.res.toFixed(3)} Hz`, 362, 195, 21);
      text(detail.text, 24, 223, 21);
      drawMiniGraph(24, 238, 773, 96);
    }

    // 3D tube progress bar
    const x = 24, y = 354, w = 746, h = 36, dx = 12, dy = -12;
    const fw = w * wu.p;
    if (fw > 0.5) {
      ctx.fillStyle = '#b0141e'; ctx.fillRect(x, y, fw, h);
      ctx.fillStyle = '#e04048';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.lineTo(x + fw + dx, y + dy); ctx.lineTo(x + fw, y); ctx.fill();
      ctx.fillStyle = '#6e0a10';
      ctx.beginPath(); ctx.moveTo(x + fw, y); ctx.lineTo(x + fw + dx, y + dy); ctx.lineTo(x + fw + dx, y + dy + h); ctx.lineTo(x + fw, y + h); ctx.fill();
    }
    ctx.strokeStyle = GREY; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.lineTo(x + w + dx, y + dy); ctx.lineTo(x + w + dx, y + h + dy); ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y); ctx.lineTo(x + w + dx, y + dy);
    ctx.stroke();

    text(`Overall:  ${(wu.p * 100).toFixed(3)}% done`, 24, 418, 21);
    const c = wu.cpu, hh = Math.floor(c / 3600), mm = Math.floor(c / 60) % 60, ss = (c % 60).toFixed(1).padStart(4, '0');
    text(`CPU time: ${hh} hr ${pad(mm)} min ${ss} sec`, 747, 418, 21, WHITE, 'right');
  }

  function drawMiniGraph(x, y, w, h) {
    const s = detail.series;
    if (!s.length) return;
    let max = 0;
    for (const v of s) max = Math.max(max, v);
    if (detail.curve) for (const v of detail.curve) max = Math.max(max, v);
    max = Math.max(max, 1.5);
    const sw = w / s.length;
    ctx.strokeStyle = LINE_RED; ctx.lineWidth = 2; ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (let i = 0; i < s.length; i++) {
      const yy = y + h - (s[i] / max) * h;
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x + i * sw, yy);
      ctx.lineTo(x + (i + 1) * sw, yy);
    }
    ctx.stroke();
    if (detail.curve) {
      ctx.strokeStyle = WHITE; ctx.lineWidth = 2; ctx.beginPath();
      detail.curve.forEach((v, i) => { const xx = x + (i + 0.5) * sw, yy = y + h - (v / max) * h; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
      ctx.stroke();
    }
  }

  // ---------- Data Info / User Info ----------
  function drawDataInfo() {
    text('Data Info', 1165, 140, 22, WHITE, 'center');
    const raH = Math.floor(wu.ra), raM = Math.floor((wu.ra - raH) * 60), raS = Math.floor(((wu.ra - raH) * 60 - raM) * 60);
    const ad = Math.abs(wu.dec), dD = Math.floor(ad), dM = Math.floor((ad - dD) * 60), dS = Math.floor(((ad - dD) * 60 - dM) * 60);
    text(`From: ${raH} hr ${String(raM).padStart(2)}' ${String(raS).padStart(2)}" RA, ${wu.dec < 0 ? '-' : '+'} ${dD} deg ${dM}' ${dS}" Dec`, 906, 167, 21);
    const d = wu.recorded;
    text(`Recorded on: ${DAYS[d.getUTCDay()]} ${MONS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`, 906, 195, 21);
    text('Source: Arecibo Radio Observatory', 906, 223, 21);
    text(`Base Frequency: ${(wu.base / 1e9).toFixed(9)} GHz`, 906, 251, 21);
  }

  function drawUserInfo() {
    text('User Info', 1163, 323, 22, WHITE, 'center');
    text(`Name: ${user.name.slice(0, 34)}`, 906, 351, 21);
    text(`Data units completed: ${user.wus}`, 906, 379, 21);
    const c = user.cpu, hh = Math.floor(c / 3600), mm = Math.floor(c / 60) % 60, ss = (c % 60).toFixed(1).padStart(4, '0');
    text(`Total computer time: ${hh} hr ${pad(mm)} min ${ss} sec`, 906, 407, 21);
  }

  // ---------- the 3D power / frequency / time graph ----------
  // Floor: front edge (232..1400, 848), depth runs up-left to (118..1286, 570).
  const G = { fx: 232, fy: 848, fw: 1168, ddx: -114 / NT, ddy: -278 / NT, maxH: 92 };
  const graphCanvas = document.createElement('canvas');
  const gctx = graphCanvas.getContext('2d');
  let graphScale = 0;

  function renderGraphLayer(scale) {
    const w = Math.ceil(VW * scale), h = Math.ceil((VH - 455) * scale);
    if (graphCanvas.width !== w || graphCanvas.height !== h) { graphCanvas.width = w; graphCanvas.height = h; }
    const g = gctx;
    g.setTransform(scale, 0, 0, scale, 0, -455 * scale);
    g.clearRect(0, 455, VW, VH);
    const cw = G.fw / NF, { ddx, ddy, maxH } = G;
    g.lineWidth = 1; g.strokeStyle = '#000'; g.lineJoin = 'miter';

    // back to front; within a row right to left (left side faces are the visible ones)
    for (let t = NT - 1; t >= 0; t--) {
      const row = rows[t];
      const ox = G.fx + t * ddx, oy = G.fy + t * ddy;
      for (let i = NF - 1; i >= 0; i--) {
        const v = row[i];
        const hgt = Math.min(maxH * 1.25, 4 + v * 30);
        const lv = Math.min(LEVELS - 1, Math.floor(Math.max(0, hgt - 30) / (maxH * 1.25 - 30) * LEVELS));
        const c = COLS[i][lv];
        const x = ox + i * cw, y = oy;
        // left side
        g.fillStyle = c.side;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - hgt); g.lineTo(x + ddx, y - hgt + ddy); g.lineTo(x + ddx, y + ddy); g.closePath(); g.fill();
        // top
        g.fillStyle = c.top;
        g.beginPath(); g.moveTo(x, y - hgt); g.lineTo(x + cw, y - hgt); g.lineTo(x + cw + ddx, y - hgt + ddy); g.lineTo(x + ddx, y - hgt + ddy); g.closePath(); g.fill(); g.stroke();
        // front
        g.fillStyle = c.front;
        g.fillRect(x, y - hgt, cw, hgt);
        g.strokeRect(x, y - hgt, cw, hgt);
      }
    }

    // box outline (thin grey), drawn over the bars like the original
    const bx = G.fx + NT * ddx, by = G.fy + NT * ddy;
    g.strokeStyle = '#8c8c8c'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(bx, by); g.lineTo(G.fx, G.fy);                                  // left floor edge
    g.moveTo(bx, by); g.lineTo(bx, by - maxH);                               // back-left post
    g.lineTo(bx + G.fw, by - maxH);                                          // back top
    g.lineTo(G.fx + G.fw, G.fy - maxH);                                      // right top edge
    g.lineTo(G.fx + G.fw, G.fy);                                             // front-right post
    g.moveTo(G.fx, G.fy); g.lineTo(G.fx + G.fw, G.fy);                       // front edge
    g.stroke();
  }

  function drawGraph(scale) {
    if (graphDirty || scale !== graphScale) { renderGraphLayer(scale); graphDirty = false; graphScale = scale; }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const m = view;
    ctx.drawImage(graphCanvas, m.ox, m.oy + 455 * m.s, graphCanvas.width * (m.s / scale), graphCanvas.height * (m.s / scale));
    ctx.restore();

    // axis labels
    const bx = G.fx + NT * G.ddx, by = G.fy + NT * G.ddy;
    text(WU_TIME.toFixed(1), 95, by + 14, 21, WHITE, 'right');
    text('Time (sec)', 52, 716, 21);
    text('0', 202, 842, 21, WHITE, 'right');
    text('0.0', 245, 875, 21);
    text('Frequency (Hz)', 842, 875, 21, WHITE, 'center');
    text((BANDWIDTH - 0.005).toFixed(3), 1407, 875, 21, WHITE, 'right');
    text('Power', 1449, 826, 21, WHITE, 'center');
    ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(1449, 800); ctx.lineTo(1449, 728); ctx.moveTo(1440, 740); ctx.lineTo(1449, 728); ctx.lineTo(1458, 740); ctx.stroke();
    void bx;
  }

  // ---------- F1 info box ----------
  let showInfo = false;
  function drawInfo() {
    if (!showInfo) return;
    const x = 300, y = 180, w = 900, h = 470;
    ctx.fillStyle = 'rgba(0,0,0,0.92)'; roundRect(x, y, w, h, 24); ctx.fill();
    ctx.strokeStyle = PURPLE; ctx.lineWidth = 6; roundRect(x, y, w, h, 24); ctx.stroke();
    const lines = [
      ['Retro SETI', 26, true],
      ['A tribute to the classic SETI@home screensaver (1999–2005).', 19],
      ['The data shown is simulated — nothing is downloaded or analysed.', 19],
      ['Not affiliated with UC Berkeley or the SETI@home project.', 19],
      ['', 10],
      ['F1  this box          F  fullscreen          N  set your name', 19],
      ['Your display is kept awake while this page is visible.', 19],
      ['', 10],
      ['The real SETI@home ran from May 1999; the classic client', 19],
      ['retired on December 15, 2005 in favour of BOINC.', 19],
    ];
    let yy = y + 60;
    for (const [s, px, b] of lines) { text(s, VW / 2, yy, px, b ? GREEN : WHITE, 'center', !!b); yy += px + 16; }
    text('press any key to close', VW / 2, y + h - 26, 15, GREY, 'center');
  }

  // ---------- frame ----------
  const view = { s: 1, ox: 0, oy: 0 };
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    const s = Math.min(cw / VW, ch / VH);
    view.s = s; view.ox = (cw - VW * s) / 2; view.oy = (ch - VH * s) / 2;
    ctx.setTransform(s, 0, 0, s, view.ox, view.oy);

    drawHeader();
    drawFrame();
    updateDetail(slotState(Math.min(wu.p, 0.99999)), performance.now());
    drawAnalysis();
    drawDataInfo();
    drawUserInfo();
    drawGraph(s);
    drawInfo();
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
      } catch (e) { /* fall through */ }
    }
    startVideoFallback();
  }
  // Fallback for browsers without the Wake Lock API: a tiny muted looping video stream.
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
  canvas.addEventListener('click', () => { showInfo = false; });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'F1') { e.preventDefault(); showInfo = !showInfo; return; }
    if (showInfo) { showInfo = false; return; }
    const k = e.key.toLowerCase();
    if (k === 'f') toggleFullscreen();
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

  // pre-fill the graph so the first frame isn't empty
  for (let t = 0; t < NT; t++) rows[t] = makeRow(1024);
})();
