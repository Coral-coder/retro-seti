/*
 * Retro SETI display: Black Hole Imaging.
 * A simulated Earth-sized radio interferometer (Event Horizon Telescope style) at 230 GHz.
 * As Earth turns, each pair of stations traces an arc in the (u,v) plane; the image is
 * rebuilt from those samples of the source's Fourier transform and sharpens as coverage
 * fills in. Station positions are the real sites; the data are simulated. Current date/time.
 */
(() => {
  'use strict';
  const R = window.RetroSETI;
  if (!R) return;
  const { ctx, text, colors, rand } = R;
  const DEG = Math.PI / 180;
  const LAMBDA = 1.3e-3;                  // m (230 GHz)
  const RE = 6371e3;                      // m
  const MUAS = Math.PI / 180 / 3600 / 1e6; // micro-arcseconds in radians

  const STATIONS = [
    ['ALMA', -23.03, -67.75], ['APEX', -23.01, -67.76], ['LMT', 18.99, -97.31], ['SMT', 32.70, -109.89],
    ['JCMT', 19.82, -155.48], ['SMA', 19.82, -155.48], ['IRAM 30m', 37.07, -3.39], ['NOEMA', 44.63, 5.91],
    ['SPT', -89.99, -45.0], ['GLT', 76.53, -68.69], ['KP 12m', 31.95, -111.61],
  ].map(([name, lat, lon]) => ({ name, lat, lon, x: RE * Math.cos(lat * DEG) * Math.cos(lon * DEG), y: RE * Math.cos(lat * DEG) * Math.sin(lon * DEG), z: RE * Math.sin(lat * DEG) }));

  const TARGETS = [
    { name: 'M87*', kind: 'Supermassive black hole · 6.5 billion suns · 55 million light-years', ra: 187.706, dec: 12.391, model: 'ring', d: 42, pa: 200, asym: 0.6 },
    { name: 'Sgr A*', kind: 'The Milky Way’s black hole · 4 million suns · 27,000 light-years', ra: 266.417, dec: -29.008, model: 'ring', d: 52, pa: 150, asym: 0.4 },
    { name: '3C 279', kind: 'Quasar (blazar) · relativistic jet · 5 billion light-years', ra: 194.047, dec: -5.789, model: 'jet', pa: 230 },
    { name: 'Centaurus A', kind: 'Radio galaxy · jet launching region · 12 million light-years', ra: 201.365, dec: -43.019, model: 'jet', pa: 50 },
  ];

  // source brightness model (micro-arcseconds), used to "observe" visibilities and as the final image
  const FOV = 160, NIMG = 48;
  function modelImage(tg) {
    const img = new Float32Array(NIMG * NIMG);
    for (let iy = 0; iy < NIMG; iy++) for (let ix = 0; ix < NIMG; ix++) {
      const x = ((ix + 0.5) / NIMG - 0.5) * FOV, y = (0.5 - (iy + 0.5) / NIMG) * FOV;
      let v = 0;
      if (tg.model === 'ring') {
        const r = Math.hypot(x, y), th = Math.atan2(y, x) - tg.pa * DEG;
        v = Math.exp(-0.5 * ((r - tg.d / 2) / 5) ** 2) * (1 + tg.asym * Math.cos(th));
      } else {
        const c = Math.cos(tg.pa * DEG), s = Math.sin(tg.pa * DEG), u = x * c + y * s, w = -x * s + y * c;
        v = 1.6 * Math.exp(-0.5 * (x * x + y * y) / 36);
        for (const [k, a] of [[18, 0.7], [38, 0.45], [60, 0.3]]) v += a * Math.exp(-0.5 * (((u - k) / 7) ** 2 + (w / 6) ** 2));
      }
      img[iy * NIMG + ix] = v;
    }
    return img;
  }

  let tg, tgi = -1, ha, uv, img, recon, sinceRecon, cleanPhase, model, fringes, obsStart, dataPB;
  function nextTarget() {
    tgi = (tgi + 1) % TARGETS.length; tg = TARGETS[tgi];
    model = modelImage(tg);
    ha = -6; uv = []; recon = new Float32Array(NIMG * NIMG); sinceRecon = 0; cleanPhase = 0;
    fringes = new Set(); obsStart = Date.now(); dataPB = 0;
  }

  function elevation(st, haH, decDeg) {
    // hour angle at the station = array hour angle + longitude offset (relative to Greenwich here)
    const h = (haH * 15 + st.lon) * DEG, lat = st.lat * DEG, d = decDeg * DEG;
    return Math.asin(Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(h)) / DEG;
  }

  // sample the model's Fourier transform at (u,v) (in wavelengths): returns [re, im]
  function visibility(u, v) {
    let re = 0, im = 0;
    for (let iy = 0; iy < NIMG; iy += 2) for (let ix = 0; ix < NIMG; ix += 2) {
      const b = model[iy * NIMG + ix];
      if (b < 0.02) continue;
      const x = ((ix + 0.5) / NIMG - 0.5) * FOV * MUAS, y = (0.5 - (iy + 0.5) / NIMG) * FOV * MUAS;
      const ph = -2 * Math.PI * (u * x + v * y);
      re += b * Math.cos(ph); im += b * Math.sin(ph);
    }
    return [re, im];
  }

  function addSamples() {
    const H = ha * 15 * DEG, d = tg.dec * DEG;
    for (let a = 0; a < STATIONS.length; a++) for (let b = a + 1; b < STATIONS.length; b++) {
      const A = STATIONS[a], B = STATIONS[b];
      if (A.name === 'APEX' && B.name === 'ALMA' || A.name === 'JCMT' && B.name === 'SMA') continue;   // co-located
      if (elevation(A, ha, tg.dec) < 12 || elevation(B, ha, tg.dec) < 12) continue;
      const bx = (B.x - A.x) / LAMBDA, by = (B.y - A.y) / LAMBDA, bz = (B.z - A.z) / LAMBDA;
      const u = Math.sin(H) * bx + Math.cos(H) * by;
      const v = -Math.sin(d) * Math.cos(H) * bx + Math.sin(d) * Math.sin(H) * by + Math.cos(d) * bz;
      const [re, im] = visibility(u, v);
      uv.push({ u, v, re, im }); uv.push({ u: -u, v: -v, re, im: -im });
      fringes.add(A.name); fringes.add(B.name);
    }
    dataPB += 0.0004 * uv.length;
  }

  function reconstruct() {
    // "dirty image": inverse transform of the sampled visibilities
    const out = new Float32Array(NIMG * NIMG);
    const step = Math.max(1, Math.floor(uv.length / 500));
    for (let iy = 0; iy < NIMG; iy++) for (let ix = 0; ix < NIMG; ix++) {
      const x = ((ix + 0.5) / NIMG - 0.5) * FOV * MUAS, y = (0.5 - (iy + 0.5) / NIMG) * FOV * MUAS;
      let s = 0;
      for (let k = 0; k < uv.length; k += step) {
        const p = uv[k], ph = 2 * Math.PI * (p.u * x + p.v * y);
        const wt = Math.exp(-0.5 * ((p.u * p.u + p.v * p.v) / (5.5e9 * 5.5e9)));   // Gaussian taper: fewer sidelobes
        s += wt * (p.re * Math.cos(ph) - p.im * Math.sin(ph));
      }
      out[iy * NIMG + ix] = s;
    }
    let mx = 1e-9;
    for (const v of out) mx = Math.max(mx, v);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, out[i] / mx);
    return out;
  }

  let acc = 0;
  function tick(dt) {
    if (ha < 6) {
      acc += dt;
      while (acc > 0.35 && ha < 6) { acc -= 0.35; ha += 0.15; addSamples(); }
      sinceRecon += dt;
      if (sinceRecon > 0.8 && uv.length) { sinceRecon = 0; recon = reconstruct(); }
    } else {
      cleanPhase += dt / 8;                 // "imaging": iterate from the dirty image to the final one
      if (cleanPhase > 1.6) nextTarget();
    }
  }

  // afmhot-style colour map
  function hot(t) { t = Math.max(0, Math.min(1, t)); return [Math.min(255, 255 * 2 * t), Math.max(0, Math.min(255, 255 * (2 * t - 0.5))), Math.max(0, Math.min(255, 255 * (2 * t - 1)))]; }
  const tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');

  function drawGlobe(x0, y0, r) {
    const rot = (ha * 15) * DEG;       // the Earth turns under the source
    ctx.fillStyle = '#071230'; ctx.beginPath(); ctx.arc(x0, y0, r, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,220,0.35)'; ctx.lineWidth = 1;
    const tilt = 0.4;
    const P = (lat, lon) => {
      const la = lat * DEG, lo = lon * DEG + rot;
      const X = Math.cos(la) * Math.sin(lo), Y = Math.sin(la), Z = Math.cos(la) * Math.cos(lo);
      const Y2 = Y * Math.cos(tilt) - Z * Math.sin(tilt), Z2 = Y * Math.sin(tilt) + Z * Math.cos(tilt);
      return [x0 + X * r, y0 - Y2 * r, Z2];
    };
    for (let lon = -180; lon < 180; lon += 30) { ctx.beginPath(); let first = true; for (let lat = -90; lat <= 90; lat += 5) { const [x, y, z] = P(lat, lon); if (z < 0) { first = true; continue; } first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false; } ctx.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { ctx.beginPath(); let first = true; for (let lon = -180; lon <= 180; lon += 5) { const [x, y, z] = P(lat, lon); if (z < 0) { first = true; continue; } first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false; } ctx.stroke(); }
    // baselines between stations that currently see the source
    const vis = STATIONS.filter((s) => elevation(s, ha, tg.dec) >= 12);
    ctx.strokeStyle = 'rgba(53,222,167,0.5)';
    for (let a = 0; a < vis.length; a++) for (let b = a + 1; b < vis.length; b++) {
      const [x1, y1, z1] = P(vis[a].lat, vis[a].lon), [x2, y2, z2] = P(vis[b].lat, vis[b].lon);
      if (z1 < 0 || z2 < 0) continue;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    for (const s of STATIONS) {
      const [x, y, z] = P(s.lat, s.lon);
      if (z < 0) continue;
      const on = elevation(s, ha, tg.dec) >= 12;
      ctx.fillStyle = on ? colors.GREEN : '#555'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
      if (s.name !== 'APEX' && s.name !== 'SMA') text(s.name, x + 8, y - 6, 13, on ? '#fff' : '#777');
    }
    ctx.strokeStyle = colors.PURPLE; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x0, y0, r, 0, 2 * Math.PI); ctx.stroke();
  }

  function draw() {
    R.header('BLACK HOLE', 'IMAGING', [R.utc(Date.now()), `Earth-sized array · 230 GHz (1.3 mm) · target ${tg.name}`]);

    R.panel(20, 104, 470, 480, 'Array');
    drawGlobe(255, 360, 190);

    R.panel(510, 104, 470, 480, '(u,v) coverage');
    {
      const cx = 745, cy = 360, sc = 190 / 9e9;     // 9 billion wavelengths to the edge
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
      for (const g of [3e9, 6e9, 9e9]) { ctx.beginPath(); ctx.arc(cx, cy, g * sc, 0, 2 * Math.PI); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx - 200, cy); ctx.lineTo(cx + 200, cy); ctx.moveTo(cx, cy - 200); ctx.lineTo(cx, cy + 200); ctx.stroke();
      ctx.fillStyle = colors.GREEN;
      for (const p of uv) ctx.fillRect(cx + p.u * sc - 1.5, cy - p.v * sc - 1.5, 3, 3);
      text('u, v in billions of wavelengths (Gλ)', cx, 572, 14, '#bbb', 'center');
    }

    R.panel(1000, 104, 480, 480, 'Image');
    {
      const t = Math.min(1, cleanPhase);
      tmp.width = NIMG; tmp.height = NIMG;
      const im = tctx.createImageData(NIMG, NIMG);
      let mx = 1e-9;
      for (const v of model) mx = Math.max(mx, v);
      for (let i = 0; i < NIMG * NIMG; i++) {
        const v = recon[i] * (1 - t) + (model[i] / mx) * t;
        const [r, g, b] = hot(v);
        im.data[4 * i] = r; im.data[4 * i + 1] = g; im.data[4 * i + 2] = b; im.data[4 * i + 3] = 255;
      }
      tctx.putImageData(im, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tmp, 1040, 150, 400, 400);
      ctx.strokeStyle = '#7f7f7f'; ctx.lineWidth = 1; ctx.strokeRect(1040, 150, 400, 400);
      // 40 micro-arcsecond scale bar
      const bar = 40 / FOV * 400;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(1060, 530); ctx.lineTo(1060 + bar, 530); ctx.stroke();
      text('40 μas', 1060 + bar / 2, 522, 14, '#fff', 'center');
      text(ha < 6 ? 'dirty image (from the samples so far)' : 'imaging — deconvolving', 1240, 572, 14, '#bbb', 'center');
    }

    R.panel(20, 600, 960, 270, 'Visibility amplitude vs baseline length');
    {
      const x0 = 70, y0 = 650, w = 880, h = 170;
      ctx.strokeStyle = '#7f7f7f'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, w, h);
      let mx = 1e-9;
      for (const p of uv) mx = Math.max(mx, Math.hypot(p.re, p.im));
      ctx.fillStyle = colors.RED;
      for (const p of uv) {
        const r = Math.hypot(p.u, p.v);
        ctx.fillRect(x0 + r / 9e9 * w - 1, y0 + h - Math.hypot(p.re, p.im) / mx * (h - 6) - 1, 2.5, 2.5);
      }
      for (const g of [0, 3, 6, 9]) text(`${g} Gλ`, x0 + g / 9 * w, y0 + h + 18, 14, '#bbb', 'center');
      if (tg.model === 'ring') text('the dips are the signature of a ring: their spacing gives its diameter', x0 + w - 8, y0 + 20, 14, '#ccc', 'right');
    }

    R.panel(1000, 600, 480, 270, tg.name);
    {
      const parts = tg.kind.split(' \u00b7 ');
      const lines = [
        [parts[0], '#ccc'],
        [parts.slice(1).join(' \u00b7 '), '#ccc'],
        [`RA ${(tg.ra / 15).toFixed(3)} h   Dec ${tg.dec >= 0 ? '+' : ''}${tg.dec.toFixed(3)}°`, '#fff'],
        [`hour angle ${ha >= 0 ? '+' : ''}${ha.toFixed(1)} h   stations with fringes: ${fringes.size}`, '#fff'],
        [`visibilities: ${(uv.length / 2).toLocaleString()}   recorded: ${dataPB.toFixed(2)} PB`, '#fff'],
        [ha < 6 ? 'observing — Earth rotation synthesis' : (tg.model === 'ring' ? `ring diameter ≈ ${tg.d} μas: shadow of the event horizon` : 'core and jet knots resolved'), colors.GREEN],
      ];
      lines.forEach(([s, c], i) => text(s, 1022, 664 + i * 34, 17, c));
    }
    R.simulatedTag();
  }

  nextTarget();
  for (let i = 0; i < 20; i++) { ha += 0.15; addSamples(); }
  recon = reconstruct();
  R.register({ id: 'blackhole', title: 'Black Hole Imaging', tick, draw });
})();
