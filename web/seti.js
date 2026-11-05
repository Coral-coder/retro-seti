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
  const params = new URLSearchParams(location.search);
  // ---- user-adjustable speeds (Settings window, saved in this browser) ----
  const DEFAULTS = {
    wuMinutes: 15,      // length of one simulated data unit
    stepSeconds: 20,    // one (drift rate, FFT length) analysis pass
    growSeconds: 6,     // 3D graph: time to grow in row by row
    holdSeconds: 4,     // 3D graph: time to hold before the next array
    signalFps: 15,      // how fast the signal graph plays through the data during a search
    graphAngle: 'rock', // 'rock' = constant slow side-to-side sway, 'classic' = random lean per graph (as 3.08 did), 'fixed'
    rockSeconds: 40,    // one full left-right-left sway
    rockAmount: 90,     // how far the depth leans each way (original pixels; 3.08 used 50-119)
  };
  const LIMITS = {
    wuMinutes: [1, 600, 1], stepSeconds: [5, 60, 1], growSeconds: [1, 20, 0.5], holdSeconds: [0, 20, 0.5],
    signalFps: [2, 30, 1], rockSeconds: [10, 120, 1], rockAmount: [20, 119, 1],
  };
  const FFTS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  const BANDWIDTH = 9765.625;           // Hz per data unit
  const WU_TIME = 107.374;              // seconds of telescope data per data unit

  // colours from the 3.08 client's static colour table
  const PURPLE = 'rgb(153,102,255)', GREEN = '#35dea7', WHITE = '#ffffff', LINE_RED = 'rgb(255,0,0)', GREY = 'rgb(127,127,127)';
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
  if (!['classic', 'rock', 'fixed'].includes(cfg.graphAngle)) cfg.graphAngle = DEFAULTS.graphAngle;
  if (params.get('wu')) cfg.wuMinutes = clamp(parseFloat(params.get('wu')) || 15, 0.5, 600);

  // ---------- colour: the classic client's HLS -> RGB (0x412210 in SETI@home 3.08) ----------
  function hueToRgb(m1, m2, h) {
    if (h < 0) h += 1; if (h > 1) h -= 1;
    if (6 * h < 1) return m1 + (m2 - m1) * h * 6;
    if (2 * h < 1) return m2;
    if (3 * h < 2) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
    return m1;
  }
  function hlsToRgb(h, l, s) {
    if (s === 0) { const v = Math.trunc(l * 255); return [v, v, v]; }
    const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
    return [hueToRgb(m1, m2, h + 1 / 3), hueToRgb(m1, m2, h), hueToRgb(m1, m2, h - 1 / 3)].map((v) => Math.trunc(v * 255));
  }

  // ---------- data unit simulation ----------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const GAUSS_POT_LEN = 64, PULSE_POT_LEN = 256, TRIPLET_POT_LEN = 256;
  const WU_SAMPLES = 1048576;           // complex samples in one data unit

  function newWorkUnit() {
    return {
      ra: rand(0, 24), dec: rand(0, 38),
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

  // Per (drift rate, FFT length) pass the client went: Chirping data (when the drift rate
  // changes) -> Computing Fast Fourier Transform -> Searching for Gaussians ->
  // Searching for Pulses / Triplets. These are the client's own status strings.
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

  // ---- the 3D graph, as the 3.08 client built it ----
  // Graph area (in the original's pixels): width = panel - 110, height = panel - 20.
  // Every new graph gets a random viewpoint: dx = 50..119, dy = 200 - dx, and a coin flip
  // for whether the rows lean left or right. One row per pixel of depth; columns = width - dx;
  // bar height budget = height - dy. FFT bins are max-reduced (or stretched) onto the columns,
  // and each row is scaled linearly against the largest value seen so far in this graph.
  const PW = 750, PH = 206, WG = PW - 110, HG = PH - 20, BASE = PH - 20, MARG = 60;
  // lean = signed sideways depth shift (negative: rows lean up-left, positive: up-right);
  // span = horizontal room reserved for it. In 'rock' mode lean sways every frame.
  const cg = { gen: 0, lean: -57, span: 57, dy: 143, n: 143, ncols: 583, maxH: 43, fft: 1024,
               rows: [], maxSoFar: 0, start: -1e9, emitted: 0, lastSpec: -1, lut: null };

  function gumbelMax(q) { return q <= 1 ? expo() : Math.log(q) - Math.log(-Math.log(1 - Math.random() * 0.999999)); }

  function rockLean() { return cg.span * Math.sin(2 * Math.PI * clock / cfg.rockSeconds); }   // fractional: smooth sway

  function newGraph(fft) {
    let lean, span, dy;
    // rock: the sway never stops; each new graph still gets the original's random steepness
    if (cfg.graphAngle === 'rock') { span = cfg.rockAmount; dy = 200 - (50 + Math.floor(Math.random() * 70)); lean = 0; }
    else {
      const dx = cfg.graphAngle === 'fixed' ? 57 : 50 + Math.floor(Math.random() * 70);
      const right = cfg.graphAngle === 'fixed' ? false : Math.random() < 0.5;
      span = dx; dy = 200 - dx; lean = right ? dx : -dx;
    }
    const ncols = WG - span, maxH = HG - dy;
    // colour for every (column, height): HLS(0.5 + 0.5*(ncols-col)/ncols, 0.2 + 0.6*h/maxH, 1)
    const lut = new Uint32Array(ncols * (maxH + 1));
    for (let c = 0; c < ncols; c++) for (let h = 0; h <= maxH; h++) {
      const [R, G, B] = hlsToRgb(0.5 + 0.5 * (ncols - c) / ncols, 0.2 + 0.6 * h / maxH, 1);
      lut[c * (maxH + 1) + h] = (0xff000000 | (B << 16) | (G << 8) | R) >>> 0;
    }
    Object.assign(cg, {
      gen: cg.gen + 1, lean, span, dy, n: Math.max(span, dy), ncols, maxH, fft, lut,
      rows: [], maxSoFar: 0, start: clock, emitted: 0, lastSpec: -1,
    });
    if (cfg.graphAngle === 'rock') cg.lean = rockLean();
  }

  function emitRow() {
    const r = cg.emitted, n = cg.n, ncols = cg.ncols;
    const nfft = WU_SAMPLES / cg.fft;                       // FFTs in this pass
    const spec = Math.floor(r * Math.min(nfft, n) / n);     // which spectrum feeds this row
    let h;
    if (spec === cg.lastSpec && r > 0) {
      h = cg.rows[r - 1];                                   // fewer FFTs than rows: repeat the row
    } else {
      const m = Math.max(1, Math.floor(nfft / n));          // FFTs merged (max) into this row
      const v = new Float32Array(ncols);
      if (cg.fft >= ncols) {
        const k = Math.floor(cg.fft / ncols) * m;
        for (let c = 0; c < ncols; c++) v[c] = gumbelMax(k);
      } else {
        const w = ncols / cg.fft;                           // one bin stretched over w columns
        for (let b = 0; b < cg.fft; b++) {
          const val = gumbelMax(m);
          for (let c = Math.floor(b * w); c < Math.floor((b + 1) * w); c++) v[c] = val;
        }
      }
      if (Math.random() < 0.04) {                           // the odd narrow-band spike
        const c0 = Math.floor(Math.random() * ncols), wid = Math.max(1, Math.floor(ncols / cg.fft));
        const boost = rand(2, 5);
        for (let c = c0; c < Math.min(ncols, c0 + wid); c++) v[c] *= boost;
      }
      let rowMax = 0;
      for (let c = 0; c < ncols; c++) if (v[c] > rowMax) rowMax = v[c];
      cg.maxSoFar = Math.max(cg.maxSoFar, rowMax);
      h = new Uint8Array(ncols);
      for (let c = 0; c < ncols; c++) h[c] = Math.trunc(cg.maxH * v[c] / cg.maxSoFar);
      cg.lastSpec = spec;
    }
    cg.rows.push(h);
    cg.emitted++;
  }

  // ---- signals ----
  // The small graph is blank until something interesting turns up. While a search runs it
  // shows the candidate being examined; otherwise the best found so far ("Best ...").
  const fmt = (v, w, p) => v.toFixed(p).padStart(w);
  function makeGauss() {
    const sigma = rand(3, 8), ind = rand(20, 44), peak = rand(0.4, 3.5), mean = rand(0.8, 1.2);
    const pot = Array.from({ length: GAUSS_POT_LEN }, (_, i) => {
      const d = (i - ind) / sigma;
      return Math.max(0, mean + peak * Math.exp(-d * d * 0.693) + (expo() - 1) * 0.6);
    });
    const chisqr = rand(0.6, 9);
    return { type: 'gauss', peak, mean, sigma, ind, pot, chisqr, score: peak / Math.sqrt(chisqr) };
  }
  // one frame of the pulse search: the profile folded at the period being tried
  function makePulse(period) {
    const peak = rand(0.3, 1.4) + (Math.random() < 0.08 ? rand(0.8, 1.6) : 0);
    const pot = Array.from({ length: PULSE_POT_LEN }, () => Math.min(255, 70 + expo() * 28));
    const at = Math.floor(rand(0, PULSE_POT_LEN)), wid = 1 + Math.floor(rand(0, 4));
    for (let i = at; i < Math.min(PULSE_POT_LEN, at + wid); i++) pot[i] = Math.min(255, 110 + peak * 100);
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
  // During a search the small graph plays rapidly through the data being examined (cfg.signalFps
  // frames a second): the Gaussian fit window slides along the data, and the pulse search flicks
  // through folded profiles as the period is stepped. Otherwise it shows the best so far.
  const signal = { shown: null, best: false, next: 0, scan: 0, period: 0.002, tripletUntil: 0 };
  function keepBest(s) { const cur = wu.best[s.type]; if (!cur || s.score > cur.score) wu.best[s.type] = s; }
  function chooseSignal(st) {
    const searching = phase === 'analyze' && (st.act === 'Searching for Gaussians' || st.act === 'Searching for Pulses / Triplets');
    if (!searching) {
      const b = wu.best.gauss || wu.best.pulse || wu.best.triplet;
      signal.shown = b; signal.best = true; signal.scan = 0; signal.period = 0.002; return;
    }
    if (clock < signal.next) return;
    signal.next = clock + 1 / cfg.signalFps;
    if (st.act === 'Searching for Gaussians') {
      // slide the fit window along the 64-point data
      signal.scan = (signal.scan + 1.5) % (GAUSS_POT_LEN + 16);
      const g = makeGauss();
      g.ind = signal.scan - 8;
      g.pot = g.pot.map((_, i) => { const d = (i - g.ind) / g.sigma; return Math.max(0, g.mean + g.peak * Math.exp(-d * d * 0.693) + (expo() - 1) * 0.6); });
      keepBest(g); signal.shown = g; signal.best = false; return;
    }
    // pulses: step the trial period and fold again; now and then a triplet turns up
    if (clock < signal.tripletUntil) return;
    if (Math.random() < 0.01) {
      const t = makeTriplet(); keepBest(t); signal.shown = t; signal.best = true; signal.tripletUntil = clock + 1.2; return;
    }
    signal.period = signal.period >= 1.2 ? 0.002 : signal.period * 1.07;
    const p = makePulse(signal.period); keepBest(p); signal.shown = p; signal.best = false;
  }
  function signalText(s, best) {
    if (!s) return '';
    if (s.type === 'gauss') return `${best ? 'Best ' : ''}Gaussian: power ${fmt(s.peak, 5, 2)}, fit ${fmt(s.chisqr, 5, 3)}`;
    if (s.type === 'pulse') return `${best ? 'Best ' : ''}Pulse: power ${fmt(s.peak, 5, 2)}, period ${fmt(s.period, 6, 4)}, score ${fmt(s.score, 5, 2)}`;
    return `Best Triplet: power ${fmt(s.peak, 5, 2)}, period ${fmt(s.period, 6, 4)}`;
  }

  // ---------- simulation tick ----------
  let saveAcc = 0;
  function tick(dt) {
    clock += dt;
    phaseT += dt;
    const st = slotState(Math.min(wu.p, 0.99999));
    if (phase === 'analyze') {
      wu.p += dt / (cfg.wuMinutes * 60);
      wu.cpu += dt;
      user.cpu += dt;
      if (clock - cg.start >= cfg.growSeconds + cfg.holdSeconds) newGraph(st.fft);
      if (wu.p >= 1) {
        wu.p = 1; phase = 'sending'; phaseT = 0;
        user.wus++; store.set('wus', user.wus); store.set('cpu', user.cpu);
      }
    } else if (phase === 'sending' && phaseT > 5) {
      phase = 'receiving'; phaseT = 0;
    } else if (phase === 'receiving' && phaseT > 6) {
      wu = newWorkUnit(); phase = 'analyze'; phaseT = 0;
    }
    const due = Math.min(cg.n, Math.floor(cg.n * (clock - cg.start) / cfg.growSeconds));
    while (cg.emitted < due) emitRow();
    chooseSignal(st);
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
  // Text formats are the 3.08 client's own printf strings.
  const hms = (c) => `${Math.floor(c / 3600)} hr ${pad(Math.floor(c / 60) % 60)} min ${(c % 60).toFixed(1).padStart(4, '0')} sec`;

  function transferStatus() {
    const t = phaseT;
    if (phase === 'sending') {
      if (t < 1) return ['Sending result - connecting to server.', t];
      if (t < 4.2) return [`Sending data: ${Math.max(1, Math.floor((t - 1) / 3.2 * 18))}K`, t / 5];
      return ['All data sent.', 1];
    }
    if (t < 1) return ['Getting data - connecting to server.', t / 6];
    if (t < 5) return [`Receiving data: ${Math.max(1, Math.floor((t - 1) / 4 * 340))}K`, t / 6];
    return ['All data received.', 1];
  }

  function drawAnalysis() {
    const st = slotState(Math.min(wu.p, 0.99999));
    text('Data Analysis', 361, 140, 22, WHITE, 'center');
    let act = st.act, sub = st.sub;
    if (phase !== 'analyze') [act, sub] = transferStatus();
    text(act, 24, 167, 21);
    text(`${Math.floor(clamp(sub, 0, 1) * 100)}%`, 565, 167, 21, WHITE, 'right');
    ctx.fillStyle = WHITE; ctx.fillRect(582, 153, Math.max(2, 200 * clamp(sub, 0, 1)), 11);

    if (phase === 'analyze') {
      text(`Doppler drift rate: ${fmt(st.drift, 6, 4)} Hz/sec    Resolution: ${fmt(st.res, 5, 3)} Hz`, 24, 195, 21);
      text(signalText(signal.shown, signal.best), 24, 223, 21);
      drawMiniGraph(24, 238, 773, 96);
    }

    // 3D tube progress bar (the client's red shades: 240/120/80,0,0; grey 127 outline)
    const x = 24, y = 354, w = 746, h = 36, dx = 12, dy = -12;
    const fw = w * wu.p;
    if (fw > 0.5) {
      ctx.fillStyle = 'rgb(120,0,0)'; ctx.fillRect(x, y, fw, h);
      ctx.fillStyle = 'rgb(240,0,0)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.lineTo(x + fw + dx, y + dy); ctx.lineTo(x + fw, y); ctx.fill();
      ctx.fillStyle = 'rgb(80,0,0)';
      ctx.beginPath(); ctx.moveTo(x + fw, y); ctx.lineTo(x + fw + dx, y + dy); ctx.lineTo(x + fw + dx, y + dy + h); ctx.lineTo(x + fw, y + h); ctx.fill();
    }
    ctx.strokeStyle = GREY; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.lineTo(x + w + dx, y + dy); ctx.lineTo(x + w + dx, y + h + dy); ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y); ctx.lineTo(x + w + dx, y + dy);
    ctx.stroke();

    text(`Overall: ${fmt(wu.p * 100, 6, 3)}% done`, 24, 418, 21);
    text(`CPU time: ${hms(wu.cpu)}`, 747, 418, 21, WHITE, 'right');
  }

  // Stepped graph, normalised to its own maximum.
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
  const p2 = (v) => String(v).padStart(2), p3 = (v) => String(v).padStart(3);
  function drawDataInfo() {
    text('Data Info', 1165, 140, 22, WHITE, 'center');
    const raH = Math.floor(wu.ra), raM = Math.floor((wu.ra - raH) * 60), raS = Math.floor(((wu.ra - raH) * 60 - raM) * 60);
    const ad = Math.abs(wu.dec), dD = Math.floor(ad), dM = Math.floor((ad - dD) * 60), dS = Math.floor(((ad - dD) * 60 - dM) * 60);
    text(`From: ${p2(raH)} hr ${p2(raM)}' ${p2(raS)}" RA, +${p3(dD)} deg ${p2(dM)}' ${p2(dS)}" Dec`, 906, 167, 21);
    const d = wu.recorded;
    text(`Recorded on: ${DAYS[d.getUTCDay()]} ${MONS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`, 906, 195, 21);
    text('Source: Arecibo Radio Observatory', 906, 223, 21);
    text(`Base Frequency: ${(wu.base / 1e9).toFixed(9)} GHz`, 906, 251, 21);
  }

  function drawUserInfo() {
    text('User Info', 1163, 323, 22, WHITE, 'center');
    text(`Name: ${user.name.slice(0, 34)}`, 906, 351, 21);
    text(`Data units completed: ${user.wus}`, 906, 379, 21);
    text(`Total computer time: ${hms(user.cpu)}`, 906, 407, 21);
  }

  // ---------- the 3D power / frequency / time graph: pixel renderer ----------
  // Drawn exactly as the 3.08 client did it, at its own resolution (a 750x206 panel at the
  // bottom of a 753x444 window) at RES x that resolution, so the sway moves in sub-pixel steps
  // and the black outlines are thinner, then scaled to the screen. For every row, each pixel
  // column is a vertical line coloured HLS(hue = 0.5 + 0.5*(ncols-col)/ncols,
  // lightness = 0.2 + 0.6*h/maxH, saturation 1); where the neighbour on the open side is
  // taller a black line fills the step, otherwise one black pixel caps the column.
  const PANEL_Y = 238, SCALE = VW / 753;
  const RES = 2, PWR = PW * RES, PHR = PH * RES, BASER = BASE * RES;
  const pcan = document.createElement('canvas'); pcan.width = PWR; pcan.height = PHR;
  const pctx = pcan.getContext('2d');
  const pimg = pctx.createImageData(PWR, PHR);
  const pbuf = new Uint32Array(pimg.data.buffer);
  const BLACK32 = 0xff000000, GREY32 = 0xff7f7f7f;
  const rgb32 = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  let drawnGen = -1, drawnRows = 0;

  function put(x, y, c) { if (x >= 0 && x < PWR && y >= 0 && y < PHR) pbuf[y * PWR + x] = c; }
  function pline(x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      put(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function graphCorners() {
    const { lean, span, dy, ncols, maxH } = cg;
    const fx = MARG + (span - lean) / 2, bx = fx + lean;
    return {
      FL: [fx - 2, BASE + 1], FR: [fx + ncols, BASE + 1],
      BL: [bx - 2, BASE - dy], BR: [bx + ncols, BASE - dy], maxH,
    };
  }

  function drawBox() {
    const { FL, FR, BL, BR, maxH } = graphCorners();
    const L = (a, b) => pline(Math.round(a[0] * RES), Math.round(a[1] * RES), Math.round(b[0] * RES), Math.round(b[1] * RES), GREY32);
    const up = (p) => [p[0], p[1] - maxH];
    L(FL, FR); L(FL, BL); L(BL, BR); L(FR, BR);                 // floor
    L(BL, up(BL)); L(BR, up(BR)); L(up(BL), up(BR));            // back wall
    if (cg.lean > 0) { L(FL, up(FL)); L(up(FL), up(BL)); }      // open side posts + top edge
    else { L(FR, up(FR)); L(up(FR), up(BR)); }
  }

  function drawRow(r) {
    const { lean, span, dy, n, ncols, maxH, lut } = cg;
    const flag = lean > 0;
    const h = cg.rows[r];
    const x0 = Math.round(RES * (MARG + (span - lean) / 2 + lean * (n - r - 1) / n));
    const ys = Math.round(RES * dy * (n - r - 1) / n);
    const mh1 = maxH + 1;
    for (let c = 0; c < ncols; c++) {
      const hc = h[c], H = hc * RES, xl = x0 + c * RES;
      if (xl < 0 || xl + RES > PWR) continue;
      const col = lut[c * mh1 + hc];
      // column body: rows BASER-ys-H+1 .. BASER-ys (screen y grows downwards)
      let yTop = BASER - ys - H + 1, yBot = BASER - ys;
      if (yTop < 0) yTop = 0;
      for (let y = yTop, i = yTop * PWR + xl; y <= yBot; y++, i += PWR) for (let k = 0; k < RES; k++) pbuf[i + k] = col;
      const nb = flag ? c + 1 : c - 1;
      if (nb >= 0 && nb < ncols && h[nb] > hc) {
        // the step up to a taller neighbour: one (high-res) pixel wide, on the side facing it
        const edge = flag ? xl + RES - 1 : xl, Hn = h[nb] * RES;
        for (let y = Math.max(0, BASER - ys - Hn + 1); y <= BASER - ys - H; y++) pbuf[y * PWR + edge] = BLACK32;
      } else {
        const yc = BASER - ys - H;                                    // one-pixel cap
        if (yc >= 0) for (let k = 0, i = yc * PWR + xl; k < RES; k++) pbuf[i + k] = BLACK32;
      }
    }
  }

  let drawnLean = NaN, lastSwayDraw = 0;
  function updatePanel() {
    let changed = false;
    if (cfg.graphAngle === 'rock') cg.lean = rockLean();
    const leanKey = Math.round(cg.lean * RES), now = performance.now();
    const swayed = drawnLean !== leanKey && now - lastSwayDraw > 33;   // at most 30 sway redraws a second
    if (drawnGen !== cg.gen || swayed) {
      lastSwayDraw = now;       // new graph, or the sway moved a (high-res) pixel
      pbuf.fill(BLACK32); drawBox(); drawnGen = cg.gen; drawnLean = leanKey; drawnRows = 0; changed = true;
    }
    while (drawnRows < cg.emitted) { drawRow(drawnRows++); changed = true; }
    if (changed) pctx.putImageData(pimg, 0, 0);
  }

  const toV = (px, py) => [px * SCALE, (PANEL_Y + py) * SCALE];

  function drawGraph() {
    updatePanel();
    ctx.save();
    ctx.imageSmoothingEnabled = true;                        // smooth scaling: no shimmer as it moves
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pcan, 0, PANEL_Y * SCALE, PW * SCALE, PH * SCALE);
    ctx.restore();

    // labels (the client: "%5.1f" for the time span, "%5.3f" for the bandwidth)
    const { FL, FR, BL, BR } = graphCorners();
    const below = BASE + 14;
    let [x, y] = toV(FL[0] + 6, below); text('0.0', x, y, 21);
    [x, y] = toV((FL[0] + FR[0]) / 2 + 13, below); text('Frequency (Hz)', x, y, 21, WHITE, 'center');
    [x, y] = toV(FR[0] + 3, below); text(fmt(BANDWIDTH - 0.005, 5, 3), x, y, 21, WHITE, 'right');
    const side = cg.lean > 0 ? 1 : -1;                          // time labels on the leaning side
    const back = cg.lean > 0 ? BR : BL, front = cg.lean > 0 ? FR : FL, align = cg.lean > 0 ? 'left' : 'right';
    [x, y] = toV(back[0] + side * 12, back[1] + 7); text(fmt(WU_TIME, 5, 1).trim(), x, y, 21, WHITE, align);
    [x, y] = toV((back[0] + front[0]) / 2 + side * 13, (back[1] + front[1]) / 2 + 3); text('Time (sec)', x, y, 21, WHITE, align);
    [x, y] = toV(front[0] + side * 15, front[1] - 3); text('0', x, y, 21, WHITE, align);
    const px = cg.lean > 0 ? 23 : PW - 23;                      // "Power" arrow on the other side
    [x, y] = toV(px, 177); text('Power', x, y, 21, WHITE, 'center');
    const [ax, ay0] = toV(px, 163), [, ay1] = toV(px, 127);
    ctx.strokeStyle = WHITE; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay0); ctx.lineTo(ax, ay1); ctx.moveTo(ax - 9, ay1 + 12); ctx.lineTo(ax, ay1); ctx.lineTo(ax + 9, ay1 + 12); ctx.stroke();
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
    drawGraph();
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
    signalFps: ['Signal graph playthrough speed', '/s'],
    rockSeconds: ['Rock period (left-right-left)', 's'],
    rockAmount: ['Rock amount', 'px'],
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
  // graph angle: how each new 3D graph is viewed
  const angleRow = document.createElement('div'); angleRow.className = 'row';
  angleRow.innerHTML = `<label for="set-graphAngle">Graph angle</label>
    <select id="set-graphAngle" style="grid-column:1/3;background:#000a28;color:#fff;border:1px solid #3d5aa0;padding:5px;border-radius:3px;font:inherit">
      <option value="rock">Rock: constant slow sway from side to side</option>
      <option value="classic">Per graph: random lean for each new graph (as the 3.08 binary does)</option>
      <option value="fixed">Fixed: always the v3.07 screenshot angle</option>
    </select>`;
  rowsEl.appendChild(angleRow);
  const angleSel = angleRow.querySelector('select');
  angleSel.addEventListener('change', () => { cfg.graphAngle = angleSel.value; onSettingsChanged('graphAngle'); });
  function syncSettingsForm() {
    for (const [key, { input, out, unit }] of Object.entries(inputs)) { input.value = cfg[key]; out.textContent = cfg[key] + (unit === '\u00b0' ? '' : ' ') + unit; }
    angleSel.value = cfg.graphAngle;
  }
  function onSettingsChanged(key) {
    const save = {};
    for (const k of Object.keys(DEFAULTS)) save[k] = cfg[k];
    store.set('settings', save);
    if (key === 'wuMinutes' || key === 'stepSeconds') {
      wu.slots = Math.max(6, Math.round(cfg.wuMinutes * 60 / cfg.stepSeconds));
    }
    if (key === 'graphAngle' || key === 'rockAmount') cg.start = -1e9;   // start a graph with the new view
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
  newGraph(1024); cg.start = -cfg.growSeconds; while (cg.emitted < cg.n) emitRow();
})();
