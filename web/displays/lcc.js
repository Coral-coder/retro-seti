/*
 * Retro SETI display: LAUNCH CONTROL — a 1960s-style launch control center data terminal.
 *
 * An original, period-styled recreation (not a copy of any real screen): a green-phosphor CRT
 * in a console bezel, showing a simulated Saturn V-class count and ascent. The event times and
 * flight values follow the publicly documented Saturn V launch sequence; measurement IDs,
 * layout and wording are invented. Everything is simulated ("TRAINING MODE").
 *
 * Works two ways: as a display in the Retro SETI rotation, and standalone (apollo.html), via
 * window.LCC.create().
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ flight profile
  // Approximate Saturn V ascent: time (s) -> altitude (km), velocity (m/s), downrange (km)
  const PROFILE = [
    [0, 0, 0, 0], [10, 0.1, 15, 0], [20, 0.6, 60, 0.1], [30, 1.8, 140, 0.4], [45, 4.2, 270, 1.5], [60, 7.5, 420, 3.8],
    [83, 13.5, 640, 9.5], [100, 21, 900, 17], [120, 33, 1400, 30], [140, 48, 1980, 50], [161, 67, 2390, 75],
    [180, 82, 2450, 100], [240, 109, 2800, 190], [300, 136, 3450, 300], [360, 153, 4200, 430], [420, 167, 5000, 590],
    [480, 177, 5850, 780], [548, 185, 6870, 1010], [560, 186, 6880, 1050], [600, 188, 7080, 1210], [660, 190, 7480, 1450],
    [699, 191, 7790, 1610], [760, 191, 7790, 2050],
  ];
  function profile(t) {
    if (t <= 0) return { h: 0, v: 0, r: 0 };
    let i = 1;
    while (i < PROFILE.length - 1 && PROFILE[i][0] < t) i++;
    const a = PROFILE[i - 1], b = PROFILE[i], f = Math.min(1, (t - a[0]) / (b[0] - a[0]));
    const s = f * f * (3 - 2 * f);                    // smooth between points
    return { h: a[1] + (b[1] - a[1]) * s, v: a[2] + (b[2] - a[2]) * f, r: a[3] + (b[3] - a[3]) * s };
  }

  // the count and the flight, in mission seconds (negative before liftoff)
  const EVENTS = [
    [-300, 'LAUNCH DIRECTOR GO/NO-GO POLL'],
    [-290, 'RANGE ......... GO'], [-286, 'BOOSTER ....... GO'], [-282, 'GUIDANCE ...... GO'],
    [-278, 'NETWORK ....... GO'], [-274, 'ENVIRONMENTAL . GO'], [-270, 'FLIGHT ........ GO'],
    [-266, 'ALL STATIONS GO FOR LAUNCH'],
    [-187, 'TERMINAL COUNTDOWN SEQUENCER START'],
    [-170, 'S-IVB LOX TANK PRESSURIZATION'], [-150, 'S-II LH2 TANK PRESSURIZATION'],
    [-97, 'S-IC FUEL TANK PRESSURIZATION'], [-72, 'ACCESS ARM RETRACTED'],
    [-50, 'VEHICLE TRANSFER TO INTERNAL POWER'], [-30, 'S-IC LOX PREVALVES CLOSED'],
    [-17, 'GUIDANCE REFERENCE RELEASE'], [-9, 'IGNITION SEQUENCE START'],
    [-6, 'ENGINES 1 THRU 5 RUNNING'], [-2, 'ALL ENGINES THRUST OK'],
    [0, 'HOLDDOWN RELEASE — LIFTOFF'], [1, 'UMBILICALS DISCONNECTED'], [12, 'TOWER CLEARED'],
    [13, 'ROLL PROGRAM START'], [31, 'ROLL PROGRAM COMPLETE'], [66, 'MACH 1'], [83, 'MAX DYNAMIC PRESSURE'],
    [135, 'S-IC CENTER ENGINE CUTOFF'], [161, 'S-IC OUTBOARD ENGINES CUTOFF'], [162, 'S-IC/S-II SEPARATION'],
    [164, 'S-II IGNITION'], [192, 'S-II AFT INTERSTAGE JETTISON'], [197, 'LAUNCH ESCAPE TOWER JETTISON'],
    [204, 'IGM GUIDANCE INITIATED'], [460, 'S-II CENTER ENGINE CUTOFF'], [548, 'S-II OUTBOARD ENGINES CUTOFF'],
    [549, 'S-II/S-IVB SEPARATION'], [552, 'S-IVB IGNITION'], [699, 'S-IVB CUTOFF'], [709, 'ORBIT INSERTION'],
    [740, 'PARKING ORBIT 103.0 X 98.9 NM — GO'],
  ];
  const T_START = -330, T_END = 790;

  function fmtT(t) {
    const s = Math.abs(Math.round(t)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return `${t < 0 ? 'T-' : 'T+'}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  function fmtGmt(ms) {
    const d = new Date(ms), start = Date.UTC(d.getUTCFullYear(), 0, 0), doy = Math.floor((ms - start) / 86400000);
    const p = (v) => String(v).padStart(2, '0');
    return `${String(doy).padStart(3, '0')}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  // ------------------------------------------------------------------ the terminal
  function create(opts = {}) {
    const W = 1024, H = 768;                         // CRT raster
    const COLS = 80, ROWS = 38, CW = W / COLS, LH = 19.4, TOP = 18;
    const term = document.createElement('canvas'); term.width = W; term.height = H;
    const tg = term.getContext('2d');
    const glow = document.createElement('canvas'); glow.width = W / 2; glow.height = H / 2;
    const gg = glow.getContext('2d');
    const filterOK = 'filter' in gg;

    const st = {
      t: T_START, speed: opts.speed || 1, vehicle: 0, hold: 0, holdAt: null, logIdx: 0, log: [],
      page: 0, pageT: 0, lastRaster: -1, amber: !!opts.amber, values: null, valT: 0, trail: [],
    };
    function newMission() {
      st.t = T_START; st.vehicle = 500 + Math.floor(Math.random() * 99); st.log = []; st.logIdx = 0; st.trail = [];
      st.holdAt = Math.random() < 0.5 ? -120 - Math.floor(Math.random() * 60) : null; st.hold = 0;
      addLog('COUNT PICKED UP — VEHICLE SA-' + st.vehicle);
    }
    function addLog(msg, t = st.t) { st.log.push([t, msg]); if (st.log.length > 40) st.log.shift(); }

    const rnd = (a, b) => a + Math.random() * (b - a);
    const jit = (v, p) => v * (1 + (Math.random() - 0.5) * p);

    // engineering values for the current moment (refreshed a few times a second, like a slow display)
    function computeValues() {
      const t = st.t, P = profile(t);
      const sic = t >= -6 && t < 161, cecoIC = t >= 135, sii = t >= 164 && t < 548, ceco2 = t >= 460, sivb = t >= 552 && t < 699;
      const rho = 1.225 * Math.exp(-P.h / 8.5), q = 0.5 * rho * P.v * P.v / 1000;          // kPa
      const vNext = profile(t + 1).v, acc = Math.max(0, (vNext - P.v) / 9.81 + (t > 0 && P.h < 150 ? Math.sin(pitchAt(t) * Math.PI / 180) : 0) * 0.4);
      const frac = (a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
      const v = {
        P, q, acc, mach: P.v / Math.max(295, 340 - P.h * 4),
        pitch: pitchAt(t), roll: t > 13 && t < 31 ? 18 * frac(13, 31) : t >= 31 ? 18 : 0, yaw: t > 0 ? rnd(-0.15, 0.15) : 0,
        // propellant remaining (%)
        icLox: t < -9 ? Math.min(100, jit(100, 0.004)) : 100 * (1 - frac(-6, 161)), icRp1: t < -9 ? jit(100, 0.003) : 100 * (1 - frac(-6, 161)) + 1.5,
        iiLox: t < 164 ? Math.min(100, jit(100, 0.004)) : 100 * (1 - frac(164, 548)), iiLh2: t < 164 ? jit(100, 0.005) : 100 * (1 - frac(164, 548)) + 1,
        ivLox: t < 552 ? Math.min(100, jit(100, 0.004)) : 100 * (1 - 0.72 * frac(552, 699)), ivLh2: t < 552 ? jit(100, 0.005) : 100 * (1 - 0.7 * frac(552, 699)),
        // engines
        f1: [1, 2, 3, 4, 5].map((n) => (sic && !(n === 5 && cecoIC) ? jit(t < 0 ? 980 + (t + 6) * 25 : 1125, 0.01) : 0)),   // chamber pressure psia
        f1Thrust: sic ? (cecoIC ? 4 : 5) * (6.77 + 1.0 * (1 - Math.exp(-P.h / 7))) : 0,                              // MN
        j2: [1, 2, 3, 4, 5].map((n) => (sii && !(n === 5 && ceco2) ? jit(763, 0.012) : 0)),
        j2iv: sivb ? jit(770, 0.01) : 0,
        icLoxP: jit(t < -187 ? 18.0 : 20.5, 0.01), icFuelP: jit(t < -97 ? 24.5 : 28.2, 0.01),
        iiLoxP: jit(t < -150 ? 36 : 39.5, 0.01), iiLh2P: jit(t < -150 ? 31 : 34.5, 0.01),
        ivLoxP: jit(t < -170 ? 38.5 : 41.0, 0.01), ivLh2P: jit(t < -170 ? 28.5 : 31.0, 0.01),
        busV: jit(t < -50 ? 28.0 : 28.6, 0.004), busA: jit(t < -50 ? 42 : 61, 0.03),
        cabin: jit(t < 0 ? 14.7 : Math.max(5.0, 14.7 - t * 0.09), 0.005),
      };
      return v;
    }
    function pitchAt(t) {
      if (t < 13) return 90;
      if (t < 161) return 90 - 65 * Math.pow((t - 13) / 148, 0.85);
      if (t < 699) return 25 - 23 * (t - 161) / 538;
      return 1.5;
    }

    function tick(dt) {
      if (st.lastRaster < 0) newMission();
      const before = st.t;
      // planned hold during the terminal count
      if (st.holdAt !== null && st.t >= st.holdAt && st.hold === 0 && st.t < st.holdAt + 1) {
        st.hold = rnd(15, 35); addLog('HOLD — CALLED BY TEST SUPERVISOR');
        addLog('S-II LH2 VENT VALVE INDICATION'); st.holdAt = null;
      }
      if (st.hold > 0) { st.hold -= dt; if (st.hold <= 0) { st.hold = 0; addLog('INDICATION CLEARED — COUNT RESUMING'); } }
      else st.t += dt * st.speed;
      while (st.logIdx < EVENTS.length && EVENTS[st.logIdx][0] <= st.t) { addLog(EVENTS[st.logIdx][1], EVENTS[st.logIdx][0]); st.logIdx++; }
      if (st.t > 0 && Math.floor(st.t) !== Math.floor(before)) { const P = profile(st.t); st.trail.push([P.r, P.h]); }
      if (st.t > T_END) newMission();
      st.pageT += dt;
      if (st.pageT > 14) { st.pageT = 0; st.page = (st.page + 1) % PAGES.length; }
      st.valT -= dt;
      if (st.valT <= 0 || !st.values) { st.valT = 0.45; st.values = computeValues(); }
    }

    // ---------------------------------------------------------------- raster drawing
    let ink = '#7dff9a', dim = 'rgba(125,255,154,0.45)', hot = '#d8ffe0';
    function setPalette() {
      if (st.amber) { ink = '#ffb347'; dim = 'rgba(255,179,71,0.45)'; hot = '#ffe2b8'; }
      else { ink = '#7dff9a'; dim = 'rgba(125,255,154,0.45)'; hot = '#d8ffe0'; }
    }
    function put(col, row, s, color = ink, bold = false) {
      tg.fillStyle = color; tg.font = `${bold ? 'bold ' : ''}17px "Courier New", Courier, monospace`;
      tg.fillText(s, col * CW, TOP + row * LH);
    }
    const num = (v, w, d) => (Number.isFinite(v) ? v.toFixed(d) : '---').padStart(w);

    const PAGES = [
      { title: 'S-IC STAGE PROPULSION', rows: (v) => [
        ['C0101-101', 'S-IC LOX TANK ULLAGE PRESS', num(v.icLoxP, 7, 1), 'PSIA', [18, 22.5]],
        ['C0102-101', 'S-IC FUEL TANK ULLAGE PRESS', num(v.icFuelP, 7, 1), 'PSIA', [23, 30]],
        ...v.f1.map((p, i) => [`D0${i + 1}10-10${i + 1}`, `F-1 ENGINE ${i + 1} CHAMBER PRESS`, num(p, 7, 0), 'PSIA', null]),
        ['F0105-100', 'S-IC TOTAL THRUST', num(v.f1Thrust, 7, 2), 'MN', null],
        ['L0011-101', 'S-IC LOX MASS REMAINING', num(v.icLox, 7, 1), 'PCT', null],
        ['L0012-101', 'S-IC RP-1 MASS REMAINING', num(Math.min(100, v.icRp1), 7, 1), 'PCT', null],
      ] },
      { title: 'S-II STAGE PROPULSION', rows: (v) => [
        ['C0201-201', 'S-II LOX TANK ULLAGE PRESS', num(v.iiLoxP, 7, 1), 'PSIA', [35, 41]],
        ['C0202-201', 'S-II LH2 TANK ULLAGE PRESS', num(v.iiLh2P, 7, 1), 'PSIA', [30, 36]],
        ...v.j2.map((p, i) => [`D02${i + 1}0-20${i + 1}`, `J-2 ENGINE ${i + 1} CHAMBER PRESS`, num(p, 7, 0), 'PSIA', null]),
        ['L0021-201', 'S-II LOX MASS REMAINING', num(v.iiLox, 7, 1), 'PCT', null],
        ['L0022-201', 'S-II LH2 MASS REMAINING', num(Math.min(100, v.iiLh2), 7, 1), 'PCT', null],
        ['T0201-206', 'S-II LH2 TANK TEMP', num(jit(20.4, 0.01), 7, 1), 'DEG K', null],
      ] },
      { title: 'S-IVB STAGE / INSTRUMENT UNIT', rows: (v) => [
        ['C0301-401', 'S-IVB LOX TANK ULLAGE PRESS', num(v.ivLoxP, 7, 1), 'PSIA', [37, 43]],
        ['C0302-401', 'S-IVB LH2 TANK ULLAGE PRESS', num(v.ivLh2P, 7, 1), 'PSIA', [27, 33]],
        ['D0301-403', 'J-2 ENGINE CHAMBER PRESS', num(v.j2iv, 7, 0), 'PSIA', null],
        ['L0031-401', 'S-IVB LOX MASS REMAINING', num(v.ivLox, 7, 1), 'PCT', null],
        ['L0032-401', 'S-IVB LH2 MASS REMAINING', num(Math.min(100, v.ivLh2), 7, 1), 'PCT', null],
        ['M0601-601', 'IU BUS VOLTAGE', num(v.busV, 7, 2), 'VDC', [27.5, 29.5]],
        ['M0602-601', 'IU BUS CURRENT', num(v.busA, 7, 1), 'AMP', null],
        ['G0603-602', 'ST-124 PLATFORM GIMBAL TEMP', num(jit(44.5, 0.01), 7, 1), 'DEG C', null],
      ] },
      { title: 'GUIDANCE AND FLIGHT DYNAMICS', rows: (v) => [
        ['H0001-603', 'ALTITUDE', num(v.P.h, 7, 2), 'KM', null],
        ['H0002-603', 'VELOCITY (SPACE FIXED)', num(v.P.v + (st.t > 0 ? 408 : 0), 7, 0), 'M/S', null],
        ['H0003-603', 'DOWNRANGE DISTANCE', num(v.P.r, 7, 1), 'KM', null],
        ['H0004-603', 'MACH NUMBER', num(v.P.h < 60 ? v.mach : NaN, 7, 2), '', null],
        ['H0005-603', 'DYNAMIC PRESSURE', num(v.q, 7, 2), 'KPA', [0, 36]],
        ['H0006-603', 'LONGITUDINAL ACCEL', num(v.acc, 7, 2), 'G', [0, 4.9]],
        ['H0010-603', 'PITCH ATTITUDE', num(v.pitch, 7, 2), 'DEG', null],
        ['H0011-603', 'ROLL ATTITUDE', num(v.roll, 7, 2), 'DEG', null],
        ['H0012-603', 'YAW ATTITUDE', num(v.yaw, 7, 2), 'DEG', null],
        ['K0001-801', 'SPACECRAFT CABIN PRESS', num(v.cabin, 7, 2), 'PSIA', null],
      ] },
    ];

    function bar(col, row, label, pct, width) {
      const n = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
      put(col, row, label.padEnd(6), dim);
      put(col + 6, row, '[' + '#'.repeat(n) + '.'.repeat(width - n) + ']', ink);
      put(col + 8 + width, row, (Math.max(0, pct).toFixed(0) + '%').padStart(4), ink);
    }

    function raster(nowMs) {
      setPalette();
      tg.fillStyle = '#000'; tg.fillRect(0, 0, W, H);
      tg.textBaseline = 'top';
      const v = st.values, t = st.t, P = v.P;
      const phase = st.hold > 0 ? 'HOLD' : t < -187 ? 'COUNTDOWN' : t < 0 ? 'TERMINAL COUNT' : t < 709 ? 'POWERED FLIGHT' : 'ORBIT';
      // header
      put(0, 0, 'LAUNCH CONTROL CENTER   FIRING ROOM 1   DATA DISPLAY 07', ink);
      put(62, 0, `GMT ${fmtGmt(nowMs)}`, ink);
      put(0, 1, `VEHICLE SA-${st.vehicle}   PAD 39A   SEQ: ${phase.padEnd(15)}`, dim);
      put(62, 1, 'TRAINING MODE', st.hold > 0 ? hot : dim);
      put(0, 2, '='.repeat(80), dim);
      // big count clock
      tg.fillStyle = st.hold > 0 && Math.floor(nowMs / 500) % 2 ? dim : hot;
      tg.font = 'bold 46px "Courier New", Courier, monospace';
      tg.fillText(fmtT(t), 58 * CW, TOP + 3.1 * LH);
      put(58, 6, st.hold > 0 ? '** HOLD **    ' : t < 0 ? 'COUNT IN PROGRESS' : 'MISSION ELAPSED  ', st.hold > 0 ? hot : dim);

      // measurement page
      const pg = PAGES[st.page];
      put(0, 3, `PAGE ${String(st.page + 1).padStart(2, '0')}  ${pg.title}`, hot, true);
      put(0, 4, 'MEAS NO   DESCRIPTION                   VALUE  UNITS LIM', dim);
      pg.rows(v).forEach((r, i) => {
        const [id, desc, val, unit, lim] = r;
        const x = parseFloat(val);
        const bad = lim && Number.isFinite(x) && (x < lim[0] || x > lim[1]);
        put(0, 5 + i, `${id} ${desc.padEnd(28)}${val}  ${unit.padEnd(5)}`, ink);
        put(53, 5 + i, bad ? 'HI' : lim ? 'OK' : '', bad ? hot : dim);
      });

      // propellant bars (right)
      put(58, 8, 'PROPELLANT LOADS', hot, true);
      bar(58, 9, 'IC LOX', v.icLox, 9); bar(58, 10, 'IC RP1', Math.min(100, v.icRp1), 9);
      bar(58, 11, 'II LOX', v.iiLox, 9); bar(58, 12, 'II LH2', Math.min(100, v.iiLh2), 9);
      bar(58, 13, 'IV LOX', v.ivLox, 9); bar(58, 14, 'IV LH2', Math.min(100, v.ivLh2), 9);
      // engine status row
      put(58, 16, 'ENGINES', hot, true);
      const eng = (on) => (on ? '■' : '□');
      put(58, 17, 'S-IC  ' + v.f1.map((p) => eng(p > 0)).join(' '), ink);
      put(58, 18, 'S-II  ' + v.j2.map((p) => eng(p > 0)).join(' '), ink);
      put(58, 19, 'S-IVB ' + eng(v.j2iv > 0), ink);

      put(0, 20, '-'.repeat(80), dim);

      // trajectory plot
      const gx = 4 * CW, gy = TOP + 21.3 * LH, gw = 50 * CW, gh = 8.2 * LH;
      put(0, 21, 'ALT', dim); put(0, 29, ' 0', dim);
      tg.strokeStyle = dim; tg.lineWidth = 1; tg.strokeRect(gx, gy, gw, gh);
      for (let k = 1; k < 4; k++) { tg.beginPath(); tg.moveTo(gx, gy + gh * k / 4); tg.lineTo(gx + gw, gy + gh * k / 4); tg.setLineDash([2, 6]); tg.stroke(); tg.setLineDash([]); }
      const X = (r) => gx + r / 2100 * gw, Y = (h) => gy + gh - h / 200 * gh;
      // nominal (dim) and actual (bright)
      tg.strokeStyle = dim; tg.beginPath();
      for (let s = 0; s <= 760; s += 10) { const p = profile(s); s ? tg.lineTo(X(p.r), Y(p.h)) : tg.moveTo(X(p.r), Y(p.h)); }
      tg.stroke();
      if (st.trail.length) {
        tg.strokeStyle = hot; tg.lineWidth = 2; tg.beginPath();
        st.trail.forEach(([r, h], i) => (i ? tg.lineTo(X(r), Y(h)) : tg.moveTo(X(r), Y(h))));
        tg.stroke(); tg.lineWidth = 1;
        const [r, h] = st.trail[st.trail.length - 1];
        tg.fillStyle = hot; tg.fillRect(X(r) - 3, Y(h) - 3, 6, 6);
      }
      put(4, 30, '0 KM', dim); put(47, 30, '2100 KM', dim); put(9, 30, 'ALT VS RANGE (DIM=PLAN BRIGHT=ACTUAL)', dim);
      // flight numbers beside the plot
      put(58, 21, 'FLIGHT', hot, true);
      put(58, 22, `ALT   ${num(P.h, 8, 2)} KM`, ink);
      put(58, 23, `VEL   ${num(P.v + (t > 0 ? 408 : 0), 8, 0)} M/S`, ink);
      put(58, 24, `RANGE ${num(P.r, 8, 1)} KM`, ink);
      put(58, 25, `ACCEL ${num(v.acc, 8, 2)} G`, ink);
      put(58, 26, `Q     ${num(v.q, 8, 2)} KPA`, ink);
      put(58, 27, `PITCH ${num(v.pitch, 8, 2)} DEG`, ink);
      put(58, 28, `ROLL  ${num(v.roll, 8, 2)} DEG`, ink);

      put(0, 31, '-'.repeat(80), dim);
      // event log
      const shown = st.log.slice(-5);
      shown.forEach(([et, msg], i) => {
        const newest = i === shown.length - 1;
        put(0, 32 + i, `${fmtT(et)}  ${msg}`, newest ? hot : ink);
      });
      // command line
      const cursor = Math.floor(nowMs / 530) % 2 ? '█' : ' ';
      put(0, 37, `> DISPLAY PAGE ${String(((st.page + 1) % PAGES.length) + 1).padStart(2, '0')} IN ${String(Math.ceil(14 - st.pageT)).padStart(2, '0')} SEC ${cursor}`, dim);
    }

    // ---------------------------------------------------------------- console + CRT effects
    let scan = null, vign = null;
    function effects(w, h) {
      scan = document.createElement('canvas'); scan.width = 4; scan.height = 4;
      const s = scan.getContext('2d'); s.fillStyle = 'rgba(0,0,0,0.35)'; s.fillRect(0, 2, 4, 2);
      vign = document.createElement('canvas'); vign.width = w; vign.height = h;
      const g = vign.getContext('2d');
      const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.75)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }

    function lamp(ctx, x, y, label, on, col) {
      ctx.fillStyle = on ? col : '#2a2a26';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.fill();
      if (on) { ctx.fillStyle = col.replace('rgb', 'rgba').replace(')', ',0.25)'); ctx.beginPath(); ctx.arc(x, y, 18, 0, 2 * Math.PI); ctx.fill(); }
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = '#1b1b18'; ctx.font = 'bold 11px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 16, y + 1);
    }

    function draw(ctx, X0, Y0, Wd, Hd, nowMs) {
      // console: painted steel bezel with the CRT and two lamp columns
      const t = st.t;
      ctx.fillStyle = '#9a978c'; ctx.fillRect(X0, Y0, Wd, Hd);
      const grd = ctx.createLinearGradient(X0, Y0, X0, Y0 + Hd);
      grd.addColorStop(0, 'rgba(255,255,255,0.12)'); grd.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = grd; ctx.fillRect(X0, Y0, Wd, Hd);
      // CRT opening (4:3)
      const ch = Hd - 92, cw = ch * 4 / 3, cx = X0 + (Wd - cw) / 2, cy = Y0 + 28;
      ctx.fillStyle = '#141412'; roundRect(ctx, cx - 18, cy - 18, cw + 36, ch + 36, 26); ctx.fill();
      ctx.fillStyle = '#050605'; roundRect(ctx, cx, cy, cw, ch, 18); ctx.fill();

      // raster -> glow -> screen
      const nowRaster = Math.floor(nowMs / 66);               // ~15 Hz raster refresh
      if (nowRaster !== st.lastRaster) { st.lastRaster = nowRaster; raster(nowMs); if (filterOK) { gg.clearRect(0, 0, glow.width, glow.height); gg.filter = 'blur(5px)'; gg.drawImage(term, 0, 0, glow.width, glow.height); gg.filter = 'none'; } }
      ctx.save();
      roundRect(ctx, cx, cy, cw, ch, 18); ctx.clip();
      const flick = 0.96 + 0.04 * Math.random();
      ctx.globalAlpha = flick;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(term, cx, cy, cw, ch);
      if (filterOK) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55 * flick; ctx.drawImage(glow, cx, cy, cw, ch); ctx.globalCompositeOperation = 'source-over'; }
      ctx.globalAlpha = 1;
      if (!vign || vign.width !== Math.round(cw)) effects(Math.round(cw), Math.round(ch));
      ctx.fillStyle = ctx.createPattern(scan, 'repeat'); ctx.fillRect(cx, cy, cw, ch);
      ctx.drawImage(vign, cx, cy, cw, ch);
      // faint rolling refresh bar
      const by = cy + ((nowMs / 9) % (ch + 120)) - 60;
      const bg = ctx.createLinearGradient(0, by - 60, 0, by + 60);
      bg.addColorStop(0, 'rgba(255,255,255,0)'); bg.addColorStop(0.5, 'rgba(180,255,200,0.035)'); bg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bg; ctx.fillRect(cx, by - 60, cw, 120);
      ctx.restore();
      // glass reflection
      const rg = ctx.createLinearGradient(cx, cy, cx + cw * 0.6, cy + ch * 0.6);
      rg.addColorStop(0, 'rgba(255,255,255,0.06)'); rg.addColorStop(0.4, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg; roundRect(ctx, cx, cy, cw, ch, 18); ctx.fill();

      // lamp columns
      const L = cx - 150, Rr = cx + cw + 36;
      const lampsL = [['TERMINAL CT', t >= -187 && t < 0], ['INT POWER', t >= -50], ['IGNITION', t >= -9 && t < 161], ['LIFTOFF', t >= 0],
        ['MAX Q', t >= 70 && t < 100], ['HOLD', st.hold > 0]];
      const lampsR = [['S-IC', t >= -6 && t < 161], ['S-II', t >= 164 && t < 548], ['S-IVB', t >= 552 && t < 699], ['LET JETT', t >= 197],
        ['ORBIT', t >= 709], ['TRAINING', true]];
      const col = (name) => (name === 'HOLD' ? 'rgb(255,70,50)' : name === 'TRAINING' ? 'rgb(255,190,60)' : 'rgb(110,255,140)');
      lampsL.forEach(([n, on], i) => lamp(ctx, L + 20, cy + 40 + i * 62, n, on && (n !== 'HOLD' || Math.floor(nowMs / 400) % 2), col(n)));
      lampsR.forEach(([n, on], i) => lamp(ctx, Rr + 20, cy + 40 + i * 62, n, on, col(n)));
      // nameplate
      ctx.fillStyle = '#1b1b18'; ctx.font = 'bold 13px Arial, Helvetica, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('DATA DISPLAY  07  ·  LAUNCH VEHICLE SYSTEMS  \u00b7  SIMULATED', X0 + Wd / 2, Y0 + Hd - 10);
    }
    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }

    return {
      tick, draw, state: st,
      setAmber(a) { st.amber = a; st.lastRaster = -2; },
      setSpeed(s) { st.speed = s; },
    };
  }

  window.LCC = { create };

  // as a Retro SETI display
  const R = window.RetroSETI;
  if (R) {
    const term = create();
    R.register({
      id: 'lcc', title: 'Launch Control (1960s data terminal)',
      tick: (dt) => term.tick(dt),
      draw: () => term.draw(R.ctx, 0, 0, R.VW, R.VH, Date.now()),
    });
  }
})();
