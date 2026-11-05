/*
 * Shared hydrogen-line physics for Retro SETI: astronomy (sidereal time, coordinate
 * conversions, observer motion), spectrum processing, and a model of the Milky Way's
 * hydrogen used for the simulated sky. Used by the Hydrogen Line Observatory page
 * (hline.js) and the screensaver's Hydrogen Line Survey display.
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
  function demoSpectrumAt(p, t, bw) {
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


  window.HModel = {
    F0, C_KMS, R0, V0, VMIN, VMAX, DV, NV, vAt, DEG, LAMBDA,
    jdOf, lstHours, azElToRaDec, eqToGal, galToEq, observerVelocity,
    polyBaseline, despike, finishSpectrum, modelTB, demoSpectrumAt, gauss, vRot,
  };
})();
