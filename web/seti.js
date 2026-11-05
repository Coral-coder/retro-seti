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
  // ---- user-adjustable speeds (Settings window, saved in this browser) ----
  const DEFAULTS = {
    wuMinutes: 15,      // length of one simulated data unit
    stepSeconds: 20,    // one (drift rate, FFT length) analysis pass
    growSeconds: 6,     // 3D graph: time to grow in row by row
    holdSeconds: 4,     // 3D graph: time to hold before the next array
    signalSeconds: 8,   // how long each best signal is shown before rotating
    rockSeconds: 40,    // one full left-right-left rock of the 3D graph
    rockDegrees: 6,     // how far it rocks each way (0 = still)
  };
  const LIMITS = {
    wuMinutes: [1, 600, 1], stepSeconds: [5, 60, 1], growSeconds: [1, 20, 0.5], holdSeconds: [0, 20, 0.5],
    signalSeconds: [2, 30, 1], rockSeconds: [10, 120, 1], rockDegrees: [0, 45, 1],
  };
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

  const cfg = Object.assign({}, DEFAULTS, store.get('settings', {}));
  for (const k of Object.keys(LIMITS)) cfg[k] = clamp(+cfg[k] || DEFAULTS[k], LIMITS[k][0], LIMITS[k][1]);
  if (params.get('wu')) cfg.wuMinutes = clamp(parseFloat(params.get('wu')) || 15, 0.5, 600);

  // ---------- graph colour (from Berkeley's GPL graphics code, reduce_lib.cpp) ----------
  // hue sweeps across frequency, saturation 1, lightness = 0.5 + h/2 where h is the bar's
  // height normalised to the array's min..max — so the tallest bars wash out to white.
  // Classic sweep: red (hue 1.0) -> magenta -> blue -> cyan (hue 0.5).
  const HUE0 = 1.0, DHUE = -0.5;
  function hueToRgb(m1, m2, h) {
    if (h < 0) h += 1; if (h > 1) h -= 1;
    if (6 * h < 1) return m1 + (m2 - m1) * h * 6;
    if (2 * h < 1) return m2;
    if (3 * h < 2) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
    return m1;
  }
  function hlsToRgb(h, l, s) {
    const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
    return [hueToRgb(m1, m2, h + 1 / 3), hueToRgb(m1, m2, h), hueToRgb(m1, m2, h - 1 / 3)].map((v) => v * 255);
  }
  const LEVELS = 16;
  // COLS[i][level] = {front, top, side}
  const COLS = [];
  for (let i = 0; i < NF; i++) {
    let hu = HUE0 + DHUE * i / NF;
    if (hu < 0) hu += 1; if (hu > 1) hu -= 1;
    const lv = [];
    for (let l = 0; l < LEVELS; l++) {
      const c = hlsToRgb(hu, 0.5 + (l / (LEVELS - 1)) / 2, 1);
      const s = (k) => `rgb(${c.map((v) => Math.round(clamp(v * k, 0, 255))).join(',')})`;
      lv.push({ front: s(0.82), top: s(1.15), side: s(0.4) });
    }
    COLS.push(lv);
  }

  // ---------- data unit simulation ----------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const GAUSS_POT_LEN = 64, PULSE_POT_LEN = 256, TRIPLET_POT_LEN = 256;
  // graph grow/hold animation as in the GPL code (its defaults were 3 s / 2 s; ours are in cfg)

  function newWorkUnit() {
    return {
      ra: rand(0, 24), dec: rand(-1.5, 38),
      recorded: new Date(Date.UTC(1999, 0, 1) + rand(0, 7 * 365.25 * 86400000)),
      base: 1418750000 + Math.floor(rand(0, 256)) * BANDWIDTH,
      p: 0, cpu: 0,
      slots: Math.max(6, Math.round(cfg.wuMinutes * 60 / cfg.stepSeconds)),
      best: { gauss: null, pulse: null, triplet: null },
    };
  }

  let wu = newWorkUnit();
  let phase = 'analyze';    // 'analyze' | 'sending' | 'receiving'
  let phaseT = 0;
  let clock = 0;

  // Per (drift rate, FFT length) pair the real client went: Chirping data (when the drift
  // rate changes) -> Computing Fast Fourier Transform -> Searching for Gaussians ->
  // Searching for Pulses / Triplets. Status strings are the client's own.
  function slotState(p) {
    const q = p * wu.slots, k = Math.min(wu.slots - 1, Math.floor(q)), f = q - k;
    const fft = FFTS[k % FFTS.length];
    const ci = Math.floor(k / FFTS.length);
    const n = Math.ceil(ci / 2), sign = ci % 2 ? 1 : -1;
    const drift = sign * n * 0.0833 * (1 + (ci % 3) * 0.5);
    const chirping = k % FFTS.length === 0 && k > 0;
    let act, a, b;
    if (p < 0.004) { act = 'Doing Baseline Smoothing'; a = 0; b = 0.004 * wu.slots; }
    else if (chirping && f < 0.08) { act = 'Chirping data'; a = 0; b = 0.08; }
    else if (f < 0.45) { act = 'Computing Fast Fourier Transform'; a = chirping ? 0.08 : 0; b = 0.45; }
    else if (f < 0.65) { act = 'Searching for Gaussians'; a = 0.45; b = 0.65; }
    else { act = 'Searching for Pulses / Triplets'; a = 0.65; b = 1; }
    const sub = p < 0.004 ? p / 0.004 : (f - a) / (b - a);
    return { k, fft, drift, act, sub: clamp(sub, 0, 1), res: BANDWIDTH / fft };
  }

  // One reduced spectrum row (the client shows a max/avg-reduced power array).
  function makeRow(fft) {
    const row = new Float32Array(NF);
    const k = fft < 256 ? 4 : 3;
    for (let i = 0; i < NF; i++) { let v = 0; for (let j = 0; j < k; j++) v += expo(); row[i] = v / k; }
    if (Math.random() < 0.5) { const b = Math.floor(rand(0, NF)); row[b] += rand(2.5, 4.5); }
    return row;
  }

  // ---- 3D graph: a new array every GROW+HOLD seconds, revealed row by row ----
  const graph = { rows: [], min: 0, max: 1, start: -1e9, shown: -1 };
  let graphDirty = true;
  function newGraphArray(fft) {
    graph.rows = Array.from({ length: NT }, () => makeRow(fft));
    let mn = Infinity, mx = -Infinity;
    for (const r of graph.rows) for (const v of r) { if (v < mn) mn = v; if (v > mx) mx = v; }
    graph.min = mn; graph.max = mx; graph.start = clock; graph.shown = -1;
  }
  function graphRowsVisible() {
    const e = clock - graph.start;
    return e >= cfg.growSeconds ? NT : Math.floor(NT * e / cfg.growSeconds);
  }

  // ---- signals: new ones show immediately, otherwise rotate the bests every 5 s ----
  const fmt = (v, w, p) => v.toFixed(p).padStart(w);
  function makeGauss() {
    const sigma = rand(3, 8), ind = rand(20, 44), peak = rand(0.4, 3.5), mean = rand(0.8, 1.2);
    const pot = Array.from({ length: GAUSS_POT_LEN }, (_, i) => {
      const d = (i - ind) / sigma;
      return Math.max(0, mean + peak * Math.exp(-d * d * 0.693) + (expo() - 1) * 0.6);
    });
    const chisqr = rand(0.6, 9);
    return { type: 'gauss', peak, mean, sigma, ind, pot, chisqr, score: peak / Math.sqrt(chisqr) * rand(0.3, 0.9) };
  }
  function makePulse() {
    const period = rand(0.002, 1.2), peak = rand(0.5, 2.2);
    const pot = Array.from({ length: PULSE_POT_LEN }, () => Math.min(255, 70 + expo() * 30));
    const at = Math.floor(rand(0, PULSE_POT_LEN)); pot[at] = 255;
    return { type: 'pulse', peak, period, pot, score: peak * rand(0.3, 0.6) };
  }
  function makeTriplet() {
    const period = rand(0.01, 2), peak = rand(5, 14);
    const pot = Array.from({ length: TRIPLET_POT_LEN }, () => Math.min(255, 60 + expo() * 25));
    const t0 = Math.floor(rand(10, 80)), step = Math.floor(rand(30, 80));
    const ticks = [t0, t0 + step, t0 + 2 * step].filter((t) => t < TRIPLET_POT_LEN);
    for (const t of ticks) pot[t] = 255;
    return { type: 'triplet', peak, period, pot, ticks, score: peak };
  }
  const signal = { shown: null, dirty: null };
  function foundSignal(s) {
    const key = s.type, cur = wu.best[key];
    if (!cur || s.score > cur.score) wu.best[key] = s;
    signal.dirty = s;
  }
  function chooseSignal() {
    if (signal.dirty) { signal.shown = signal.dirty; signal.dirty = null; signal.until = clock + cfg.signalSeconds; return; }
    if (signal.until && clock < signal.until) return;
    const choices = ['gauss', 'pulse', 'triplet'].map((k) => wu.best[k]).filter(Boolean);
    if (!choices.length) { signal.shown = null; return; }
    signal.shown = choices[Math.floor((clock / cfg.signalSeconds) % choices.length)];
  }
  function signalText(s) {
    if (!s) return '';
    if (s.type === 'gauss') return `Gaussian: power ${fmt(s.peak, 5, 2)}, fit ${fmt(s.chisqr, 5, 3)}, score ${fmt(s.score, 5, 3)}`;
    if (s.type === 'pulse') return `Pulse: power ${fmt(s.peak, 5, 2)}, period ${fmt(s.period, 6, 4)}, score ${fmt(s.score, 5, 2)}`;
    return `Triplet: power ${fmt(s.peak, 5, 2)}, period ${fmt(s.period, 6, 4)}`;
  }

  // ---------- simulation tick ----------
  let saveAcc = 0, findAcc = 0;
  function tick(dt) {
    clock += dt;
    phaseT += dt;
    if (phase === 'analyze') {
      wu.p += dt / (cfg.wuMinutes * 60);
      wu.cpu += dt;
      user.cpu += dt;
      const st = slotState(Math.min(wu.p, 0.99999));
      if (clock - graph.start >= cfg.growSeconds + cfg.holdSeconds) newGraphArray(st.fft);
      // candidate signals turn up while their search is running
      findAcc += dt;
      if (findAcc > cfg.stepSeconds / 10) {
        findAcc = 0;
        if (st.act === 'Searching for Gaussians' && Math.random() < 0.35) foundSignal(makeGauss());
        if (st.act === 'Searching for Pulses / Triplets') {
          if (Math.random() < 0.3) foundSignal(makePulse());
          else if (Math.random() < 0.12) foundSignal(makeTriplet());
        }
      }
      if (wu.p >= 1) {
        wu.p = 1; phase = 'sending'; phaseT = 0;
        user.wus++; store.set('wus', user.wus); store.set('cpu', user.cpu);
      }
    } else if (phase === 'sending' && phaseT > 5) {
      phase = 'receiving'; phaseT = 0;
    } else if (phase === 'receiving' && phaseT > 5) {
      wu = newWorkUnit(); phase = 'analyze'; phaseT = 0;
    }
    chooseSignal();
    const vis = graphRowsVisible();
    if (vis !== graph.shown) { graph.shown = vis; graphDirty = true; }
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
    if (logoReady) { drawLogoTitle(); return; }
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

  // Custom title: "S.E.T.I. @ {logo}" once the viewer uploads a logo (kept in this browser
  // only, via localStorage) or passes ?logo=URL. Without one, the classic title is shown.
  const logoImg = new Image();
  let logoReady = false;
  logoImg.onload = () => { logoReady = logoImg.naturalWidth > 0; updateLogoButtons(); };
  logoImg.onerror = () => { logoReady = false; updateLogoButtons(); };
  function setLogoSrc(src) { logoReady = false; if (src) logoImg.src = src; else { logoImg.removeAttribute('src'); updateLogoButtons(); } }
  function updateLogoButtons() {
    const clear = document.getElementById('logoClear');
    if (clear) clear.hidden = !logoReady;
  }

  function drawLogoTitle() {
    ctx.letterSpacing = '6px';
    font(46, true, TITLE_FONT);
    const label = 'S.E.T.I. @ ';
    const tw = ctx.measureText(label).width;
    const maxW = 560, maxH = 70;
    const k = Math.min(maxW / logoImg.naturalWidth, maxH / logoImg.naturalHeight);
    const lw = logoImg.naturalWidth * k, lh = logoImg.naturalHeight * k;
    drawLogo();                       // the classic globe + signal wave stays on the left
    let x = 214;
    ctx.letterSpacing = '6px'; font(46, true, TITLE_FONT);
    ctx.fillStyle = WHITE; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x, 62);
    ctx.letterSpacing = '0px';
    ctx.drawImage(logoImg, x + tw, 44 - lh / 2, lw, lh);
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
      text(signalText(signal.shown), 24, 223, 21);
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

  // Stepped "ribbon" graph, each series normalised to its own maximum (as in gutil.cpp).
  function ribbon(data, x, y, w, h, color) {
    let max = 0;
    for (const v of data) max = Math.max(max, v);
    if (!max) max = 1;
    const sw = w / data.length;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const yy = y + h - (data[i] / max) * h;
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x + i * sw, yy);
      ctx.lineTo(x + (i + 1) * sw, yy);
    }
    ctx.stroke();
  }

  function drawMiniGraph(x, y, w, h) {
    const s = signal.shown;
    if (!s) return;
    if (s.type === 'gauss') {
      let max = 0;
      for (const v of s.pot) max = Math.max(max, v);
      const fit = s.pot.map((_, i) => { const d = (i - s.ind) / s.sigma; return (s.mean + s.peak * Math.exp(-d * d * 0.693)) / max; });
      ribbon(s.pot, x, y, w, h, LINE_RED);
      ribbon(fit, x, y, w, h, WHITE);
    } else {
      ribbon(s.pot, x, y, w, h, LINE_RED);
      if (s.type === 'triplet') {
        ctx.strokeStyle = GREEN; ctx.lineWidth = 3; ctx.beginPath();
        for (const t of s.ticks) { const xx = x + (t + 0.5) * (w / s.pot.length); ctx.moveTo(xx, y + h * 0.2); ctx.lineTo(xx, y - h * 0.1); }
        ctx.stroke();
      }
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
  // At rest it matches the classic view: front edge (232..1400, 848), depth running up-left
  // to (118..1286, 570). It rocks left/right like a turntable (the GPL client's "roll":
  // roll_range degrees over roll_period seconds). Rotation happens in the floor plane, then
  // the same oblique projection is applied, so at 0 degrees it is identical to the classic.
  const ASP = 1.75;                          // floor width : depth (the GPL client used 7 x 4)
  const AX = 1168 / ASP, BX = -114, BY = -278, MAXH = 92;
  const DEPTH_U = -BX * ASP / 1168;          // view-depth weight of u' for painter sorting
  const P = { cx: 232 + 1168 / 2 + BX / 2, cy: 848 + BY / 2, k: 1, c: 1, s: 0 };
  let fitFor = -1;

  function fitScale() {
    // shrink just enough that the rocking graph never leaves its area
    if (fitFor === cfg.rockDegrees) return;
    fitFor = cfg.rockDegrees;
    let k = 1;
    for (let a = -1; a <= 1; a += 0.25) {
      const th = a * cfg.rockDegrees * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
      for (const x of [0, 1]) for (const z of [0, 1]) for (const y of [0, MAXH]) {
        const u = (x - 0.5) * ASP, v = z - 0.5, u2 = u * c + v * sn, v2 = -u * sn + v * c;
        const dx = u2 * AX + BX * v2, dy = BY * v2 - y;
        if (dx < 0) k = Math.min(k, (P.cx - 112) / -dx); else if (dx > 0) k = Math.min(k, (1405 - P.cx) / dx);
        if (dy < 0) k = Math.min(k, (P.cy - 452) / -dy); else if (dy > 0) k = Math.min(k, (878 - P.cy) / dy);
      }
    }
    P.k = k;
  }

  function setAngle(th) { P.c = Math.cos(th); P.s = Math.sin(th); }
  function projX(u2, v2) { return P.cx + P.k * (u2 * AX + BX * v2); }
  function projY(v2, y) { return P.cy + P.k * (BY * v2 - y); }

  const NP = (NF + 1) * (NT + 1);
  const gx = new Float32Array(NP), gy = new Float32Array(NP), gkey = new Float32Array(NP);
  const order = [];
  for (let t = 0; t < NT; t++) for (let i = 0; i < NF; i++) order.push(t * NF + i);
  const barKey = new Float32Array(NT * NF);

  function drawBars(g) {
    // project the floor grid once
    for (let t = 0; t <= NT; t++) {
      const v = t / NT - 0.5;
      for (let i = 0; i <= NF; i++) {
        const u = (i / NF - 0.5) * ASP, u2 = u * P.c + v * P.s, v2 = -u * P.s + v * P.c, n = t * (NF + 1) + i;
        gx[n] = projX(u2, v2); gy[n] = projY(v2, 0); gkey[n] = DEPTH_U * u2 + v2;
      }
    }
    for (let t = 0; t < NT; t++) for (let i = 0; i < NF; i++) {
      const n = t * (NF + 1) + i;
      barKey[t * NF + i] = (gkey[n] + gkey[n + NF + 2]) / 2;
    }
    order.sort((a, b) => barKey[b] - barKey[a]);           // farthest first

    const vis = graph.shown < 0 ? NT : graph.shown, span = (graph.max - graph.min) || 1;
    const k = P.k;
    g.lineWidth = 1; g.strokeStyle = '#000'; g.lineJoin = 'miter';
    for (const id of order) {
      const t = (id / NF) | 0, i = id - t * NF;
      if (t < NT - vis) continue;                          // grows in from the back
      const v = graph.rows[NT - 1 - t][i];
      const hgt = Math.min(MAXH * 1.25, 4 + v * 30) * k;
      const c = COLS[i][Math.min(LEVELS - 1, Math.round((v - graph.min) / span * (LEVELS - 1)))];
      const a = t * (NF + 1) + i, b = a + 1, d = a + NF + 1, e = d + 1;   // a=front-left b=front-right d=back-left e=back-right
      // side face: whichever side the depth runs towards
      g.fillStyle = c.side; g.beginPath();
      if (gx[d] < gx[a]) { g.moveTo(gx[a], gy[a]); g.lineTo(gx[d], gy[d]); g.lineTo(gx[d], gy[d] - hgt); g.lineTo(gx[a], gy[a] - hgt); }
      else { g.moveTo(gx[b], gy[b]); g.lineTo(gx[e], gy[e]); g.lineTo(gx[e], gy[e] - hgt); g.lineTo(gx[b], gy[b] - hgt); }
      g.fill();
      // top
      g.fillStyle = c.top; g.beginPath();
      g.moveTo(gx[a], gy[a] - hgt); g.lineTo(gx[b], gy[b] - hgt); g.lineTo(gx[e], gy[e] - hgt); g.lineTo(gx[d], gy[d] - hgt); g.closePath();
      g.fill(); g.stroke();
      // front
      g.fillStyle = c.front; g.beginPath();
      g.moveTo(gx[a], gy[a]); g.lineTo(gx[b], gy[b]); g.lineTo(gx[b], gy[b] - hgt); g.lineTo(gx[a], gy[a] - hgt); g.closePath();
      g.fill(); g.stroke();
    }
  }

  // corner of the graph box: x,z in 0..1, y = height in px
  function corner(x, z, y) {
    const u = (x - 0.5) * ASP, v = z - 0.5, u2 = u * P.c + v * P.s, v2 = -u * P.s + v * P.c;
    return [projX(u2, v2), projY(v2, y * P.k)];
  }

  const graphCanvas = document.createElement('canvas');
  const gctx = graphCanvas.getContext('2d');
  let graphScale = 0, graphDrawnAt = -1, graphAngle = NaN;

  function renderGraphLayer(scale) {
    const w = Math.ceil(VW * scale), h = Math.ceil((VH - 455) * scale);
    if (graphCanvas.width !== w || graphCanvas.height !== h) { graphCanvas.width = w; graphCanvas.height = h; }
    const g = gctx;
    g.setTransform(scale, 0, 0, scale, 0, -455 * scale);
    g.clearRect(0, 455, VW, VH);
    drawBars(g);
    // box outline (thin grey), drawn over the bars like the original
    const p = (x, z, y) => corner(x, z, y);
    const fl = p(0, 0, 0), bl = p(0, 1, 0), blT = p(0, 1, MAXH), brT = p(1, 1, MAXH), frT = p(1, 0, MAXH), fr = p(1, 0, 0);
    g.strokeStyle = '#8c8c8c'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(...bl); g.lineTo(...fl);
    g.moveTo(...bl); g.lineTo(...blT); g.lineTo(...brT); g.lineTo(...frT); g.lineTo(...fr);
    g.moveTo(...fl); g.lineTo(...fr);
    g.stroke();
  }

  function drawGraph(scale) {
    fitScale();
    const th = cfg.rockDegrees ? Math.sin(2 * Math.PI * clock / cfg.rockSeconds) * cfg.rockDegrees * Math.PI / 180 : 0;
    const now = performance.now();
    const moved = Math.abs(th - graphAngle) > 0.0007 && now - graphDrawnAt > 50;  // rock redraw: small steps, <= 20 fps
    if (graphDirty || moved || scale !== graphScale) {
      setAngle(th); graphAngle = th;
      renderGraphLayer(scale); graphDirty = false; graphScale = scale; graphDrawnAt = now;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const m = view;
    ctx.drawImage(graphCanvas, m.ox, m.oy + 455 * m.s, graphCanvas.width * (m.s / scale), graphCanvas.height * (m.s / scale));
    ctx.restore();

    // axis labels ride along with the box corners
    const fl = corner(0, 0, 0), bl = corner(0, 1, 0), fr = corner(1, 0, 0), fm = corner(0.5, 0, 0), lm = corner(0, 0.5, 0);
    text(WU_TIME.toFixed(1), bl[0] - 23, bl[1] + 14, 21, WHITE, 'right');
    text('Time (sec)', lm[0] - 26, lm[1] + 7, 21, WHITE, 'right');
    text('0', fl[0] - 30, fl[1] - 6, 21, WHITE, 'right');
    const below = (y) => Math.min(y + 27, 880);                 // keep labels on screen at the rock extremes
    text('0.0', fl[0] + 13, below(fl[1]), 21);
    text('Frequency (Hz)', fm[0] + 26, below(fm[1]), 21, WHITE, 'center');
    text((BANDWIDTH - 0.005).toFixed(3), fr[0] + 7, below(fr[1]), 21, WHITE, 'right');
    text('Power', 1449, 826, 21, WHITE, 'center');
    ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(1449, 800); ctx.lineTo(1449, 728); ctx.moveTo(1440, 740); ctx.lineTo(1449, 728); ctx.lineTo(1458, 740); ctx.stroke();
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
      ['F1 info    F fullscreen    S settings    N name    L logo', 19],
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

  // ---- Settings window (animation speeds) ----
  const SETTING_LABELS = {
    wuMinutes: ['Data unit length', 'min'],
    stepSeconds: ['Analysis step (per FFT pass)', 's'],
    growSeconds: ['Graph grow time', 's'],
    holdSeconds: ['Graph hold time', 's'],
    signalSeconds: ['Signal display time', 's'],
    rockSeconds: ['Graph rock period (left-right-left)', 's'],
    rockDegrees: ['Graph rock angle (0 = off)', '\u00b0'],
  };
  const dlg = document.getElementById('settings');
  const rowsEl = document.getElementById('settingsRows');
  const inputs = {};
  for (const [key, [label, unit]] of Object.entries(SETTING_LABELS)) {
    const [mn, mx, step] = LIMITS[key];
    const row = document.createElement('div'); row.className = 'row';
    const id = 'set-' + key;
    row.innerHTML = `<label for="${id}">${label}</label><input type="range" id="${id}" min="${mn}" max="${mx}" step="${step}"><output for="${id}"></output>`;
    rowsEl.appendChild(row);
    const input = row.querySelector('input'), out = row.querySelector('output');
    inputs[key] = { input, out, unit };
    input.addEventListener('input', () => {
      cfg[key] = +input.value;
      out.textContent = input.value + (unit === '\u00b0' ? '' : ' ') + unit;
      onSettingsChanged(key);
    });
  }
  function syncSettingsForm() {
    for (const [key, { input, out, unit }] of Object.entries(inputs)) { input.value = cfg[key]; out.textContent = cfg[key] + (unit === '\u00b0' ? '' : ' ') + unit; }
  }
  function onSettingsChanged(key) {
    const save = {};
    for (const k of Object.keys(DEFAULTS)) save[k] = cfg[k];
    store.set('settings', save);
    if (key === 'wuMinutes' || key === 'stepSeconds') {
      wu.slots = Math.max(6, Math.round(cfg.wuMinutes * 60 / cfg.stepSeconds));
    }
    graphDirty = true;
  }
  function openSettings() { syncSettingsForm(); if (!dlg.open) dlg.showModal(); }
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsReset').addEventListener('click', () => {
    Object.assign(cfg, DEFAULTS); syncSettingsForm(); onSettingsChanged('wuMinutes');
  });

  // ---- user logo upload (stays in this browser) ----
  const logoFile = document.getElementById('logoFile');
  function pickLogo() { logoFile.value = ''; logoFile.click(); }
  logoFile.addEventListener('change', () => {
    const f = logoFile.files && logoFile.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      // shrink to title size so it fits comfortably in localStorage
      const k = Math.min(1, 1120 / img.naturalWidth, 140 / img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL('image/png');
      store.set('logo', data);
      setLogoSrc(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('That file could not be read as an image.'); };
    img.src = url;
  });
  document.getElementById('logoBtn').addEventListener('click', pickLogo);
  document.getElementById('logoClear').addEventListener('click', () => { store.set('logo', null); setLogoSrc(null); });
  setLogoSrc(params.get('logo') || store.get('logo', null));
  canvas.addEventListener('dblclick', toggleFullscreen);
  canvas.addEventListener('click', () => { showInfo = false; });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (dlg.open) return;                       // typing in the Settings window
    if (e.key === 'F1') { e.preventDefault(); showInfo = !showInfo; return; }
    if (showInfo) { showInfo = false; return; }
    const k = e.key.toLowerCase();
    if (k === 'f') toggleFullscreen();
    else if (k === 'n') askName();
    else if (k === 'l') pickLogo();
    else if (k === 's') { e.preventDefault(); openSettings(); }
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
  newGraphArray(1024); graph.start = -cfg.growSeconds;
})();
