/*
 * Hydrogen Line Observatory — part of Retro SETI.
 *
 * Turns a backyard dish + RTL-SDR into a hydrogen-line radio telescope, or simulates one
 * ("demo sky") so you can see what a survey would produce before buying any hardware.
 *
 * Pipeline (same for real recordings and the demo):
 *   power spectrum -> velocity axis (Doppler, relative to 1420.40575 MHz)
 *   -> flatten the receiver's bandpass (polynomial fit outside the hydrogen band)
 *   -> correct for Earth's orbit and the Sun's motion (LSR velocity)
 *   -> sky position from time + location + pointing (RA/Dec, galactic l/b)
 * Products: waterfall, sky map, longitude-velocity diagram, rotation curve and a
 * face-on map of the Milky Way from kinematic distances.
 *
 * Everything runs locally. Real observations are stored in IndexedDB in this browser.
 */
(() => {
  'use strict';

  // ---------- physical constants & velocity grid ----------
  const F0 = 1420.405751e6;          // hydrogen line rest frequency (Hz)
  const C_KMS = 299792.458;
  const R0 = 8.5, V0 = 220;          // IAU Sun-centre distance (kpc) and rotation speed (km/s)
  const VMIN = -250, VMAX = 250, DV = 2;
  const NV = Math.round((VMAX - VMIN) / DV) + 1;
  const vAt = (i) => VMIN + i * DV;
  const DEG = Math.PI / 180;
  const LAMBDA = C_KMS * 1000 / F0;  // 0.211 m

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const ui = {
    source: $('source'), speed: $('speed'), survey: $('survey'), run: $('run'), lat: $('lat'), lon: $('lon'),
    geo: $('geo'), dish: $('dish'), el: $('el'), az: $('az'), file: $('file'), fs: $('fs'), fc: $('fc'),
    t0: $('t0'), tint: $('tint'), process: $('process'), status: $('status'), plan: $('plan'),
  };
  const cv = { spec: $('cSpec'), fall: $('cFall'), sky: $('cSky'), lv: $('cLV'), rot: $('cRot'), map: $('cMap') };

  // ---------- settings persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('retroseti.hline.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('retroseti.hline.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  for (const k of ['lat', 'lon', 'dish', 'el', 'az', 'fs', 'fc', 'tint']) {
    const v = store.get(k, null);
    if (v !== null) ui[k].value = v;
    ui[k].addEventListener('change', () => { store.set(k, ui[k].value); refreshPlan(); dirty = true; });
  }
  const num = (el, d) => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : d; };
  const site = () => ({ lat: num(ui.lat, 40), lon: num(ui.lon, -105) });
  const beamDeg = () => 70 * LAMBDA / Math.max(0.3, num(ui.dish, 1.2));

  // ---------- astronomy ----------
  const jdOf = (t) => t / 86400000 + 2440587.5;
  function lstHours(t, lonDeg) {
    const d = jdOf(t) - 2451545.0;
    let g = 18.697374558 + 24.06570982441908 * d + lonDeg / 15;
    g %= 24; if (g < 0) g += 24;
    return g;
  }
  function azElToRaDec(azDeg, elDeg, latDeg, lstH) {
    const az = azDeg * DEG, el = elDeg * DEG, lat = latDeg * DEG;
    const sinDec = Math.sin(el) * Math.sin(lat) + Math.cos(el) * Math.cos(lat) * Math.cos(az);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const H = Math.atan2(-Math.sin(az) * Math.cos(el), Math.sin(el) * Math.cos(lat) - Math.cos(el) * Math.sin(lat) * Math.cos(az));
    let ra = lstH * 15 - H / DEG;
    ra = ((ra % 360) + 360) % 360;
    return { ra, dec: dec / DEG };
  }
  // J2000 equatorial <-> galactic
  const NGP_RA = 192.85948 * DEG, NGP_DEC = 27.12825 * DEG, L_NCP = 122.93192 * DEG;
  function eqToGal(raDeg, decDeg) {
    const a = raDeg * DEG, d = decDeg * DEG;
    const sb = Math.sin(d) * Math.sin(NGP_DEC) + Math.cos(d) * Math.cos(NGP_DEC) * Math.cos(a - NGP_RA);
    const b = Math.asin(Math.max(-1, Math.min(1, sb)));
    const y = Math.cos(d) * Math.sin(a - NGP_RA);
    const x = Math.sin(d) * Math.cos(NGP_DEC) - Math.cos(d) * Math.sin(NGP_DEC) * Math.cos(a - NGP_RA);
    let l = L_NCP - Math.atan2(y, x);
    l = ((l / DEG) % 360 + 360) % 360;
    return { l, b: b / DEG };
  }
  function galToEq(lDeg, bDeg) {
    const l = lDeg * DEG, b = bDeg * DEG;
    const sd = Math.sin(b) * Math.sin(NGP_DEC) + Math.cos(b) * Math.cos(NGP_DEC) * Math.cos(L_NCP - l);
    const d = Math.asin(Math.max(-1, Math.min(1, sd)));
    const y = Math.cos(b) * Math.sin(L_NCP - l);
    const x = Math.sin(b) * Math.cos(NGP_DEC) - Math.cos(b) * Math.sin(NGP_DEC) * Math.cos(L_NCP - l);
    let a = NGP_RA + Math.atan2(y, x);
    a = ((a / DEG) % 360 + 360) % 360;
    return { ra: a, dec: d / DEG };
  }
  // Velocity of the observer towards (ra, dec), relative to the Local Standard of Rest (km/s):
  // Earth's orbit around the Sun plus the Sun's 20 km/s motion towards RA 18h, Dec +30.
  // v_LSR(source) = v_measured + vObserver.
  function observerVelocity(t, raDeg, decDeg) {
    const n = jdOf(t) - 2451545.0;
    const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * DEG;
    const lamSun = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = 23.4393 * DEG;
    const a = raDeg * DEG, d = decDeg * DEG;
    const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
    const ye = y * Math.cos(eps) + z * Math.sin(eps);         // pointing in ecliptic coordinates
    const dirE = lamSun - Math.PI / 2;                         // Earth moves towards (sun longitude - 90)
    const vEarth = 29.78 * (Math.cos(dirE) * x + Math.sin(dirE) * ye);
    const aa = 270.958 * DEG, ad = 30.0 * DEG;                // solar apex (J2000)
    const vSun = 20.0 * (Math.cos(ad) * Math.cos(aa) * x + Math.cos(ad) * Math.sin(aa) * y + Math.sin(ad) * z);
    return vEarth + vSun;
  }
  function pointing(t, az, el) {
    const s = site();
    const lst = lstHours(t, s.lon);
    const eq = azElToRaDec(az, el, s.lat, lst);
    const gal = eqToGal(eq.ra, eq.dec);
    return { lst, ra: eq.ra, dec: eq.dec, l: gal.l, b: gal.b };
  }

  // ---------- spectrum processing (shared by real data and the demo) ----------
  // Least-squares polynomial (order 2) fit of y over the bins in `use`, evaluated at every bin.
  function polyBaseline(y, use) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
    for (let i = 0; i < NV; i++) {
      if (!use[i] || !Number.isFinite(y[i])) continue;
      const x = vAt(i) / 250, x2 = x * x;
      s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
      t0 += y[i]; t1 += x * y[i]; t2 += x2 * y[i];
    }
    // solve the 3x3 normal equations (Cramer)
    const det = (a) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    const M = [s0, s1, s2, s1, s2, s3, s2, s3, s4], D = det(M) || 1;
    const c0 = det([t0, s1, s2, t1, s2, s3, t2, s3, s4]) / D;
    const c1 = det([s0, t0, s2, s1, t1, s3, s2, t2, s4]) / D;
    const c2 = det([s0, s1, t0, s1, s2, t1, s2, s3, t2]) / D;
    const out = new Float32Array(NV);
    for (let i = 0; i < NV; i++) { const x = vAt(i) / 250; out[i] = c0 + c1 * x + c2 * x * x; }
    return out;
  }
  const BASE_USE = Array.from({ length: NV }, (_, i) => { const a = Math.abs(vAt(i)); return a >= 160 && a <= 236; });

  // measured spectrum on the (topocentric) velocity grid -> excess over the bandpass, in the LSR frame
  // Remove narrow interference spikes: anything far above the median of its neighbours
  // (real hydrogen features are tens of km/s wide; man-made carriers are a bin or two).
  function despike(y) {
    const out = Float32Array.from(y), w = 4, tmp = [];
    for (let i = 0; i < NV; i++) {
      tmp.length = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(NV - 1, i + w); j++) if (j !== i && Number.isFinite(y[j])) tmp.push(y[j]);
      if (tmp.length < 3) continue;
      tmp.sort((a, b) => a - b);
      const med = tmp[tmp.length >> 1];
      if (y[i] > med * 1.012) out[i] = med;
    }
    return out;
  }

  function finishSpectrum(measuredRaw, vObs) {
    const measured = despike(measuredRaw);
    const base = polyBaseline(measured, BASE_USE);
    const ex = new Float32Array(NV);
    for (let i = 0; i < NV; i++) ex[i] = base[i] > 0 ? measured[i] / base[i] - 1 : 0;
    // shift to LSR: v_lsr = v_meas + vObs, so excess_lsr(v) = excess_meas(v - vObs)
    const out = new Float32Array(NV);
    for (let i = 0; i < NV; i++) {
      const p = (vAt(i) - vObs - VMIN) / DV, k = Math.floor(p), f = p - k;
      out[i] = (k >= 0 && k + 1 < NV) ? ex[k] * (1 - f) + ex[k + 1] * f : 0;
    }
    return out;
  }

  function makeRecord(t, az, el, spec, src) {
    const p = pointing(t, az, el);
    let integ = 0;
    for (let i = 0; i < NV; i++) if (Math.abs(vAt(i)) < 200 && spec[i] > 0) integ += spec[i] * DV;
    return { t, az, el, ra: p.ra, dec: p.dec, l: p.l, b: p.b, lst: p.lst, integ, spec, src };
  }

  // ---------- demo sky: a simple model of the Milky Way's hydrogen ----------
  // Optically thin-ish HI disk with a central hole, flaring, four log-spiral arms (pitch 12 deg)
  // and a flat rotation curve; brightness T_B = Ts (1 - e^-tau), seen through the dish beam.
  const ARMS = [0, 1, 2, 3].map((k) => ({ r0: 4.0, th0: k * Math.PI / 2 + 0.35, k: Math.tan(12 * DEG) }));
  const vRot = (R) => (R < 2 ? V0 * R / 2 : V0);
  function gasDensity(x, y, z) {
    const R = Math.hypot(x, y);
    if (R > 22) return 0;
    const hole = R < 3 ? 0.12 + 0.88 * (R / 3) ** 3 : 1;
    const h = 0.12 * Math.exp((R - R0) / 8);                 // flaring disk scale height (kpc)
    const vert = Math.exp(-0.5 * (z / h) ** 2);
    let arms = 0;
    const th = Math.atan2(x, y);
    for (const a of ARMS) {
      let d = Math.log(R / a.r0) / a.k - (th - a.th0);
      d = ((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      const dist = Math.abs(R * a.k * d);
      arms += Math.exp(-0.5 * (dist / 0.45) ** 2);
    }
    const radial = Math.exp(-Math.abs(R - 10) / 9);
    return hole * vert * radial * (0.35 + 1.4 * arms);
  }
  const SIG_STEPS = 10;
  const GAUSS = Array.from({ length: 2 * SIG_STEPS + 1 }, (_, j) => Math.exp(-0.5 * ((j - SIG_STEPS) * DV / 7) ** 2));
  function modelTB(lDeg, bDeg) {
    const tau = new Float32Array(NV);
    const l = lDeg * DEG, b = bDeg * DEG, cb = Math.cos(b), sb = Math.sin(b), sl = Math.sin(l), cl = Math.cos(l);
    const ds = 0.1;
    for (let s = ds / 2; s < 24; s += ds) {
      const x = s * cb * sl, y = R0 - s * cb * cl, z = s * sb;
      const n = gasDensity(x, y, z);
      if (n < 1e-4) continue;
      const R = Math.hypot(x, y);
      const vr = (vRot(R) * R0 / R - V0) * sl * cb;
      const c = (vr - VMIN) / DV, k0 = Math.round(c);
      for (let j = -SIG_STEPS; j <= SIG_STEPS; j++) {
        const k = k0 + j;
        if (k >= 0 && k < NV) tau[k] += 0.06 * n * ds * GAUSS[j + SIG_STEPS];
      }
    }
    const tb = new Float32Array(NV);
    for (let i = 0; i < NV; i++) tb[i] = 100 * (1 - Math.exp(-tau[i] * 5));
    return tb;
  }
  const RFI_FIXED = 118;   // a steady interferer at a fixed (measured) velocity, as real sites have
  function demoSpectrum(t, az, el) {
    const p = pointing(t, az, el);
    const bw = beamDeg();
    // beam: centre plus six points around it
    const ta = new Float32Array(NV);
    const pts = [[0, 0]];
    for (let k = 0; k < 6; k++) pts.push([Math.cos(k * Math.PI / 3) * bw / 3, Math.sin(k * Math.PI / 3) * bw / 3]);
    for (const [dl, db] of pts) {
      const tb = modelTB(p.l + dl / Math.max(0.2, Math.cos(p.b * DEG)), p.b + db);
      for (let i = 0; i < NV; i++) ta[i] += 0.5 * tb[i] / pts.length;      // aperture efficiency 0.5
    }
    const tsys = 140, vObs = observerVelocity(t, p.ra, p.dec);
    const meas = new Float32Array(NV);
    for (let i = 0; i < NV; i++) {
      const vm = vAt(i);
      // what the receiver sees: sky shifted into the measured frame, times a bandpass, plus noise
      const pl = (vm + vObs - VMIN) / DV, k = Math.floor(pl), f = pl - k;
      const line = (k >= 0 && k + 1 < NV) ? ta[k] * (1 - f) + ta[k + 1] * f : 0;
      const bandpass = 1 + 0.12 * Math.cos(vm / 250 * 1.3) + 0.04 * vm / 250;
      let rfi = Math.abs(vm - RFI_FIXED) < 1.5 ? 0.04 : 0;
      if (Math.random() < 0.002) rfi += 0.3 * Math.random();
      meas[i] = bandpass * (1 + line / tsys + rfi) * (1 + 0.004 * gauss());
    }
    return finishSpectrum(meas, vObs);
  }
  function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ---------- survey planning ----------
  // Pointing along the meridian: south of zenith for Dec < latitude, north above it.
  function meridianFor(dec) {
    const lat = site().lat;
    return dec <= lat ? { az: 180, el: 90 - (lat - dec) } : { az: 0, el: 90 - (dec - lat) };
  }
  function surveyDecs() {
    const lat = site().lat, out = [];
    const step = Math.max(2, Math.min(10, Math.round(beamDeg() * 0.6)));
    for (let d = Math.ceil((lat - 65) / step) * step; d <= Math.min(85, lat + 65); d += step) {
      if (meridianFor(d).el >= 20) out.push(d);
    }
    // start overhead, then work outwards either side
    const lat0 = out.reduce((best, d) => (Math.abs(d - lat) < Math.abs(best - lat) ? d : best), out[0]);
    return out.sort((a, b) => Math.abs(a - lat0) - Math.abs(b - lat0) || a - b);
  }

  // ---------- data sets ----------
  const demoData = [];
  let realData = [];
  const data = () => (ui.source.value === 'demo' ? demoData : realData);

  // IndexedDB for real observations
  let db = null;
  function openDb() {
    return new Promise((res) => {
      try {
        const rq = indexedDB.open('retroseti-hline', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('obs', { autoIncrement: true });
        rq.onsuccess = () => { db = rq.result; res(); };
        rq.onerror = () => res();
      } catch (e) { res(); }
    });
  }
  function saveRecords(recs) {
    if (!db) return;
    const tx = db.transaction('obs', 'readwrite');
    for (const r of recs) tx.objectStore('obs').add({ ...r, spec: Array.from(r.spec) });
  }
  function loadRecords() {
    return new Promise((res) => {
      if (!db) return res([]);
      const out = [], rq = db.transaction('obs').objectStore('obs').openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { const r = c.value; r.spec = Float32Array.from(r.spec); out.push(r); c.continue(); } else res(out); };
      rq.onerror = () => res(out);
    });
  }
  function clearRecords() { if (db) db.transaction('obs', 'readwrite').objectStore('obs').clear(); }

  // ---------- demo runner ----------
  let running = false, simT = Date.now(), surveyStart = simT, lastRec = 0;
  let curAz = num(ui.az, 180), curEl = num(ui.el, 90);
  ui.run.addEventListener('click', () => {
    running = !running;
    ui.run.textContent = running ? 'Pause' : 'Start';
    if (running && demoData.length === 0) { simT = Date.now(); surveyStart = simT; lastRec = 0; }
  });
  function demoTick(dtReal) {
    if (!running) return;
    const speed = +ui.speed.value;
    const recEvery = Math.min(600, Math.max(120, speed * 0.25));
    const end = simT + dtReal * speed * 1000;
    let added = 0;
    while (simT < end && added < 200) {
      const next = Math.max(simT, lastRec + recEvery * 1000);
      if (next > end) { simT = end; break; }
      simT = next; lastRec = simT;
      if (ui.survey.value === 'on') {
        const decs = surveyDecs(), day = Math.floor((simT - surveyStart) / 86164091);
        const m = meridianFor(decs[day % decs.length]);
        curAz = m.az; curEl = m.el;
      } else { curAz = num(ui.az, 180); curEl = num(ui.el, 90); }
      demoData.push(makeRecord(simT, curAz, curEl, demoSpectrum(simT, curAz, curEl), 'demo'));
      added++;
    }
    if (added) dirty = true;
  }

  // ---------- processing a real recording (rtl_sdr .cu8: unsigned 8-bit I/Q pairs) ----------
  const NFFT = 1024;
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  const HANN = Float32Array.from({ length: NFFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));

  let processing = false;
  ui.process.addEventListener('click', async () => {
    const f = ui.file.files && ui.file.files[0];
    if (!f) { alert('Choose a recording first.'); return; }
    if (processing) return;
    processing = true; ui.process.disabled = true;
    const fs = num(ui.fs, 2.4e6), fc = num(ui.fc, F0), tint = Math.max(5, num(ui.tint, 60));
    const startT = ui.t0.value ? new Date(ui.t0.value).getTime() : f.lastModified - (f.size / 2 / fs) * 1000;
    const az = num(ui.az, 180), el = num(ui.el, 90);
    const perRec = Math.round(tint * fs / NFFT);       // FFTs per integration
    const acc = new Float64Array(NFFT), re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    let nAcc = 0, recStartSample = 0, sample = 0, carry = new Uint8Array(0);
    const fresh = [];
    const chunk = 1 << 22;
    for (let pos = 0; pos < f.size; pos += chunk) {
      const buf = new Uint8Array(await f.slice(pos, Math.min(f.size, pos + chunk)).arrayBuffer());
      const all = new Uint8Array(carry.length + buf.length); all.set(carry); all.set(buf, carry.length);
      const block = NFFT * 2;
      let o = 0;
      for (; o + block <= all.length; o += block) {
        for (let i = 0; i < NFFT; i++) { re[i] = (all[o + 2 * i] - 127.5) / 127.5 * HANN[i]; im[i] = (all[o + 2 * i + 1] - 127.5) / 127.5 * HANN[i]; }
        fftInPlace(re, im);
        for (let i = 0; i < NFFT; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
        nAcc++; sample += NFFT;
        if (nAcc >= perRec) {
          const tMid = startT + ((recStartSample + sample) / 2) / fs * 1000;
          fresh.push(spectrumToRecord(acc, nAcc, fs, fc, tMid, az, el));
          acc.fill(0); nAcc = 0; recStartSample = sample;
        }
      }
      carry = all.slice(o);
      setStatusExtra(`Processing recording: ${(100 * Math.min(1, (pos + chunk) / f.size)).toFixed(0)}%  (${fresh.length} spectra)`);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (nAcc > perRec / 4) fresh.push(spectrumToRecord(acc, nAcc, fs, fc, startT + ((recStartSample + sample) / 2) / fs * 1000, az, el));
    realData = realData.concat(fresh);
    saveRecords(fresh);
    setStatusExtra(`Added ${fresh.length} spectra from ${f.name}.`);
    processing = false; ui.process.disabled = false; dirty = true;
  });

  function spectrumToRecord(acc, n, fs, fc, t, az, el) {
    const p = new Float64Array(NFFT);
    for (let k = 0; k < NFFT; k++) p[k] = acc[k] / n;
    // the RTL-SDR's DC spike sits in the centre bins: patch it from the neighbours
    p[0] = p[1] = p[NFFT - 1] = (p[2] + p[NFFT - 2]) / 2;
    const meas = new Float32Array(NV);
    const binHz = fs / NFFT;
    for (let i = 0; i < NV; i++) {
      const fHz = F0 * (1 - vAt(i) / C_KMS);
      let b = (fHz - fc) / binHz;                       // signed bin offset from the centre
      if (Math.abs(b) > NFFT * 0.45) { meas[i] = NaN; continue; }
      if (b < 0) b += NFFT;
      const k = Math.floor(b), fr = b - k;
      meas[i] = p[k % NFFT] * (1 - fr) + p[(k + 1) % NFFT] * fr;
    }
    const pt = pointing(t, az, el);
    const spec = finishSpectrum(meas, observerVelocity(t, pt.ra, pt.dec));
    for (let i = 0; i < NV; i++) if (!Number.isFinite(spec[i])) spec[i] = 0;
    return makeRecord(t, az, el, spec, 'file');
  }

  // ---------- drawing helpers ----------
  function cmap(t) {
    // black -> deep blue -> purple -> red -> orange -> yellow -> white
    const stops = [[0, 0, 0, 0], [0.18, 20, 10, 120], [0.38, 120, 40, 200], [0.58, 230, 40, 70], [0.76, 255, 140, 20], [0.9, 255, 230, 60], [1, 255, 255, 255]];
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i], f = (t - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
      }
    }
    return [255, 255, 255];
  }
  function frame(c, opts) {
    const g = c.getContext('2d'), W = c.width, H = c.height;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const m = { l: 70, r: 18, t: 14, b: 50, ...opts };
    return { g, W, H, x0: m.l, y0: m.t, w: W - m.l - m.r, h: H - m.t - m.b };
  }
  function axes(f, xr, yr, xlab, ylab, xt, yt) {
    const { g, x0, y0, w, h } = f;
    g.strokeStyle = '#7f7f7f'; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
    g.fillStyle = '#ddd'; g.font = '16px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of xt) { const x = x0 + (v - xr[0]) / (xr[1] - xr[0]) * w; g.fillText(String(v), x, y0 + h + 6); g.fillStyle = '#333'; g.fillRect(x, y0, 1, h); g.fillStyle = '#ddd'; }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of yt) { const y = y0 + h - (v - yr[0]) / (yr[1] - yr[0]) * h; g.fillText(String(v), x0 - 6, y); g.fillStyle = '#333'; g.fillRect(x0, y, w, 1); g.fillStyle = '#ddd'; }
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
    g.fillText(xlab, x0 + w / 2, y0 + h + 44);
    g.save(); g.translate(18, y0 + h / 2); g.rotate(-Math.PI / 2); g.fillText(ylab, 0, 0); g.restore();
  }
  function empty(f, msg) {
    f.g.fillStyle = '#888'; f.g.font = '18px Arial, sans-serif'; f.g.textAlign = 'center'; f.g.textBaseline = 'middle';
    f.g.fillText(msg, f.x0 + f.w / 2, f.y0 + f.h / 2);
  }
  function heat(f, grid, nx, ny, vmax) {
    const img = f.g.createImageData(nx, ny);
    for (let i = 0; i < nx * ny; i++) {
      const v = grid[i];
      const [r, g, b] = Number.isNaN(v) ? [0, 0, 0] : cmap(Math.sqrt(Math.max(0, v) / vmax));
      img.data[4 * i] = r; img.data[4 * i + 1] = g; img.data[4 * i + 2] = b; img.data[4 * i + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = nx; tmp.height = ny;
    tmp.getContext('2d').putImageData(img, 0, 0);
    f.g.imageSmoothingEnabled = false;
    f.g.drawImage(tmp, f.x0, f.y0, f.w, f.h);
  }

  // ---------- panels ----------
  function drawSpectrum(D) {
    const f = frame(cv.spec);
    const last = D[D.length - 1];
    let ymax = 5;
    if (last) for (let i = 0; i < NV; i++) ymax = Math.max(ymax, last.spec[i] * 100 * 1.15);
    ymax = Math.ceil(ymax / 5) * 5;
    const ymin = -Math.max(2, ymax * 0.15);
    axes(f, [VMIN, VMAX], [ymin, ymax], 'Velocity relative to the Local Standard of Rest (km/s)', 'Hydrogen excess (%)',
      [-200, -100, 0, 100, 200], niceTicks(ymin, ymax));
    if (!last) return empty(f, 'No data yet');
    const { g, x0, y0, w, h } = f;
    g.strokeStyle = '#ff0000'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < NV; i++) {
      const x = x0 + i / (NV - 1) * w, y = y0 + h - (last.spec[i] * 100 - ymin) / (ymax - ymin) * h;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = '#35dea7'; g.font = '15px Arial, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(`${new Date(last.t).toUTCString().slice(5, 25)} UTC   l = ${last.l.toFixed(1)}°  b = ${last.b.toFixed(1)}°`, x0 + 8, y0 + 6);
  }

  function drawWaterfall(D) {
    const f = frame(cv.fall);
    const now = D.length ? D[D.length - 1].t : Date.now();
    const recent = D.filter((r) => r.t > now - 86400000);
    axes(f, [VMIN, VMAX], [0, 24], 'Velocity (km/s)', 'Hours ago', [-200, -100, 0, 100, 200], [0, 6, 12, 18, 24]);
    if (!recent.length) return empty(f, 'No data yet');
    const ny = 144, grid = new Float32Array(NV * ny).fill(NaN), cnt = new Uint16Array(NV * ny);
    let vmax = 0.02;
    for (const r of recent) {
      const row = Math.min(ny - 1, Math.floor((now - r.t) / 86400000 * ny));
      for (let i = 0; i < NV; i++) {
        const k = (ny - 1 - row) * NV + i;      // newest at the top: flip rows so "0 h ago" is at the top
        grid[k] = (Number.isNaN(grid[k]) ? 0 : grid[k]) + r.spec[i]; cnt[k]++;
      }
    }
    for (let k = 0; k < grid.length; k++) if (cnt[k]) { grid[k] /= cnt[k]; vmax = Math.max(vmax, grid[k]); }
    // draw with "hours ago" increasing downwards
    const flipped = new Float32Array(NV * ny);
    for (let row = 0; row < ny; row++) for (let i = 0; i < NV; i++) flipped[row * NV + i] = grid[(ny - 1 - row) * NV + i];
    heat(f, flipped, NV, ny, vmax);
    axesOverlay(f);
  }
  function axesOverlay(f) { f.g.strokeStyle = '#7f7f7f'; f.g.strokeRect(f.x0 + 0.5, f.y0 + 0.5, f.w, f.h); }

  function drawSky(D) {
    const f = frame(cv.sky);
    const nx = 96, ny = 72, sum = new Float32Array(nx * ny), cnt = new Uint16Array(nx * ny);
    for (const r of D) {
      const ix = Math.min(nx - 1, Math.floor((360 - r.ra) / 360 * nx)), iy = Math.min(ny - 1, Math.floor((90 - r.dec) / 180 * ny));
      sum[iy * nx + ix] += r.integ; cnt[iy * nx + ix]++;
    }
    const grid = new Float32Array(nx * ny).fill(NaN);
    let vmax = 1;
    for (let k = 0; k < grid.length; k++) if (cnt[k]) { grid[k] = sum[k] / cnt[k]; vmax = Math.max(vmax, grid[k]); }
    heat(f, grid, nx, ny, vmax);
    axes(f, [24, 0], [-90, 90], 'Right ascension (hours)', 'Declination (°)', [24, 18, 12, 6, 0], [-60, -30, 0, 30, 60]);
    // galactic plane overlay
    const { g, x0, y0, w, h } = f;
    g.fillStyle = 'rgba(53,222,167,0.8)';
    for (let l = 0; l < 360; l += 1) {
      const e = galToEq(l, 0);
      g.fillRect(x0 + (360 - e.ra) / 360 * w, y0 + (90 - e.dec) / 180 * h, 2, 2);
    }
    g.fillStyle = '#35dea7'; g.font = '14px Arial, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('dots: the galactic plane', x0 + 8, y0 + 6);
    if (!D.length) empty(f, 'No data yet');
  }

  // longitude-velocity grid from observations near the plane
  function lvGrid(D) {
    const nl = 180, grid = new Float32Array(nl * NV), cnt = new Uint16Array(nl);
    for (const r of D) {
      if (Math.abs(r.b) > 5) continue;
      const il = Math.min(nl - 1, Math.floor(r.l / 360 * nl));
      for (let i = 0; i < NV; i++) grid[il * NV + i] += r.spec[i];
      cnt[il]++;
    }
    for (let il = 0; il < nl; il++) if (cnt[il]) for (let i = 0; i < NV; i++) grid[il * NV + i] /= cnt[il];
    return { nl, grid, cnt };
  }

  function drawLV(LV) {
    const f = frame(cv.lv);
    const { nl, grid, cnt } = LV;
    // image: x = longitude 360 -> 0 (left to right, the usual way round), y = velocity
    const img = new Float32Array(nl * NV).fill(NaN);
    let vmax = 0.02;
    for (let il = 0; il < nl; il++) {
      if (!cnt[il]) continue;
      const x = nl - 1 - il;
      for (let i = 0; i < NV; i++) { const v = grid[il * NV + i]; img[(NV - 1 - i) * nl + x] = v; vmax = Math.max(vmax, v); }
    }
    heat(f, img, nl, NV, vmax);
    axes(f, [360, 0], [VMIN, VMAX], 'Galactic longitude (°)', 'Velocity (km/s)', [360, 270, 180, 90, 0], [-200, -100, 0, 100, 200]);
    if (!cnt.some((c) => c)) empty(f, 'Needs observations along the Milky Way (|b| < 5°)');
  }

  // terminal (tangent-point) velocities for 0 < l < 90: the highest velocity with clear emission
  function rotationPoints(LV) {
    const { nl, grid, cnt } = LV, pts = [];
    for (let il = 0; il < nl; il++) {
      const l = (il + 0.5) * 360 / nl;
      if (!cnt[il] || l < 12 || l > 88) continue;
      let peak = 0;
      for (let i = 0; i < NV; i++) peak = Math.max(peak, grid[il * NV + i]);
      if (peak < 0.02) continue;
      // the terminal velocity: highest velocity where emission is still clearly above the noise,
      // requiring a few consecutive channels so a stray spike can't count
      let vt = null;
      const thr = Math.max(peak * 0.2, 0.008);
      for (let i = NV - 1; i >= 3; i--) {
        if ([0, 1, 2, 3].every((j) => grid[il * NV + i - j] > thr)) { vt = vAt(i); break; }
      }
      if (vt === null || vt <= 0) continue;
      pts.push({ R: R0 * Math.sin(l * DEG), V: vt + V0 * Math.sin(l * DEG) });
    }
    return pts;
  }

  function drawRotation(LV) {
    const f = frame(cv.rot);
    axes(f, [0, 10], [0, 300], 'Distance from the galactic centre (kpc)', 'Rotation speed (km/s)', [0, 2, 4, 6, 8, 10], [0, 100, 200, 300]);
    const { g, x0, y0, w, h } = f;
    const X = (R) => x0 + R / 10 * w, Y = (V) => y0 + h - V / 300 * h;
    // expectations: what visible matter alone would give (falling) vs a flat curve
    g.setLineDash([6, 6]); g.strokeStyle = '#888'; g.lineWidth = 2; g.beginPath();
    for (let R = 1.5; R <= 10; R += 0.1) { const V = 300 * Math.sqrt(1.5 / R) * Math.min(1, R / 1.5); R === 1.5 ? g.moveTo(X(R), Y(V)) : g.lineTo(X(R), Y(V)); }
    g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#35dea7'; g.beginPath(); g.moveTo(X(2), Y(220)); g.lineTo(X(10), Y(220)); g.stroke();
    g.font = '14px Arial, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillStyle = '#888'; g.fillText('if only the visible stars and gas pulled (falls off)', X(4.2), Y(150));
    g.fillStyle = '#35dea7'; g.fillText('flat: what is actually measured (dark matter)', X(2.2), Y(226));
    const pts = rotationPoints(LV);
    g.fillStyle = '#ff3a2a';
    for (const p of pts) { g.beginPath(); g.arc(X(p.R), Y(p.V), 4, 0, 2 * Math.PI); g.fill(); }
    if (!pts.length) empty(f, 'Needs observations at galactic longitude 12–88°');
  }

  function drawFaceOn(LV) {
    const f = frame(cv.map, { l: 60, r: 18, t: 14, b: 50 });
    const n = 200, span = 20, grid = new Float32Array(n * n);
    const { nl, grid: lv, cnt } = LV;
    let any = false;
    for (let il = 0; il < nl; il++) {
      if (!cnt[il]) continue;
      const l = (il + 0.5) * 360 / nl, sl = Math.sin(l * DEG), cl = Math.cos(l * DEG);
      if (Math.abs(sl) < 0.17) continue;                   // too close to the centre/anticentre: no distance info
      for (let i = 0; i < NV; i++) {
        const T = lv[il * NV + i];
        if (T < 0.01) continue;
        const v = vAt(i), denom = V0 * sl + v;
        if (Math.abs(denom) < 1) continue;
        const R = R0 * V0 * sl / denom;
        if (R <= 0.5 || R > 22) continue;
        const disc = R * R - R0 * R0 * sl * sl;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc), sols = [R0 * cl + sq, R0 * cl - sq].filter((s) => s > 0 && s < 24);
        for (const s of sols) {
          const x = s * sl, y = R0 - s * cl;
          const ix = Math.floor((x + span) / (2 * span) * n), iy = Math.floor((span - y) / (2 * span) * n);
          if (ix >= 0 && ix < n && iy >= 0 && iy < n) { grid[iy * n + ix] += T / sols.length; any = true; }
        }
      }
    }
    // smooth a little: longitudes are sampled sparsely, which otherwise leaves streaks
    let sm = grid;
    for (let pass = 0; pass < 2; pass++) {
      const o = new Float32Array(n * n);
      for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += sm[(y + dy) * n + x + dx];
        o[y * n + x] = acc / 9;
      }
      sm = o;
    }
    let vmax = 0.02;
    for (const v of sm) vmax = Math.max(vmax, v);
    heat(f, sm, n, n, vmax * 0.7);
    axes(f, [-span, span], [-span, span], 'kpc', 'kpc', [-20, -10, 0, 10, 20], [-20, -10, 0, 10, 20]);
    const { g, x0, y0, w, h } = f;
    const X = (x) => x0 + (x + span) / (2 * span) * w, Y = (y) => y0 + (span - y) / (2 * span) * h;
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
    for (const R of [5, 10, 15]) { g.beginPath(); g.arc(X(0), Y(0), R / (2 * span) * w, 0, 2 * Math.PI); g.stroke(); }
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(0) - 8, Y(0)); g.lineTo(X(0) + 8, Y(0)); g.moveTo(X(0), Y(0) - 8); g.lineTo(X(0), Y(0) + 8); g.stroke();
    star(g, X(0), Y(R0), 9);
    g.fillStyle = '#ddd'; g.font = '14px Arial, sans-serif'; g.textAlign = 'left';
    g.fillText('Sun', X(0) + 12, Y(R0) + 5); g.fillText('centre', X(0) + 12, Y(0) + 5);
    if (!any) empty(f, 'Needs observations along the Milky Way');
  }
  function star(g, x, y, r) {
    g.fillStyle = '#ffd040'; g.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r; g.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
    g.closePath(); g.fill();
  }
  function niceTicks(a, b) {
    const span = b - a, step = span > 60 ? 20 : span > 25 ? 10 : span > 10 ? 5 : 2, out = [];
    for (let v = Math.ceil(a / step) * step; v <= b; v += step) out.push(v);
    return out;
  }

  // ---------- status & plan ----------
  let statusExtra = '';
  function setStatusExtra(s) { statusExtra = s; drawStatus(); }
  function drawStatus() {
    const D = data(), demo = ui.source.value === 'demo';
    const t = demo ? simT : Date.now();
    const az = demo ? curAz : num(ui.az, 180), el = demo ? curEl : num(ui.el, 90);
    const p = pointing(t, az, el);
    const days = D.length ? (D[D.length - 1].t - D[0].t) / 86400000 : 0;
    const cells = new Set(D.map((r) => `${Math.floor(r.ra / 7.5)}:${Math.floor((r.dec + 90) / 5)}`));
    const items = [
      ['Mode', demo ? (running ? 'Demo sky, running' : 'Demo sky, paused') : 'Your recordings'],
      [demo ? 'Simulated time' : 'Now', new Date(t).toUTCString().slice(5, 25) + ' UTC'],
      ['Local sidereal time', fmtHours(p.lst)],
      ['Dish points at', `el ${el.toFixed(0)}°, az ${az.toFixed(0)}°`],
      ['Sky position', `RA ${fmtHours(p.ra / 15)}, Dec ${p.dec.toFixed(1)}°`],
      ['Galactic', `l ${p.l.toFixed(1)}°, b ${p.b.toFixed(1)}°`],
      ['Beam width', `${beamDeg().toFixed(1)}° (${num(ui.dish, 1.2)} m dish)`],
      ['Spectra', `${D.length.toLocaleString()} over ${days.toFixed(1)} days`],
      ['Sky covered', `${(cells.size / (48 * 36) * 100).toFixed(1)}% of the whole sky`],
    ];
    ui.status.innerHTML = items.map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`).join('') + (statusExtra ? `<div class="tag" style="grid-column:1/-1">${statusExtra}</div>` : '');
  }
  const fmtHours = (h) => { h = ((h % 24) + 24) % 24; const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return `${hh}h ${String(mm).padStart(2, '0')}m`; };

  function refreshPlan() {
    const s = site(), bw = beamDeg(), decs = surveyDecs();
    const firstDays = decs.slice(0, 6).map((d, i) => {
      const m = meridianFor(d);
      return `day ${i + 1}: elevation ${m.el.toFixed(0)}° facing ${m.az === 180 ? 'south' : 'north'} (Dec ${d}°)`;
    });
    ui.plan.innerHTML = `
      <ol>
        <li><b>Hardware:</b> dish &rarr; a 1420 MHz feed &rarr; <b>SAWbird+ H1</b> amplifier/filter at the feed (not the GOES version) &rarr; short coax &rarr; RTL-SDR (bias-tee on to power the SAWbird).</li>
        <li><b>First light:</b> point straight up, record for an hour while the Milky Way is overhead, and load it here.
          With a ${num(ui.dish, 1.2)} m dish the beam is about ${bw.toFixed(0)}° wide, so the sky takes roughly ${(bw / 15 * 60).toFixed(0)} minutes to drift through it.</li>
        <li><b>One day:</b> leave it recording for 24 hours at one pointing. You get one strip of sky at Dec ${s.lat.toFixed(0)}° crossing the Milky Way twice.</li>
        <li><b>The map:</b> each day, tilt the dish to the next declination and record another day: ${firstDays.join('; ')}&hellip;
          That is ${decs.length} pointings, so about ${decs.length} days of recording in all (fewer if you only map the band around the Milky Way).</li>
        <li><b>Record with:</b> <code>rtl_sdr -f 1420405751 -s 2400000 -g 40 -T capture.cu8</code> (<code>-T</code> turns the bias-tee on), then load <code>capture.cu8</code> above with the start time.
          An hour is about 17 GB raw, so record in chunks and delete them after processing; the results kept here are tiny (about 1 MB per day of spectra).</li>
      </ol>
      <p class="note">Try the <b>demo sky</b> at "4 hours per second" with "Re-point every day" to watch a ${decs.length}-day survey build up in a couple of minutes.</p>`;
  }

  // ---------- main loop ----------
  let dirty = true, lastDraw = 0, lastT = performance.now();
  function loop(now) {
    const dt = Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    if (ui.source.value === 'demo') demoTick(dt);
    if (dirty && now - lastDraw > 250) {
      dirty = false; lastDraw = now;
      const D = data(), LV = lvGrid(D);
      drawSpectrum(D); drawWaterfall(D); drawSky(D); drawLV(LV); drawRotation(LV); drawFaceOn(LV);
    }
    if (now - lastStatus > 500) { lastStatus = now; drawStatus(); }
    requestAnimationFrame(loop);
  }
  let lastStatus = 0;

  ui.source.addEventListener('change', () => {
    const demo = ui.source.value === 'demo';
    document.querySelectorAll('.demo-only').forEach((e) => e.classList.toggle('hidden', !demo));
    document.querySelectorAll('.file-only').forEach((e) => e.classList.toggle('hidden', demo));
    statusExtra = ''; dirty = true;
  });
  ui.geo.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      ui.lat.value = pos.coords.latitude.toFixed(2); ui.lon.value = pos.coords.longitude.toFixed(2);
      store.set('lat', ui.lat.value); store.set('lon', ui.lon.value); refreshPlan(); dirty = true;
    });
  });

  // a "Clear my recordings" control under the plan
  const clr = document.createElement('button');
  clr.type = 'button'; clr.textContent = 'Delete my stored observations';
  clr.addEventListener('click', () => { if (confirm('Delete all stored observations from your recordings?')) { clearRecords(); realData = []; dirty = true; } });
  ui.plan.after(clr);

  // hooks for automated checks
  window.__hline = { demoData, eqToGal, galToEq, observerVelocity, lstHours, azElToRaDec, modelTB, NV, vAt };

  openDb().then(loadRecords).then((r) => { realData = r; dirty = true; });
  refreshPlan();
  requestAnimationFrame(loop);
})();
