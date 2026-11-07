/*
 * Retro SETI display: DEEP SPACE NETWORK — LIVE.
 *
 * SETI@home listened for signals from the stars. This listens to humanity's own messengers:
 * the real-time feed of NASA's Deep Space Network (which antenna at Goldstone, Madrid or
 * Canberra is talking to which spacecraft, at what data rate and signal power, and the light
 * time), drawn as beams from Earth out to each spacecraft at its real distance.
 *
 * Live sources (all fetched directly by the browser; each sends Access-Control-Allow-Origin
 * or is shown only as an image/video):
 *   DSN Now            https://eyes.nasa.gov/dsn/data/dsn.xml, config.xml   (NASA/JPL)
 *   The Sun, 48 h      https://sdo.gsfc.nasa.gov/assets/img/latest/mpeg/   (NASA SDO, AIA)
 *   Earth today        https://epic.gsfc.nasa.gov/api/natural             (NASA DSCOVR/EPIC)
 *   Space weather      https://services.swpc.noaa.gov/                     (NOAA SWPC: GOES X-rays, Kp)
 * If a feed can't be reached the display keeps going with what it has (and a built-in sample
 * for the DSN links), and says so.
 */
(() => {
  'use strict';
  const R = window.RetroSETI;
  if (!R) return;
  const { ctx, text, colors, VW, VH } = R;
  const DEG = Math.PI / 180;
  const C_KM = 299792.458;
  const AU = 149597870.7;

  // ---------------------------------------------------------------- live data
  const SITES = {
    gdscc: { name: 'Goldstone', country: 'California, USA', lat: 35.2444, lon: -116.8895 },
    mdscc: { name: 'Madrid', country: 'Spain', lat: 40.2414, lon: -4.2480 },
    cdscc: { name: 'Canberra', country: 'Australia', lat: -35.2209, lon: 148.9813 },
  };
  const DISH_SIZE = { DSS14: 70, DSS43: 70, DSS63: 70 };
  const state = {
    dishes: [], links: [], sc: new Map(), updated: 0, source: 'connecting', names: {},
    xray: [], xrayClass: '', kp: null, epic: null, sunMode: 0,
  };

  // a small built-in sample, used only if the live feed can't be reached
  const SAMPLE = `<dsn>
<station name="gdscc"/><dish name="DSS14" azimuthAngle="140" elevationAngle="38"><downSignal active="true" dataRate="160" band="X" power="-157" spacecraft="VGR2"/><target name="VGR2" uplegRange="2.1e10" downlegRange="2.1e10" rtlt="140000"/></dish>
<dish name="DSS26" azimuthAngle="130" elevationAngle="63"><downSignal active="true" dataRate="2375000" band="X" power="-130" spacecraft="MRO"/><target name="MRO" downlegRange="2.06e8" rtlt="1380"/></dish>
<station name="mdscc"/><dish name="DSS63" azimuthAngle="95" elevationAngle="31"><downSignal active="true" dataRate="160" band="X" power="-158" spacecraft="VGR1"/><upSignal active="true" band="S" spacecraft="VGR1"/><target name="VGR1" downlegRange="2.54e10" rtlt="169500"/></dish>
<dish name="DSS54" azimuthAngle="200" elevationAngle="40"><downSignal active="true" dataRate="28000000" band="Ka" power="-119" spacecraft="JWST"/><target name="JWST" downlegRange="1.5e6" rtlt="10"/></dish>
<station name="cdscc"/><dish name="DSS43" azimuthAngle="20" elevationAngle="50"><downSignal active="true" dataRate="40000" band="X" power="-141" spacecraft="JNO"/><target name="JNO" downlegRange="8.6e8" rtlt="5740"/></dish>
<dish name="DSS35" azimuthAngle="300" elevationAngle="45"><downSignal active="true" dataRate="2000" band="X" power="-150" spacecraft="PSYC"/><target name="PSYC" downlegRange="3.4e8" rtlt="2270"/></dish>
</dsn>`;

  async function fetchText(url, ms = 12000) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(url, { signal: ac.signal, cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return await r.text(); }
    finally { clearTimeout(t); }
  }

  function parseDsn(xml, source) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const dishes = [], links = new Map();
    let site = null;
    for (const el of doc.documentElement.children) {
      if (el.tagName === 'station') { site = el.getAttribute('name'); continue; }
      if (el.tagName !== 'dish' || !SITES[site]) continue;
      const d = {
        name: el.getAttribute('name'), site, size: DISH_SIZE[el.getAttribute('name')] || 34,
        az: +el.getAttribute('azimuthAngle') || 0, el: +el.getAttribute('elevationAngle') || 0,
        activity: el.getAttribute('activity') || '', targets: [],
      };
      const sig = {};
      for (const s of el.children) {
        const sc = (s.getAttribute('spacecraft') || s.getAttribute('name') || '').toUpperCase();
        if (s.tagName === 'downSignal' || s.tagName === 'upSignal') {
          if (s.getAttribute('active') !== 'true') continue;
          const o = sig[sc] || (sig[sc] = {});
          if (s.tagName === 'downSignal') { o.down = true; o.rate = Math.max(o.rate || 0, +s.getAttribute('dataRate') || 0); o.band = s.getAttribute('band') || o.band; o.power = +s.getAttribute('power'); }
          else { o.up = true; o.upBand = s.getAttribute('band'); o.band = o.band || s.getAttribute('band'); }
        } else if (s.tagName === 'target') {
          const range = +s.getAttribute('downlegRange'), rtlt = +s.getAttribute('rtlt');
          if (sc && sc !== 'DSN' && range > 0) d.targets.push({ sc, range, rtlt });
        }
      }
      for (const t of d.targets) {
        const s = sig[t.sc];
        if (!s) continue;            // tracking without an active signal: skip the beam
        const key = t.sc;
        const L = links.get(key) || { sc: key, range: t.range, rtlt: t.rtlt, dishes: [], rate: 0, power: -999, band: '', up: false, down: false };
        L.dishes.push(d.name); L.range = t.range; L.rtlt = t.rtlt > 0 ? t.rtlt : 2 * t.range / C_KM;
        if (s.rate > L.rate) L.rate = s.rate;
        if (Number.isFinite(s.power) && s.power > L.power && s.power > -400) L.power = s.power;
        L.band = L.band || s.band || 'X'; L.up = L.up || !!s.up; L.down = L.down || !!s.down;
        L.site = L.site || d.site;
        links.set(key, L);
        d.busy = (d.busy || []).concat(key);
      }
      dishes.push(d);
    }
    if (!dishes.length) throw new Error('empty');
    state.dishes = dishes;
    state.links = [...links.values()].sort((a, b) => a.range - b.range);
    state.updated = Date.now(); state.source = source;
  }

  async function pollDsn() {
    try { parseDsn(await fetchText('https://eyes.nasa.gov/dsn/data/dsn.xml?r=' + Date.now()), 'live'); }
    catch (e) { if (state.source !== 'live') try { parseDsn(SAMPLE, 'sample'); } catch (e2) { /* ignore */ } }
  }
  async function loadNames() {
    try {
      const doc = new DOMParser().parseFromString(await fetchText('https://eyes.nasa.gov/dsn/config.xml'), 'text/xml');
      for (const s of doc.getElementsByTagName('spacecraft')) state.names[(s.getAttribute('name') || '').toUpperCase()] = s.getAttribute('friendlyName');
    } catch (e) { /* use codes */ }
  }
  async function pollWeather() {
    try {
      const x = JSON.parse(await fetchText('https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json'));
      state.xray = x.filter((r) => r.energy === '0.1-0.8nm' && r.flux > 0).map((r) => [Date.parse(r.time_tag), r.flux]);
      const f = state.xray.length ? state.xray[state.xray.length - 1][1] : 0;
      state.xrayClass = flareClass(f);
    } catch (e) { /* keep last */ }
    try {
      const k = JSON.parse(await fetchText('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'));
      const last = k[k.length - 1];
      state.kp = Array.isArray(last) ? +last[1] : +(last.Kp ?? last.kp_index ?? NaN);
    } catch (e) { /* keep last */ }
  }
  function flareClass(f) {
    if (!(f > 0)) return '';
    const L = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
    for (const [c, v] of L) if (f >= v) return `${c}${(f / v).toFixed(1)}`;
    return 'A0.0';
  }

  // Earth: today's EPIC photo (sunlit side, from a million miles away)
  const earthImg = new Image();
  // display only (EPIC's archive sends no CORS header), so no crossOrigin request mode
  let earthReady = false;
  // decode off the main thread before first use, so the first frame with the photo doesn't stall
  earthImg.onload = () => { (earthImg.decode ? earthImg.decode() : Promise.resolve()).then(() => { earthReady = true; }, () => { earthReady = true; }); };
  async function loadEpic() {
    try {
      const list = JSON.parse(await fetchText('https://epic.gsfc.nasa.gov/api/natural'));
      const e = list[list.length - 1];
      const d = e.date.slice(0, 10).replace(/-/g, '/');
      state.epic = { date: e.date, lat: e.centroid_coordinates.lat, lon: e.centroid_coordinates.lon };
      earthImg.src = `https://epic.gsfc.nasa.gov/archive/natural/${d}/jpg/${e.image}.jpg`;
    } catch (e) { /* procedural Earth */ }
  }

  // The Sun: SDO's last 48 hours as a looping video, cycling through AIA channels
  const SUN_MODES = [
    { code: '0193', name: 'AIA 193 Å', what: 'corona at 1.2 million °C' },
    { code: '0171', name: 'AIA 171 Å', what: 'coronal loops at 600,000 °C' },
    { code: '0304', name: 'AIA 304 Å', what: 'chromosphere and prominences' },
    { code: '0131', name: 'AIA 131 Å', what: 'flaring plasma at 10 million °C' },
    { code: '0211', name: 'AIA 211 Å', what: 'active regions at 2 million °C' },
  ];
  const sunVideo = document.createElement('video');
  sunVideo.muted = true; sunVideo.loop = true; sunVideo.playsInline = true; sunVideo.preload = 'auto';
  sunVideo.setAttribute('playsinline', ''); sunVideo.setAttribute('muted', '');
  const sunStill = new Image();
  let sunVideoOk = false, sunStillOk = false;
  sunVideo.addEventListener('playing', () => { sunVideoOk = true; });
  sunVideo.addEventListener('error', () => { sunVideoOk = false; });
  sunStill.onload = () => { (sunStill.decode ? sunStill.decode() : Promise.resolve()).then(() => { sunStillOk = true; }, () => { sunStillOk = true; }); };
  function loadSun() {
    const m = SUN_MODES[state.sunMode % SUN_MODES.length];
    sunVideoOk = false; sunStillOk = false;
    sunStill.src = `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_${m.code}.jpg`;
    sunVideo.src = `https://sdo.gsfc.nasa.gov/assets/img/latest/mpeg/latest_1024_${m.code}.mp4`;
    sunVideo.play().catch(() => { /* autoplay blocked: the still image is used */ });
  }

  // ---------------------------------------------------------------- planets (JPL approximate elements)
  const EL = {
    Mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
    Venus: [0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
    Earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
    Mars: [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
    Jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
    Saturn: [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
    Uranus: [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.95427630, 0.40805281, 74.01692503, 0.04240589],
    Neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664],
  };
  function helio(name, t) {
    const T = (t / 86400000 + 2440587.5 - 2451545.0) / 36525, e0 = EL[name];
    const a = e0[0] + e0[1] * T, e = e0[2] + e0[3] * T, I = (e0[4] + e0[5] * T) * DEG;
    const L = e0[6] + e0[7] * T, w = e0[8] + e0[9] * T, O = (e0[10] + e0[11] * T) * DEG;
    let M = ((L - w) % 360 + 540) % 360 - 180; M *= DEG;
    let E = M + e * Math.sin(M);
    for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E), om = w * DEG - O;
    const x = (Math.cos(om) * Math.cos(O) - Math.sin(om) * Math.sin(O) * Math.cos(I)) * xp + (-Math.sin(om) * Math.cos(O) - Math.cos(om) * Math.sin(O) * Math.cos(I)) * yp;
    const y = (Math.cos(om) * Math.sin(O) + Math.sin(om) * Math.cos(O) * Math.cos(I)) * xp + (-Math.sin(om) * Math.sin(O) + Math.cos(om) * Math.cos(O) * Math.cos(I)) * yp;
    const z = Math.sin(om) * Math.sin(I) * xp + Math.cos(om) * Math.sin(I) * yp;
    return [x, y, z];
  }
  function distFromEarthKm(name, t) {
    const p = helio(name, t), e = helio('Earth', t);
    return Math.hypot(p[0] - e[0], p[1] - e[1], p[2] - e[2]) * AU;
  }

  // ---------------------------------------------------------------- spacecraft facts
  const FACTS = {
    VGR1: 'Launched 1977. In interstellar space since 2012 — the farthest human-made object.',
    VGR2: 'Launched 1977. The only spacecraft to visit Uranus and Neptune. Now in interstellar space.',
    NHPC: 'Flew past Pluto in 2015 and Arrokoth in 2019. Heading out of the solar system.',
    JWST: 'The largest space telescope ever built, a million miles out at the Sun–Earth L2 point.',
    JNO: 'Orbiting Jupiter since 2016, diving over its poles and past its moons.',
    M20: 'The Perseverance rover, collecting samples in Jezero Crater on Mars.',
    MSL: 'The Curiosity rover, climbing Mount Sharp on Mars since 2012.',
    MRO: 'Mars Reconnaissance Orbiter: the high-resolution camera and data relay for the rovers.',
    M01O: '2001 Mars Odyssey, the longest-serving spacecraft at Mars.',
    MVN: 'MAVEN, studying how Mars lost its atmosphere to space.',
    TGO: 'ESA’s Trace Gas Orbiter, sniffing the Martian atmosphere.',
    MEX: 'ESA’s Mars Express, orbiting Mars since 2003.',
    EMM: 'The UAE’s Hope probe, watching Martian weather.',
    PSYC: 'On its way to Psyche, a metal-rich asteroid that may be a planet’s exposed core.',
    LUCY: 'Touring the Trojan asteroids that share Jupiter’s orbit.',
    EURC: 'Europa Clipper, en route to Jupiter’s ocean moon Europa.',
    JUIC: 'ESA’s JUICE, heading to Jupiter’s icy moons.',
    BEPI: 'BepiColombo, on its way into orbit around Mercury.',
    SPP: 'Parker Solar Probe, the fastest object ever built, flying through the Sun’s corona.',
    STA: 'STEREO-A, watching the Sun from a different angle than Earth.',
    SOHO: 'Watching the Sun since 1995 — and the greatest comet discoverer in history.',
    ACE: 'Sampling the solar wind a million miles upstream of Earth.',
    WIND: 'Measuring the solar wind since 1994.',
    DSCO: 'DSCOVR, which takes the EPIC photos of Earth shown here.',
    LRO: 'Lunar Reconnaissance Orbiter, mapping the Moon since 2009.',
    KPLO: 'Korea’s Danuri, orbiting the Moon.',
    ORX: 'OSIRIS-APEX, heading for asteroid Apophis after returning samples of Bennu.',
    ESCB: 'ESCAPADE Blue, one of twin probes heading to study Mars’ magnetosphere.',
    ESCG: 'ESCAPADE Gold, one of twin probes heading to study Mars’ magnetosphere.',
    CHDR: 'Chandra X-ray Observatory, imaging the hot, violent universe.',
  };
  const nameOf = (sc) => state.names[sc] || sc;

  // ---------------------------------------------------------------- layout
  const EARTH = { x: 360, y: 400, r: 74 };
  const AX = { x0: 470, x1: 1450, k0: Math.log10(2e4), k1: Math.log10(3.2e10) };   // km, log scale
  const xOf = (km) => AX.x0 + (Math.log10(Math.max(2e4, km)) - AX.k0) / (AX.k1 - AX.k0) * (AX.x1 - AX.x0);

  // offscreen layers: starfield and the sun's glow
  const stars = document.createElement('canvas'); stars.width = VW; stars.height = VH;
  (function () {
    const g = stars.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, VW, VH);
    for (let i = 0; i < 1600; i++) {
      const x = Math.random() * VW, y = Math.random() * VH, m = Math.random();
      g.fillStyle = `rgba(${200 + 55 * Math.random()},${200 + 55 * Math.random()},255,${0.15 + 0.6 * m * m * m})`;
      g.fillRect(x, y, m > 0.985 ? 2 : 1, m > 0.985 ? 2 : 1);
    }
    // faint Milky Way band
    const grd = g.createLinearGradient(0, VH * 0.15, VW, VH * 0.95);
    grd.addColorStop(0.35, 'rgba(120,100,200,0)'); grd.addColorStop(0.5, 'rgba(120,100,200,0.07)'); grd.addColorStop(0.65, 'rgba(120,100,200,0)');
    g.fillStyle = grd; g.fillRect(0, 0, VW, VH);
  })();

  const SUN = { x: -40, y: 400, r: 300 };

  // packets flowing along the beams
  let packets = [], spot = 0, spotT = 0, lastFetch = 0, lastWeather = 0, sunT = 0;

  function linkGeom(L, i, n) {
    const x = xOf(L.range);
    const y = 150 + (n <= 1 ? 230 : (i / (n - 1)) * 450) + ((i % 2) ? 14 : -14);
    return { x, y };
  }

  function siteOnEarth(site) {
    // where the complex sits on today's EPIC photo (orthographic around the photo's centre point)
    const s = SITES[site], c = state.epic || { lat: 0, lon: 0 };
    const la = s.lat * DEG, lo = (s.lon - c.lon) * DEG, la0 = c.lat * DEG;
    const x = Math.cos(la) * Math.sin(lo);
    const y = Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(lo);
    const z = Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo);
    const r = EARTH.r * 0.96;
    if (z >= 0) return { x: EARTH.x + x * r, y: EARTH.y - y * r, visible: true };
    const n = Math.hypot(x, y) || 1;                     // far side: beam leaves from the limb
    return { x: EARTH.x + x / n * EARTH.r, y: EARTH.y - y / n * EARTH.r, visible: false };
  }

  function bezier(a, c, b, t) {
    const u = 1 - t;
    return [u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y];
  }

  const BAND = { S: '#7dff9a', X: '#4fd8ff', Ka: '#ff6ad5', K: '#ff6ad5' };

  function tick(dt) {
    const now = Date.now();
    if (now - lastFetch > 10000) { lastFetch = now; pollDsn(); }
    if (now - lastWeather > 300000) { lastWeather = now; pollWeather(); }
    sunT += dt;
    const links = state.links, n = links.length;
    // spawn packets: more for faster links
    links.forEach((L, i) => {
      const rate = Math.log10(1 + L.rate) / 8;
      if (Math.random() < dt * (0.6 + 3 * rate) && L.down) packets.push({ sc: L.sc, i, t: 0, dir: -1, sp: 0.18 + 0.25 * Math.random(), band: L.band });
      if (L.up && Math.random() < dt * 0.5) packets.push({ sc: L.sc, i, t: 0, dir: 1, sp: 0.15 + 0.2 * Math.random(), band: 'up' });
    });
    for (const p of packets) p.t += dt * p.sp;
    packets = packets.filter((p) => p.t < 1 && state.links.some((L) => L.sc === p.sc));
    if (packets.length > 260) packets.splice(0, packets.length - 260);
    spotT += dt;
    if (spotT > 9 && n) { spotT = 0; spot = (spot + 1) % n; }
  }

  // ---------------------------------------------------------------- formatting
  function fmtRate(b) { if (!b) return 'carrier only'; if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mb/s`; if (b >= 1e3) return `${(b / 1e3).toFixed(b >= 1e4 ? 0 : 1)} kb/s`; return `${Math.round(b)} b/s`; }
  function fmtDist(km) {
    if (km >= 0.1 * AU) return `${(km / AU).toFixed(km >= 10 * AU ? 1 : 2)} AU`;
    if (km >= 1e6) return `${(km / 1e6).toFixed(2)} million km`;
    return `${Math.round(km).toLocaleString()} km`;
  }
  function fmtBig(km) { return km >= 1e9 ? `${(km / 1e9).toFixed(1)} billion km` : km >= 1e6 ? `${(km / 1e6).toFixed(1)} million km` : `${Math.round(km).toLocaleString()} km`; }
  function fmtLight(s) {
    if (!(s > 0)) return '—';
    if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  }
  function wattsOf(dbm) {
    const w = Math.pow(10, (dbm - 30) / 10);
    const ex = Math.floor(Math.log10(w)), m = w / Math.pow(10, ex);
    const sup = String(ex).replace(/-/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
    return `${m.toFixed(1)} × 10${sup} W`;
  }

  // ---------------------------------------------------------------- drawing
  // background = starfield + the Sun's glow for the current channel, prerendered once per channel
  const bgLayer = document.createElement('canvas'); bgLayer.width = VW; bgLayer.height = VH;
  let bgMode = -1;
  function sunTint(code) { return code === '0304' ? '255,90,40' : code === '0171' ? '255,200,80' : code === '0131' ? '60,220,220' : code === '0211' ? '200,90,255' : '255,180,60'; }
  let bgScale = 0;
  function buildBackground() {
    const m = SUN_MODES[state.sunMode % SUN_MODES.length];
    // built at screen resolution so drawing it each frame is a straight 1:1 copy
    const k = R.view.s;
    bgLayer.width = Math.round(VW * k); bgLayer.height = Math.round(VH * k);
    const g = bgLayer.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    g.drawImage(stars, 0, 0);
    const gr = g.createRadialGradient(SUN.x, SUN.y, SUN.r * 0.9, SUN.x, SUN.y, SUN.r * 1.7);
    gr.addColorStop(0, `rgba(${sunTint(m.code)},0.35)`); gr.addColorStop(1, `rgba(${sunTint(m.code)},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, SUN.x + SUN.r * 1.8, VH);
    bgMode = state.sunMode; bgScale = k;
  }
  const sunLayer = document.createElement('canvas');
  let sunStamp = '';
  function drawSun() {
    const m = SUN_MODES[state.sunMode % SUN_MODES.length];
    // the visible slice of the Sun, prerendered at screen resolution and refreshed only when the
    // video advances (scaling + clipping the 1024 px frame every frame was the expensive part)
    const src = sunVideoOk && sunVideo.readyState >= 2 ? sunVideo : sunStillOk ? sunStill : null;
    const k = R.view.s, x0 = 0, y0 = SUN.y - SUN.r, w = SUN.x + SUN.r, h = 2 * SUN.r;
    const stamp = (src === sunVideo ? 'v' + sunVideo.currentTime.toFixed(2) : src ? 's' + sunStill.src : 'none') + '@' + k.toFixed(3);
    if (stamp !== sunStamp) {
      sunStamp = stamp;
      const W = Math.max(1, Math.round(w * k)), Hh = Math.max(1, Math.round(h * k));
      if (sunLayer.width !== W || sunLayer.height !== Hh) { sunLayer.width = W; sunLayer.height = Hh; }
      const g = sunLayer.getContext('2d');
      g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
      g.clearRect(x0, y0, w, h);
      g.save(); g.beginPath(); g.arc(SUN.x, SUN.y, SUN.r, 0, 2 * Math.PI); g.clip();
      if (src) { const S = SUN.r * 2 / 0.79; g.drawImage(src, SUN.x - S / 2, SUN.y - S / 2, S, S); }
      else { const f = g.createRadialGradient(SUN.x, SUN.y, 0, SUN.x, SUN.y, SUN.r); f.addColorStop(0, '#ffd27a'); f.addColorStop(1, '#c2491a'); g.fillStyle = f; g.fillRect(SUN.x - SUN.r, SUN.y - SUN.r, 2 * SUN.r, 2 * SUN.r); }
      g.restore();
    }
    ctx.drawImage(sunLayer, x0, y0, w, h);
    text(`THE SUN · LIVE`, 24, 132, 18, '#ffd040');
    text(`SDO ${m.name} · ${m.what}`, 24, 156, 14, '#ddd');
    text(src === sunVideo ? 'last 48 hours, looping' : src ? 'latest image' : 'connecting to SDO…', 24, 176, 13, '#aaa');
  }

  function drawWeather() {
    const x0 = 24, y0 = 590, w = 210, h = 70;
    text('GOES X-RAY FLUX · 6 h', x0, y0 - 8, 13, '#ccc');
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, w, h);
    const xs = state.xray;
    if (xs.length > 2) {
      const t0 = xs[0][0], t1 = xs[xs.length - 1][0];
      const Y = (f) => y0 + h - (Math.log10(f) + 8.5) / 5 * h;     // 1e-8.5 .. 1e-3.5
      ctx.strokeStyle = '#ffb040'; ctx.lineWidth = 1.5; ctx.beginPath();
      xs.forEach(([t, f], i) => { const x = x0 + (t - t0) / (t1 - t0 || 1) * w, y = Y(f); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      for (const [c, f] of [['M', 1e-5], ['X', 1e-4]]) { ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x0, Y(f), w, 1); text(c, x0 + w - 4, Y(f) - 2, 11, '#888', 'right'); }
    }
    text(state.xrayClass ? `now: ${state.xrayClass}-class` : 'X-ray: —', x0, y0 + h + 20, 16, state.xrayClass && /[MX]/.test(state.xrayClass) ? '#ff5a3a' : '#fff');
    text(state.kp != null && Number.isFinite(state.kp) ? `Kp ${state.kp.toFixed(1)}${state.kp >= 5 ? '  geomagnetic storm — aurora!' : ''}` : 'Kp —', x0 + 120, y0 + h + 20, 16, state.kp >= 5 ? '#7dff9a' : '#fff');
  }

  const earthLayer = document.createElement('canvas');
  let earthLayerReady = null;
  function buildEarth() {
    const { r } = EARTH, size = Math.ceil(r * 2.8);
    earthLayer.width = size; earthLayer.height = size;
    const g = earthLayer.getContext('2d'), x = size / 2, y = size / 2;
    const gl = g.createRadialGradient(x, y, r, x, y, r * 1.35);
    gl.addColorStop(0, 'rgba(90,160,255,0.35)'); gl.addColorStop(1, 'rgba(90,160,255,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 1.35, 0, 2 * Math.PI); g.fill();
    g.save(); g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.clip();
    if (earthReady) { const S = r * 2 / 0.83; g.drawImage(earthImg, x - S / 2, y - S / 2, S, S); }
    else { const f = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r); f.addColorStop(0, '#5aa0ff'); f.addColorStop(1, '#0a2a6a'); g.fillStyle = f; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
    g.restore();
    earthLayerReady = earthReady;
  }
  function drawEarth() {
    const { x, y, r } = EARTH;
    if (earthLayerReady !== earthReady) buildEarth();
    ctx.drawImage(earthLayer, x - earthLayer.width / 2, y - earthLayer.height / 2);
    for (const k of Object.keys(SITES)) {
      const p = siteOnEarth(k);
      ctx.fillStyle = p.visible ? '#ffd040' : 'rgba(255,208,64,0.4)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI); ctx.fill();
    }
    text('EARTH', x, y + r + 26, 16, '#fff', 'center');
    text(state.epic ? `photographed by DSCOVR/EPIC, ${state.epic.date.slice(0, 16)} UTC` : '', x, y + r + 44, 12, '#999', 'center');
  }

  function drawAxis(t) {
    const y = 668;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(AX.x0, y); ctx.lineTo(AX.x1, y); ctx.stroke();
    const ticks = [['1 light-second', C_KM], ['1 light-minute', C_KM * 60], ['1 light-hour', C_KM * 3600], ['1 light-day', C_KM * 86400]];
    for (const [lab, km] of ticks) {
      const x = xOf(km);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, 110, 1, y - 110);
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(x, y - 5, 1, 10);
      text(lab, x, y + 19, 13, '#aaa', 'center');
    }
    const bodies = [['Moon', 384400], ...['Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'].map((p) => [p, distFromEarthKm(p, t)])];
    for (const [nm, km] of bodies) {
      const x = xOf(km);
      ctx.fillStyle = '#c8a8ff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
      text(nm, x, y - 10, 12, '#c8a8ff', 'center');
    }
    text('distance from Earth, log scale \u2192', AX.x0, y + 36, 12, '#777', 'left');
  }

  function drawLinks(t) {
    const links = state.links, n = links.length;
    const geo = links.map((L, i) => linkGeom(L, i, n));
    links.forEach((L, i) => {
      const a = siteOnEarth(L.site), b = geo[i];
      const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 60 - 40 * Math.sin(i) };
      L._a = a; L._b = b; L._c = c;
      const hot = i === spot;
      ctx.strokeStyle = hot ? 'rgba(255,255,255,0.65)' : (BAND[L.band] || '#4fd8ff') + '55';
      ctx.lineWidth = hot ? 2.2 : 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
    });
    // packets
    ctx.globalCompositeOperation = 'lighter';
    for (const p of packets) {
      const L = links[p.i];
      if (!L || L.sc !== p.sc || !L._a) continue;
      const tt = p.dir > 0 ? p.t : 1 - p.t;
      const col = p.band === 'up' ? '#ffd040' : (BAND[p.band] || '#4fd8ff');
      ctx.fillStyle = col;
      for (let k = 0; k < 3; k++) {
        const [x, y] = bezier(L._a, L._c, L._b, Math.max(0, Math.min(1, tt - p.dir * k * 0.014)));
        const sz = k ? 2.4 : 4.2;
        ctx.globalAlpha = 0.95 - k * 0.3;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // spacecraft markers
    links.forEach((L, i) => {
      const b = geo[i], hot = i === spot, col = BAND[L.band] || '#4fd8ff';
      const pulse = 1 + 0.25 * Math.sin(t / 300 + i);
      ctx.fillStyle = col; ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(b.x, b.y, 10 * pulse, 0, 2 * Math.PI); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = hot ? '#fff' : col; ctx.beginPath(); ctx.arc(b.x, b.y, hot ? 5 : 3.5, 0, 2 * Math.PI); ctx.fill();
      const right = b.x < 1330;
      text(shortName(L.sc), b.x + (right ? 12 : -12), b.y - 3, hot ? 16 : 14, hot ? '#fff' : '#ddd', right ? 'left' : 'right', hot);
      text(`${fmtLight(L.rtlt / 2)} · ${fmtRate(L.rate)}`, b.x + (right ? 12 : -12), b.y + 14, 12, '#999', right ? 'left' : 'right');
    });
  }
  function shortName(sc) {
    const full = nameOf(sc);
    return full.length > 26 ? sc : full;
  }

  function drawSpotlight() {
    const L = state.links[spot];
    if (!L) return;
    const x = 1010, y = 104, w = 470, h = 196;
    ctx.fillStyle = 'rgba(0,0,10,0.78)'; R.roundRect(x, y, w, h, 16); ctx.fill();
    ctx.strokeStyle = colors.PURPLE; ctx.lineWidth = 3; R.roundRect(x, y, w, h, 16); ctx.stroke();
    const dishes = L.dishes.map((d) => `${d.replace('DSS', 'DSS ')} (${DISH_SIZE[d] || 34} m)`).join(' + ');
    text(nameOf(L.sc).toUpperCase().slice(0, 34), x + 18, y + 34, 22, '#fff', 'left', true);
    text(`${fmtBig(L.range)}  \u00b7  ${L.range >= 0.05 * AU ? fmtDist(L.range) : `${(L.range / 384400).toFixed(1)}\u00d7 the distance to the Moon`}`, x + 18, y + 62, 16, colors.GREEN);
    text(`one-way light time ${fmtLight(L.rtlt / 2)} — this signal left ${fmtLight(L.rtlt / 2)} ago`, x + 18, y + 86, 14, '#ddd');
    text(`${L.down ? '↓ ' + fmtRate(L.rate) : ''}${L.up ? '   ↑ commands' : ''}   ${L.band}-band   ${L.power > -400 ? `${L.power} dBm = ${wattsOf(L.power)}` : ''}`, x + 18, y + 110, 14, '#ddd');
    text(`${dishes} · ${SITES[L.site].name}, ${SITES[L.site].country}`, x + 18, y + 134, 14, '#bbb');
    const fact = FACTS[L.sc] || '';
    wrap(fact, x + 18, y + 162, w - 36, 13, '#aaa');
  }
  function wrap(s, x, y, w, px, col) {
    R.font(px); const words = s.split(' '); let line = '', yy = y;
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (ctx.measureText(t).width > w && line) { text(line, x, yy, px, col); line = wd; yy += px + 4; } else line = t; }
    if (line) text(line, x, yy, px, col);
  }

  function drawDishIcon(x, y, el, on) {
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = on ? '#ddd' : '#555'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-5, 10); ctx.lineTo(0, 2); ctx.lineTo(5, 10); ctx.stroke();
    ctx.rotate(-(el || 0) * DEG);
    ctx.strokeStyle = on ? colors.GREEN : '#666'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let yy = -9; yy <= 9; yy += 2) { const xx = yy * yy / 22 - 3; yy === -9 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy); }
    ctx.stroke();
    ctx.restore();
  }

  function drawStations(t) {
    const y0 = 720, h = 152;
    const cols = ['gdscc', 'mdscc', 'cdscc'];
    cols.forEach((site, i) => {
      const x0 = 20 + i * 490, w = 470;
      ctx.fillStyle = 'rgba(0,0,10,0.72)'; R.roundRect(x0, y0, w, h, 14); ctx.fill();
      ctx.strokeStyle = colors.PURPLE; ctx.lineWidth = 3; R.roundRect(x0, y0, w, h, 14); ctx.stroke();
      const s = SITES[site];
      const local = new Date(t + s.lon / 15 * 3600000);
      text(`${s.name.toUpperCase()}`, x0 + 16, y0 + 26, 18, '#fff', 'left', true);
      text(`${s.country} · solar time ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`, x0 + w - 16, y0 + 26, 13, '#999', 'right');
      const ds = state.dishes.filter((d) => d.site === site);
      ds.slice(0, 5).forEach((d, k) => {
        const yy = y0 + 50 + k * 21, on = !!(d.busy && d.busy.length);
        drawDishIcon(x0 + 26, yy - 4, d.el, on);
        text(`${d.name.replace('DSS', 'DSS ')} ${d.size} m`, x0 + 44, yy, 13, on ? '#fff' : '#777');
        const what = on ? d.busy.map(shortName).join(', ') : (d.activity && !/Telemetry/.test(d.activity) ? d.activity : 'idle');
        text(what.length > 30 ? what.slice(0, 29) + '…' : what, x0 + 150, yy, 13, on ? colors.GREEN : '#666');
        text(on ? `az ${Math.round(d.az)}° el ${Math.round(d.el)}°` : '', x0 + w - 16, yy, 12, '#888', 'right');
      });
    });
  }

  function draw() {
    const t = Date.now();
    if (bgMode !== state.sunMode || Math.abs(bgScale - R.view.s) > 1e-3) buildBackground();
    ctx.drawImage(bgLayer, 0, 0, VW, VH);
    drawSun();
    drawAxis(t);
    drawLinks(t);
    drawEarth();
    drawWeather();
    // header
    ctx.letterSpacing = '2px';
    R.font(34, true, R.TITLE_FONT); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff'; ctx.fillText('DEEP SPACE NETWORK', 270, 52);
    const w = ctx.measureText('DEEP SPACE NETWORK ').width;
    ctx.fillStyle = state.source === 'live' ? '#ff4040' : '#888'; ctx.fillText(state.source === 'live' ? '● LIVE' : state.source === 'sample' ? 'SAMPLE' : '…', 270 + w, 52);
    ctx.letterSpacing = '0px';
    const nlinks = state.links.length;
    text(`${R.utc(t)}`, VW - 24, 32, 17, '#fff', 'right');
    text(state.source === 'live'
      ? `${nlinks} spacecraft talking to Earth right now · NASA DSN Now, updated ${Math.max(0, Math.round((t - state.updated) / 1000))} s ago`
      : state.source === 'sample' ? 'DSN feed unreachable — showing a built-in sample' : 'connecting to the Deep Space Network…', VW - 24, 56, 14, '#bbb', 'right');
    ctx.fillStyle = colors.PURPLE; R.roundRect(270, 70, VW - 284, 6, 3); ctx.fill();
    drawSpotlight();
    drawStations(t);
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    loadNames(); pollDsn(); pollWeather(); loadEpic(); loadSun();
    lastFetch = lastWeather = Date.now();
    setInterval(loadEpic, 3600000);
  }

  R.register({
    id: 'dsn', title: 'Deep Space Network — LIVE', tick, draw,
    onShow() { start(); state.sunMode++; loadSun(); },
  });
})();
