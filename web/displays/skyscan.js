/*
 * Retro SETI display: Deep Sky Scanner.
 * A simulated radio antenna slewing across the sky to famous objects (pulsars, quasars,
 * black holes, masers, a fast radio burst source), settling, acquiring and locking on, then
 * showing that object's kind of signal. Object positions are real (J2000); the antenna,
 * its site and every signal are simulated. Pointing uses the current date and time.
 */
(() => {
  'use strict';
  const R = window.RetroSETI, H = window.HModel;
  if (!R || !H) return;
  const { ctx, text, colors, rand } = R;
  const DEG = Math.PI / 180;
  const SITE = { lat: 35.43, lon: -116.89, name: 'Mojave Desert, California' };

  const OBJECTS = [
    { name: 'Crab Pulsar', id: 'PSR B0531+21', type: 'pulsar', ra: 83.633, dec: 22.014, P: 33.4, info: 'Neutron star spinning 30 times a second · 6,500 light-years' },
    { name: 'Vela Pulsar', id: 'PSR B0833-45', type: 'pulsar', ra: 128.836, dec: -45.176, P: 89.3, info: 'Young neutron star in a supernova remnant · 950 light-years' },
    { name: 'PSR B1919+21', id: 'CP 1919', type: 'pulsar', ra: 290.437, dec: 21.884, P: 1337.3, info: 'The first pulsar ever found (1967) · 2,300 light-years' },
    { name: '3C 273', id: 'quasar', type: 'quasar', ra: 187.278, dec: 2.052, z: 0.158, info: 'The first quasar identified · 2.4 billion light-years' },
    { name: 'TON 618', id: 'quasar', type: 'quasar', ra: 187.104, dec: 31.483, z: 2.219, info: 'Hosts one of the most massive known black holes · 10.4 billion light-years' },
    { name: 'APM 08279+5255', id: 'quasar', type: 'quasar', ra: 127.924, dec: 52.755, z: 3.911, info: 'Gravitationally lensed quasar · 12 billion light-years' },
    { name: 'Sagittarius A*', id: 'black hole', type: 'blackhole', ra: 266.417, dec: -29.008, info: 'Black hole at the centre of the Milky Way · 4 million suns' },
    { name: 'Cygnus X-1', id: 'black hole binary', type: 'blackhole', ra: 299.590, dec: 35.202, info: 'Black hole feeding on a companion star · 7,200 light-years' },
    { name: 'M87', id: 'black hole + jet', type: 'blackhole', ra: 187.706, dec: 12.391, info: 'Giant elliptical galaxy with a 5,000 light-year jet' },
    { name: 'W49N', id: 'water maser', type: 'maser', ra: 287.558, dec: 9.107, info: 'Natural microwave laser in a star-forming cloud · 36,000 light-years' },
    { name: 'FRB 20121102A', id: 'fast radio burst', type: 'frb', ra: 82.995, dec: 33.148, info: 'Repeating fast radio burst in a dwarf galaxy · 3 billion light-years' },
    { name: 'Cassiopeia A', id: 'supernova remnant', type: 'snr', ra: 350.850, dec: 58.815, info: 'Brightest radio source beyond the Sun · 11,000 light-years' },
    { name: 'Cygnus A', id: 'radio galaxy', type: 'snr', ra: 299.868, dec: 40.734, info: 'Powerful radio galaxy with giant lobes · 760 million light-years' },
  ];

  function altAz(ra, dec, t) {
    const lst = H.lstHours(t, SITE.lon);
    const h = (lst * 15 - ra) * DEG, d = dec * DEG, lat = SITE.lat * DEG;
    const alt = Math.asin(Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(h));
    let az = Math.atan2(-Math.sin(h) * Math.cos(d), Math.cos(lat) * Math.sin(d) - Math.sin(lat) * Math.cos(d) * Math.cos(h));
    return { alt: alt / DEG, az: ((az / DEG) % 360 + 360) % 360 };
  }

  // antenna state
  let az = 180, el = 45, target = null, state = 'idle', stateT = 0, history = [], targetNo = 0, sig = [], sigT = 0;
  const RATE = 6;   // deg/s (sped up for the display)

  function pickTarget() {
    const now = Date.now();
    const up = OBJECTS.filter((o) => o !== target && altAz(o.ra, o.dec, now).alt > 15);
    const pool = up.length ? up : OBJECTS.filter((o) => o !== target);
    target = pool[Math.floor(Math.random() * pool.length)];
    state = 'slewing'; stateT = 0; targetNo++; sig = [];
    history.push(target.name); if (history.length > 6) history.shift();
  }

  function tick(dt) {
    stateT += dt;
    const t = Date.now();
    if (!target) pickTarget();
    const goal = altAz(target.ra, target.dec, t);
    const tgtEl = Math.max(5, goal.alt);
    if (state === 'slewing') {
      let daz = ((goal.az - az + 540) % 360) - 180;
      const step = RATE * dt;
      az = (az + Math.sign(daz) * Math.min(Math.abs(daz), step) + 360) % 360;
      const del = tgtEl - el;
      el += Math.sign(del) * Math.min(Math.abs(del), step * 0.6);
      if (Math.abs(daz) < 0.05 && Math.abs(del) < 0.05) { state = 'settling'; stateT = 0; }
    } else {
      az = goal.az; el = tgtEl;   // tracking
      if (state === 'settling' && stateT > 2) { state = 'acquiring'; stateT = 0; }
      else if (state === 'acquiring' && stateT > 4) { state = 'locked'; stateT = 0; }
      else if (state === 'locked' && stateT > 22) pickTarget();
    }
    sigT += dt;
  }

  // ---- all-sky map: Hammer-Aitoff in galactic coordinates ----
  const MAP = { x: 40, y: 160, w: 920, h: 440 };
  function hammer(lDeg, bDeg) {
    let l = ((lDeg + 180) % 360 + 360) % 360 - 180;         // centre on the galactic centre
    const L = -l * DEG, B = bDeg * DEG;                       // longitude increases to the left
    const z = Math.sqrt(1 + Math.cos(B) * Math.cos(L / 2));
    const x = 2 * Math.SQRT2 * Math.cos(B) * Math.sin(L / 2) / z, y = Math.SQRT2 * Math.sin(B) / z;
    return [MAP.x + MAP.w / 2 + x / (2 * Math.SQRT2) * MAP.w / 2, MAP.y + MAP.h / 2 - y / Math.SQRT2 * MAP.h / 2];
  }
  // pre-render the sky background (Milky Way glow + stars)
  const bg = document.createElement('canvas'); bg.width = MAP.w; bg.height = MAP.h;
  (function renderSky() {
    const g = bg.getContext('2d'), img = g.createImageData(MAP.w, MAP.h);
    for (let py = 0; py < MAP.h; py++) for (let px = 0; px < MAP.w; px++) {
      const X = ((px + 0.5) / MAP.w * 2 - 1) * 2 * Math.SQRT2, Y = (1 - (py + 0.5) / MAP.h * 2) * Math.SQRT2;
      if (X * X / 8 + Y * Y / 2 > 1) continue;
      const Z = Math.sqrt(1 - (X / 4) ** 2 - (Y / 2) ** 2);
      const L = 2 * Math.atan2(Z * X, 2 * (2 * Z * Z - 1)), B = Math.asin(Z * Y);
      const l = -L / DEG, b = B / DEG;
      const glow = Math.exp(-0.5 * (b / 6) ** 2) * (0.5 + 0.5 * Math.cos(l * DEG / 2) ** 2) + 0.06 * Math.exp(-0.5 * (b / 25) ** 2);
      const i = 4 * (py * MAP.w + px);
      img.data[i] = 18 + 70 * glow; img.data[i + 1] = 14 + 50 * glow; img.data[i + 2] = 40 + 110 * glow; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let k = 0; k < 2600; k++) {
      const b = (Math.random() < 0.6 ? 12 * gaussR() : Math.asin(2 * Math.random() - 1) / DEG), l = Math.random() * 360;
      const [x, y] = hammer(l, Math.max(-89, Math.min(89, b)));
      const m = Math.random();
      g.fillStyle = `rgba(255,255,255,${0.25 + 0.7 * m * m})`;
      g.fillRect(x - MAP.x, y - MAP.y, m > 0.97 ? 2 : 1, m > 0.97 ? 2 : 1);
    }
  })();
  function gaussR() { let u = 0; while (u === 0) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

  // horizon mask: points of the sky below the horizon right now
  let horizonAt = 0;
  const hz = document.createElement('canvas'); hz.width = MAP.w / 4; hz.height = MAP.h / 4;
  function renderHorizon() {
    const g = hz.getContext('2d'), w = hz.width, h = hz.height, img = g.createImageData(w, h);
    const t = Date.now();
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const X = ((px + 0.5) / w * 2 - 1) * 2 * Math.SQRT2, Y = (1 - (py + 0.5) / h * 2) * Math.SQRT2;
      if (X * X / 8 + Y * Y / 2 > 1) continue;
      const Z = Math.sqrt(1 - (X / 4) ** 2 - (Y / 2) ** 2);
      const l = -2 * Math.atan2(Z * X, 2 * (2 * Z * Z - 1)) / DEG, b = Math.asin(Z * Y) / DEG;
      const e = H.galToEq(l, b), a = altAz(e.ra, e.dec, t);
      if (a.alt < 0) { const i = 4 * (py * w + px); img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 150; }
    }
    g.putImageData(img, 0, 0);
  }

  const TYPE_COL = { pulsar: '#35dea7', quasar: '#ffd040', blackhole: '#ff5a3a', maser: '#6ab8ff', frb: '#ff66dd', snr: '#c8a8ff' };

  function drawSignal(x0, y0, w, h) {
    const locked = state === 'locked', acquiring = state === 'acquiring';
    const strength = locked ? 1 : acquiring ? stateT / 4 : 0;
    ctx.strokeStyle = '#7f7f7f'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, w, h);
    const N = 400, ys = new Float32Array(N);
    const T = target.type;
    let xlabel = '';
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1);
      let v = 0.08 * gaussR();
      if (T === 'pulsar') {
        const tt = sigT * 2 + f * 3, P = target.P / 1000 * (target.P < 100 ? 8 : 1);
        const ph = (tt / P) % 1;
        v += strength * Math.exp(-0.5 * (Math.min(ph, 1 - ph) / 0.03) ** 2);
        xlabel = `time →   period ${target.P} ms`;
      } else if (T === 'quasar') {
        // optical spectrum 380-920 nm with broad emission lines shifted by (1+z)
        const lam = 380 + f * 540;
        let line = 0;
        for (const [rest, a] of [[121.6, 1.6], [154.9, 0.8], [190.9, 0.5], [279.8, 0.6], [486.1, 0.4], [656.3, 1.0], [500.7, 0.5]]) {
          const c = rest * (1 + target.z), wdt = c * 0.012;
          line += a * Math.exp(-0.5 * ((lam - c) / wdt) ** 2);
        }
        v += strength * (0.25 + 0.15 * (1 - f) + line * 0.6);
        xlabel = `wavelength 380–920 nm →   redshift z = ${target.z}`;
      } else if (T === 'blackhole') {
        const tt = sigT * 0.4 + f * 6;
        v += strength * (0.35 + 0.18 * Math.sin(tt * 1.7) + 0.12 * Math.sin(tt * 4.3 + 1) + 0.5 * Math.exp(-0.5 * ((tt % 9 - 6) / 0.5) ** 2));
        xlabel = 'time →   flaring X-ray / radio brightness';
      } else if (T === 'maser') {
        const vel = -40 + f * 120;
        for (const [c, a, s] of [[4, 0.9, 1.2], [9, 0.5, 0.8], [-12, 0.4, 1], [22, 0.65, 0.7], [31, 0.3, 0.9]]) v += strength * a * Math.exp(-0.5 * ((vel - c) / s) ** 2);
        xlabel = 'velocity (km/s) →   22.235 GHz water line';
      } else if (T === 'frb') {
        const tt = (sigT % 6) / 6, sweep = 0.15 + 0.6 * tt;
        v += strength * 1.2 * Math.exp(-0.5 * ((f - sweep) / 0.01) ** 2) * (tt < 0.9 ? 1 : 0);
        xlabel = 'time →   millisecond burst, dispersed across the band';
      } else {
        const fr = 0.3 + f * 1.7;
        v += strength * (0.9 * Math.pow(fr / 0.3, -0.7));
        xlabel = 'frequency 0.3–2 GHz →   synchrotron spectrum';
      }
      ys[i] = v;
    }
    ctx.strokeStyle = TYPE_COL[T]; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < N; i++) { const x = x0 + i / (N - 1) * w, y = y0 + h - 10 - Math.max(0, Math.min(1.25, (ys[i] + 0.15) / 1.9)) * (h - 20); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    text(xlabel, x0 + w / 2, y0 + h + 22, 15, '#bbb', 'center');
    if (T === 'quasar' && locked) {
      for (const [n, rest] of [['Lyα', 121.6], ['C IV', 154.9], ['C III]', 190.9], ['Mg II', 279.8], ['Hβ', 486.1], ['Hα', 656.3]]) {
        const lam = rest * (1 + target.z);
        if (lam > 385 && lam < 915) text(n, x0 + (lam - 380) / 540 * w, y0 + 18, 14, '#ffd040', 'center');
      }
    }
  }

  function drawAntenna(x0, y0) {
    // side view: elevation
    const cx = x0 + 120, cy = y0 + 150;
    ctx.strokeStyle = '#888'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx - 40, cy + 70); ctx.lineTo(cx, cy); ctx.lineTo(cx + 40, cy + 70); ctx.stroke();
    // dish in its own frame pointing along +x: a parabola opening towards +x, feed at the focus
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-el * DEG);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.beginPath();
    for (let y = -62; y <= 62; y += 4) { const x = y * y / 160 - 12; y === -62 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(12, -60); ctx.lineTo(40, 0); ctx.lineTo(12, 60); ctx.stroke();
    ctx.fillStyle = colors.GREEN; ctx.fillRect(36, -4, 8, 8);
    ctx.strokeStyle = 'rgba(53,222,167,0.35)'; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.moveTo(44, 0); ctx.lineTo(150, 0); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    text(`EL ${el.toFixed(2)}°`, cx, y0 + 260, 18, '#fff', 'center');
    // top view: azimuth compass
    const qx = x0 + 340, qy = y0 + 140, r = 80;
    ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(qx, qy, r, 0, 2 * Math.PI); ctx.stroke();
    for (const [lab, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) text(lab, qx + Math.sin(a * DEG) * (r + 14), qy - Math.cos(a * DEG) * (r + 14) + 6, 15, '#bbb', 'center');
    const goal = altAz(target.ra, target.dec, Date.now());
    ctx.strokeStyle = 'rgba(255,208,64,0.6)'; ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(qx + Math.sin(goal.az * DEG) * r, qy - Math.cos(goal.az * DEG) * r); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = colors.GREEN; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(qx + Math.sin(az * DEG) * (r - 6), qy - Math.cos(az * DEG) * (r - 6)); ctx.stroke();
    text(`AZ ${az.toFixed(2)}°`, qx, y0 + 260, 18, '#fff', 'center');
  }

  function draw() {
    const now = Date.now();
    if (now - horizonAt > 30000) { horizonAt = now; renderHorizon(); }
    const lst = H.lstHours(now, SITE.lon);
    R.header('DEEP SKY', 'SCANNER', [R.utc(now), `34 m antenna · ${SITE.name} · LST ${Math.floor(lst)}h ${String(Math.floor((lst % 1) * 60)).padStart(2, '0')}m`]);

    R.panel(20, 104, 960, 540, 'Sky (galactic coordinates)');
    ctx.drawImage(bg, MAP.x, MAP.y);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(hz, MAP.x, MAP.y, MAP.w, MAP.h);
    for (const o of OBJECTS) {
      const g = H.eqToGal(o.ra, o.dec), [x, y] = hammer(g.l, g.b);
      ctx.strokeStyle = TYPE_COL[o.type]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, o === target ? 7 : 5, 0, 2 * Math.PI); ctx.stroke();
      text(o.name, x + 9, y - 7, 13, o === target ? '#fff' : '#aaa');
    }
    // the beam, from the antenna's current az/el
    {
      const lat = SITE.lat * DEG, a = az * DEG, e = el * DEG;
      const sd = Math.sin(e) * Math.sin(lat) + Math.cos(e) * Math.cos(lat) * Math.cos(a);
      const d = Math.asin(sd), hA = Math.atan2(-Math.sin(a) * Math.cos(e), Math.sin(e) * Math.cos(lat) - Math.cos(e) * Math.sin(lat) * Math.cos(a));
      const ra = lst * 15 - hA / DEG, g = H.eqToGal(((ra % 360) + 360) % 360, d / DEG), [x, y] = hammer(g.l, g.b);
      const blink = state === 'locked' || Math.floor(now / 250) % 2;
      ctx.strokeStyle = blink ? '#fff' : colors.GREEN; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 2 * Math.PI); ctx.moveTo(x - 24, y); ctx.lineTo(x - 8, y); ctx.moveTo(x + 8, y); ctx.lineTo(x + 24, y); ctx.moveTo(x, y - 24); ctx.lineTo(x, y - 8); ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 24); ctx.stroke();
    }
    text('shaded: below the horizon right now', 52, 628, 14, '#888');
    Object.entries({ pulsar: 'pulsar', quasar: 'quasar', blackhole: 'black hole', maser: 'maser', frb: 'FRB', snr: 'radio source' }).forEach(([k, v], i) => {
      ctx.fillStyle = TYPE_COL[k]; ctx.fillRect(420 + i * 90, 620, 10, 10); text(v, 434 + i * 90, 630, 13, '#bbb');
    });

    R.panel(1000, 104, 480, 300, 'Antenna');
    drawAntenna(1010, 120);

    R.panel(1000, 420, 480, 224, `Target ${targetNo}`);
    {
      const st = { slewing: 'SLEWING', settling: 'SETTLING', acquiring: 'ACQUIRING SIGNAL', locked: 'SIGNAL LOCK' }[state];
      const col = state === 'locked' ? colors.GREEN : state === 'acquiring' ? '#ffd040' : '#ff8a5a';
      text(target.name, 1240, 490, 26, TYPE_COL[target.type], 'center');
      text(`${target.id} · RA ${(target.ra / 15).toFixed(3)}h  Dec ${target.dec >= 0 ? '+' : ''}${target.dec.toFixed(2)}°`, 1240, 520, 15, '#ccc', 'center');
      text(target.info, 1240, 548, 14, '#aaa', 'center');
      if (state !== 'slewing' || Math.floor(now / 400) % 2) text(st, 1240, 596, 24, col, 'center');
      const g = altAz(target.ra, target.dec, now);
      text(`target az ${g.az.toFixed(1)}°  el ${g.alt.toFixed(1)}°`, 1240, 628, 14, '#888', 'center');
    }

    R.panel(20, 660, 1460, 210, state === 'locked' ? `Signal — ${target.name}` : 'Signal');
    drawSignal(60, 700, 1380, 120);
    R.simulatedTag();
  }

  pickTarget();
  R.register({ id: 'skyscan', title: 'Deep Sky Scanner', tick, draw });
})();
