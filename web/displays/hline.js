/*
 * Retro SETI display: Hydrogen Line Survey.
 * A simulated drift-scan survey of the Milky Way's 21 cm hydrogen line, using the same
 * physical model as the Hydrogen Line Observatory page (hmodel.js). Time runs fast so the
 * sky visibly drifts; it starts at the current date and time.
 */
(() => {
  'use strict';
  const R = window.RetroSETI, H = window.HModel;
  if (!R || !H) return;
  const { ctx, text, colors } = R;
  const { NV, vAt, VMIN, VMAX } = H;

  const SITE = { lat: 38.43, lon: -79.84, name: 'Green Bank, West Virginia' };
  const DISH = 4.5, BEAM = 70 * H.LAMBDA / DISH;      // degrees
  const SPEED = 120;                                    // simulated seconds per real second
  const DECS = [38, 28, 48, 18, 58, 8, 68, -2];         // survey declinations, one per 2 simulated hours

  let simT = Date.now(), start = simT, spec = new Float32Array(NV), acc = 0, integ = 0;
  const fall = [];                                      // recent spectra, newest first
  const lv = new Float32Array(180 * NV), lvN = new Uint16Array(180);
  const track = [];                                     // recent pointings for the sky map

  function pointingNow() {
    const k = Math.floor((simT - start) / (2 * 3600 * 1000)) % DECS.length;
    const dec = DECS[k];
    const lst = H.lstHours(simT, SITE.lon);
    const ra = ((lst * 15) % 360 + 360) % 360;          // on the meridian: RA = LST
    const g = H.eqToGal(ra, dec);
    return { ra, dec, l: g.l, b: g.b, lst };
  }

  function tick(dt) {
    simT += dt * SPEED * 1000;
    acc += dt;
    if (acc < 0.25) return;
    acc = 0;
    const p = pointingNow();
    const s = H.demoSpectrumAt(p, simT, BEAM);
    // a running average makes the live spectrum look like it is integrating
    integ = Math.min(integ + 1, 12);
    for (let i = 0; i < NV; i++) spec[i] += (s[i] - spec[i]) / integ;
    fall.unshift(Float32Array.from(s));
    if (fall.length > 160) fall.pop();
    if (Math.abs(p.b) < 6) {
      const il = Math.min(179, Math.floor(p.l / 2));
      for (let i = 0; i < NV; i++) lv[il * NV + i] += s[i];
      lvN[il]++;
    }
    track.push([p.ra, p.dec]);
    layersDirty = true;
    if (track.length > 4000) track.shift();
  }

  // ---- colour map: black -> blue -> purple -> red -> yellow -> white ----
  function cmap(t) {
    const st = [[0, 0, 0, 0], [0.2, 20, 10, 120], [0.4, 120, 40, 200], [0.6, 230, 40, 70], [0.8, 255, 170, 30], [1, 255, 255, 230]];
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < st.length; i++) if (t <= st[i][0]) { const a = st[i - 1], b = st[i], f = (t - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]; }
    return [255, 255, 230];
  }
  // colour lookup table (no per-pixel allocations) and cached heatmap layers
  const LUT = new Uint32Array(1024);
  for (let i = 0; i < 1024; i++) { const [r, g, b] = cmap(i / 1023); LUT[i] = (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0; }
  function layer(grid, nx, ny, vmax, cv) {
    if (cv.width !== nx || cv.height !== ny) { cv.width = nx; cv.height = ny; }
    const g = cv.getContext('2d'), img = g.createImageData(nx, ny), px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < nx * ny; i++) px[i] = LUT[Math.min(1023, Math.max(0, Math.sqrt(Math.max(0, grid[i]) / vmax) * 1023) | 0)];
    g.putImageData(img, 0, 0);
    return cv;
  }
  const fallCv = document.createElement('canvas'), lvCv = document.createElement('canvas'), skyCv = document.createElement('canvas');
  let layersDirty = true;
  function rebuildLayers() {
    layersDirty = false;
    if (fall.length) {
      const ny = 160, grid = new Float32Array(NV * ny);
      let vmax = 0.03;
      for (let r = 0; r < Math.min(ny, fall.length); r++) for (let i = 0; i < NV; i++) { grid[r * NV + i] = fall[r][i]; if (fall[r][i] > vmax) vmax = fall[r][i]; }
      layer(grid, NV, ny, vmax, fallCv);
    }
    const grid = new Float32Array(180 * NV);
    let vmax = 0.03;
    for (let il = 0; il < 180; il++) if (lvN[il]) for (let i = 0; i < NV; i++) {
      const v = lv[il * NV + i] / lvN[il];
      grid[(NV - 1 - i) * 180 + (179 - il)] = v; if (v > vmax) vmax = v;
    }
    layer(grid, 180, NV, vmax, lvCv);
  }
  function blitLayer(cv, x, y, w, h) { ctx.imageSmoothingEnabled = true; ctx.drawImage(cv, x, y, w, h); }

  // precomputed Milky Way glow for the sky map (integrated hydrogen over a coarse RA/Dec grid)
  const SKY_NX = 120, SKY_NY = 60, sky = new Float32Array(SKY_NX * SKY_NY);
  for (let iy = 0; iy < SKY_NY; iy++) for (let ix = 0; ix < SKY_NX; ix++) {
    const ra = 360 - (ix + 0.5) / SKY_NX * 360, dec = 90 - (iy + 0.5) / SKY_NY * 180;
    const g = H.eqToGal(ra, dec);
    sky[iy * SKY_NX + ix] = Math.exp(-0.5 * (g.b / 7) ** 2) * (0.55 + 0.45 * Math.cos(g.l * Math.PI / 180) ** 2) + 0.04 * Math.exp(-0.5 * (g.b / 30) ** 2);
  }

  layer(sky, SKY_NX, SKY_NY, 1, skyCv);

  function axisText(s, x, y, align = 'center') { text(s, x, y, 15, '#bbb', align); }

  function draw() {
    const p = pointingNow();
    R.header('HYDROGEN LINE', 'SURVEY', [R.utc(simT), `${DISH} m dish · 1420.40575 MHz · ${SITE.name}`]);

    // --- spectrum ---
    R.panel(20, 104, 720, 384, 'Spectrum');
    {
      const x0 = 80, y0 = 160, w = 640, h = 250;
      let ymax = 0.05;
      for (let i = 0; i < NV; i++) ymax = Math.max(ymax, spec[i] * 1.2);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
      for (let v = -200; v <= 200; v += 100) { const x = x0 + (v - VMIN) / (VMAX - VMIN) * w; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke(); axisText(String(v), x, y0 + h + 18); }
      ctx.strokeStyle = '#7f7f7f'; ctx.strokeRect(x0, y0, w, h);
      ctx.strokeStyle = colors.RED; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < NV; i++) {
        const x = x0 + i / (NV - 1) * w, y = y0 + h - (spec[i] + 0.01) / (ymax + 0.01) * h;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      axisText('Velocity (km/s)', x0 + w / 2, y0 + h + 40);
      text(`RA ${hm(p.ra / 15)}   Dec ${p.dec >= 0 ? '+' : ''}${p.dec.toFixed(1)}°   l ${p.l.toFixed(1)}°   b ${p.b.toFixed(1)}°`, x0 + 8, y0 + 22, 17, colors.GREEN);
      text(`LST ${hm(p.lst)}   beam ${BEAM.toFixed(1)}°   integrating ${integ * 30} s`, x0 + 8, y0 + 44, 17, '#ccc');
    }

    // --- waterfall ---
    R.panel(20, 504, 720, 366, 'Waterfall');
    if (layersDirty) rebuildLayers();
    if (fall.length) {
      blitLayer(fallCv, 50, 556, 660, 268);
      ctx.strokeStyle = '#7f7f7f'; ctx.strokeRect(50, 556, 660, 268);
      axisText('← approaching        Velocity        receding →', 380, 846);
    }

    // --- sky map ---
    R.panel(760, 104, 720, 384, 'Sky');
    {
      const x0 = 800, y0 = 150, w = 640, h = 300;
      blitLayer(skyCv, x0, y0, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x0, y0, w, h);
      const X = (ra) => x0 + (360 - ra) / 360 * w, Y = (dec) => y0 + (90 - dec) / 180 * h;
      ctx.fillStyle = 'rgba(53,222,167,0.55)';
      for (const [ra, dec] of track) ctx.fillRect(X(ra) - 1, Y(dec) - 1.5, 2, 3);
      ctx.strokeStyle = colors.GREEN; ctx.lineWidth = 2;
      const cx = X(p.ra), cy = Y(p.dec), r = BEAM / 360 * w * 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.moveTo(cx - r - 10, cy); ctx.lineTo(cx - r, cy); ctx.moveTo(cx + r, cy); ctx.lineTo(cx + r + 10, cy); ctx.stroke();
      ctx.strokeStyle = '#7f7f7f'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, w, h);
      for (const hr of [24, 18, 12, 6, 0]) axisText(`${hr}h`, X(hr * 15), y0 + h + 18);
      for (const d of [-60, 0, 60]) axisText(`${d}°`, x0 - 8, Y(d) + 5, 'right');
    }

    // --- longitude-velocity ---
    R.panel(760, 504, 720, 366, 'Galactic longitude – velocity');
    {
      blitLayer(lvCv, 800, 556, 640, 268);
      ctx.strokeStyle = '#7f7f7f'; ctx.strokeRect(800, 556, 640, 268);
      for (const l of [360, 270, 180, 90, 0]) axisText(`${l}°`, 800 + (360 - l) / 360 * 640, 846);
    }
    R.simulatedTag();
  }
  const hm = (h) => { h = ((h % 24) + 24) % 24; const a = Math.floor(h), m = Math.floor((h - a) * 60); return `${a}h ${String(m).padStart(2, '0')}m`; };

  // earlier survey days: pre-fill the longitude-velocity panel along the part of the
  // Milky Way this site can see, so it isn't empty when the display first appears
  for (let il = 0; il < 180; il++) {
    const l = il * 2 + 1, eq = H.galToEq(l, 0);
    if (eq.dec < SITE.lat - 80) continue;
    const tb = H.modelTB(l, 0);
    for (let i = 0; i < NV; i++) lv[il * NV + i] = 0.5 * tb[i] / 140 + 0.002 * H.gauss();
    lvN[il] = 1;
  }

  // warm up so the first view isn't empty
  for (let i = 0; i < 160; i++) tick(0.25);

  R.register({
    id: 'hline', title: 'Hydrogen Line Survey', tick, draw,
    onShow() { if (Math.abs(simT - Date.now()) > 6 * 3600 * 1000) { simT = Date.now(); start = simT; } },
  });
})();
