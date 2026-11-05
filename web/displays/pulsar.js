/*
 * Retro SETI display: Pulsar Search.
 * Simulated search of telescope beams for pulsars: a scrolling dynamic spectrum with
 * dispersed pulses (they arrive later at lower frequencies, delay = 4.149 ms * DM / f_GHz^2),
 * a dispersion-measure search, folding at the found period, and a candidate list.
 * Uses the current date and time.
 */
(() => {
  'use strict';
  const R = window.RetroSETI;
  if (!R) return;
  const { ctx, text, colors, rand } = R;

  const FLO = 1.1, FHI = 1.9;                  // GHz, L-band receiver
  const NCH = 96, NT = 360;                    // dynamic spectrum: channels x time columns
  const WIN = 4.0;                             // seconds shown across the waterfall
  const DMMAX = 1000, NDM = 220, NPH = 64, NSUB = 40;
  const fch = (c) => FHI - (c + 0.5) / NCH * (FHI - FLO);
  const delay = (dm, f) => 4.149e-3 * dm * (1 / (f * f) - 1 / (FHI * FHI));

  let src, phase, phaseT, tObs;               // current beam / candidate and search stage
  const ds = new Float32Array(NCH * NT);       // dynamic spectrum, newest column at the right
  let colAcc = 0, tStream = 0;
  const dmCurve = new Float32Array(NDM);
  let dmDone = 0;
  const prof = new Float32Array(NPH), stack = new Float32Array(NSUB * NPH);
  let subDone = 0;
  const cands = [];
  let beam = 1, flash = 0;

  function newSource() {
    const real = Math.random() < 0.88;
    const ra = rand(0, 24), dec = rand(-30, 70);
    src = {
      real,
      P: real ? Math.exp(rand(Math.log(0.0025), Math.log(2.2))) : 0,
      DM: real ? rand(15, 650) : 0,
      w: 0, amp: real ? rand(1.4, 3.2) : 0,
      ra, dec,
      name: `J${pad2(Math.floor(ra))}${pad2(Math.floor((ra % 1) * 60))}${dec >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(dec)))}${pad2(Math.floor((Math.abs(dec) % 1) * 60))}`,
    };
    src.w = Math.max(0.0004, src.P * rand(0.02, 0.06));
    phase = 'dedisperse'; phaseT = 0; tObs = Date.now();
    dmCurve.fill(0); dmDone = 0; prof.fill(0); stack.fill(-0.5); subDone = 0;
    beam = beam % 7 + 1;
  }
  const pad2 = (v) => String(v).padStart(2, '0');

  // S/N a dedispersion trial at dm would give: peaks at the true DM, width set by pulse width / band
  function snrAt(dm) {
    if (!src.real) return 6 * Math.random();
    const smear = Math.abs(delay(dm - src.DM, FLO)) / src.w;
    return 4 + 14 * src.amp / Math.sqrt(1 + smear * smear) + 1.5 * (Math.random() - 0.5);
  }

  function pulseAt(t, f) {
    if (!src.real) return 0;
    const ta = t - delay(src.DM, f);
    let ph = (ta / src.P) % 1; if (ph < 0) ph += 1;
    const d = Math.min(ph, 1 - ph) * src.P;
    return src.amp * Math.exp(-0.5 * (d / src.w) ** 2);
  }

  function addColumn() {
    // scroll left by one and fill the newest column
    for (let c = 0; c < NCH; c++) {
      const row = c * NT;
      for (let x = 0; x < NT - 1; x++) ds[row + x] = ds[row + x + 1];
    }
    const dt = WIN / NT;
    tStream += dt;
    const burst = Math.random() < 0.004;        // broadband interference
    for (let c = 0; c < NCH; c++) {
      let v = 0.5 * gauss() + pulseAt(tStream, fch(c));
      if (c === 17 || c === 61) v += 1.4 + 0.4 * gauss();   // narrow-band RFI channels
      if (burst) v += 3;
      ds[c * NT + NT - 1] = v;
    }
  }
  function gauss() { let u = 0; while (u === 0) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

  function tick(dt) {
    phaseT += dt;
    colAcc += dt * NT / WIN * 0.25;             // waterfall plays at quarter speed so pulses are visible
    while (colAcc >= 1) { colAcc -= 1; addColumn(); }
    flash = Math.max(0, flash - dt);
    if (phase === 'dedisperse') {
      const target = Math.min(NDM, Math.floor(phaseT / 14 * NDM));
      while (dmDone < target) { dmCurve[dmDone] = snrAt((dmDone + 0.5) / NDM * DMMAX); dmDone++; }
      if (dmDone >= NDM) { phase = 'fold'; phaseT = 0; }
    } else if (phase === 'fold') {
      const target = Math.min(NSUB, Math.floor(phaseT / 14 * NSUB));
      while (subDone < target) {
        for (let k = 0; k < NPH; k++) {
          const ph = (k + 0.5) / NPH;
          let v = 0.35 * gauss();
          if (src.real) { const d = Math.min(Math.abs(ph - 0.3), 1 - Math.abs(ph - 0.3)) * src.P; v += 1.6 * Math.exp(-0.5 * (d / src.w) ** 2); }
          stack[subDone * NPH + k] = v; prof[k] += v;
        }
        subDone++;
      }
      if (subDone >= NSUB) {
        phase = 'result'; phaseT = 0; flash = 3;
        const peak = Math.max(...dmCurve);
        cands.unshift({
          name: 'PSR ' + src.name, P: src.real ? src.P * 1000 : 0, DM: src.real ? src.DM : 0,
          snr: src.real ? peak * Math.sqrt(NSUB) / 2.2 : rand(5, 7),
          status: !src.real ? 'RFI — rejected' : (Math.random() < 0.35 ? 'Known pulsar' : 'NEW CANDIDATE'),
          t: Date.now(),
        });
        if (cands.length > 7) cands.pop();
      }
    } else if (phaseT > 5) newSource();
  }

  // ---- drawing ----
  const tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  function blitGray(grid, nx, ny, lo, hi, x, y, w, h, tint) {
    tmp.width = nx; tmp.height = ny;
    const img = tctx.createImageData(nx, ny);
    for (let i = 0; i < nx * ny; i++) {
      const t = Math.max(0, Math.min(1, (grid[i] - lo) / (hi - lo)));
      img.data[4 * i] = tint[0] * t + 255 * t * t * 0.6; img.data[4 * i + 1] = tint[1] * t + 255 * t * t * 0.6; img.data[4 * i + 2] = tint[2] * t + 255 * t * t * 0.4; img.data[4 * i + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, x, y, w, h);
  }
  const lab = (s, x, y, align = 'center') => text(s, x, y, 15, '#bbb', align);

  function draw() {
    const stage = { dedisperse: 'Dedispersing — searching dispersion measures', fold: 'Folding at the best period', result: flash > 0 ? 'Candidate scored' : 'Next beam' }[phase];
    R.header('PULSAR', 'SEARCH', [R.utc(Date.now()), `Beam ${beam} of 7 · L-band ${FLO}–${FHI} GHz · RA ${pad2(Math.floor(src.ra))}h${pad2(Math.floor((src.ra % 1) * 60))}m Dec ${src.dec >= 0 ? '+' : ''}${src.dec.toFixed(1)}°`]);

    // dynamic spectrum
    R.panel(20, 104, 920, 440, 'Dynamic spectrum');
    blitGray(ds, NT, NCH, -0.6, 3.2, 110, 150, 800, 340, [80, 170, 255]);
    ctx.strokeStyle = '#7f7f7f'; ctx.lineWidth = 1; ctx.strokeRect(110, 150, 800, 340);
    lab(`${FHI} GHz`, 102, 162, 'right'); lab(`${FLO} GHz`, 102, 490, 'right');
    lab('time →   (pulses arrive later at low frequencies: dispersion by interstellar electrons)', 510, 516);

    // DM search
    R.panel(960, 104, 520, 440, 'Dispersion measure search');
    {
      const x0 = 1010, y0 = 160, w = 440, h = 300;
      ctx.strokeStyle = '#7f7f7f'; ctx.strokeRect(x0, y0, w, h);
      const ymax = Math.max(12, ...dmCurve.slice(0, Math.max(1, dmDone))) * 1.15;
      ctx.strokeStyle = colors.GREEN; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < dmDone; i++) { const x = x0 + (i + 0.5) / NDM * w, y = y0 + h - dmCurve[i] / ymax * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      if (phase === 'dedisperse') { const x = x0 + dmDone / NDM * w; ctx.strokeStyle = colors.RED; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke(); }
      for (const d of [0, 250, 500, 750, 1000]) lab(String(d), x0 + d / DMMAX * w, y0 + h + 18);
      lab('DM (pc cm⁻³)', x0 + w / 2, y0 + h + 40);
      text(`trial ${Math.min(dmDone * 7, NDM * 7)} / ${NDM * 7}`, x0 + 8, y0 + 22, 16, '#ccc');
      if (phase !== 'dedisperse' && src.real) text(`best DM ${src.DM.toFixed(1)}`, x0 + w - 8, y0 + 22, 16, colors.GREEN, 'right');
    }

    // folded profile
    R.panel(20, 560, 450, 310, 'Folded pulse profile');
    {
      const x0 = 60, y0 = 610, w = 380, h = 200;
      ctx.strokeStyle = '#7f7f7f'; ctx.strokeRect(x0, y0, w, h);
      let mx = 1, mn = 0;
      for (const v of prof) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
      ctx.strokeStyle = colors.RED; ctx.lineWidth = 2; ctx.beginPath();
      for (let k = 0; k < 2 * NPH; k++) {
        const v = prof[k % NPH], x = x0 + (k + 0.5) / (2 * NPH) * w, y = y0 + h - 8 - (v - mn) / (mx - mn + 1e-6) * (h - 16);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      lab('pulse phase (two periods)', x0 + w / 2, y0 + h + 22);
      if (phase !== 'dedisperse' && src.real) text(`P = ${(src.P * 1000).toFixed(3)} ms`, x0 + 8, y0 + 22, 16, colors.GREEN);
    }

    // phase vs time
    R.panel(490, 560, 450, 310, 'Phase vs time');
    blitGray(stack, NPH, NSUB, -0.5, 2.0, 530, 610, 380, 200, [255, 120, 60]);
    ctx.strokeStyle = '#7f7f7f'; ctx.strokeRect(530, 610, 380, 200);
    lab('phase →   (a straight line = the right period)', 720, 832);

    // candidates
    R.panel(960, 560, 520, 310, 'Candidates');
    {
      const cols = [985, 1180, 1270, 1350, 1460];
      text('Source', cols[0], 620, 15, '#bbb'); text('P (ms)', cols[1] + 60, 620, 15, '#bbb', 'right');
      text('DM', cols[2] + 50, 620, 15, '#bbb', 'right'); text('S/N', cols[3] + 40, 620, 15, '#bbb', 'right');
      cands.forEach((c, i) => {
        const y = 648 + i * 30, hot = i === 0 && flash > 0 && Math.floor(flash * 3) % 2 === 0;
        const col = c.status === 'NEW CANDIDATE' ? colors.GREEN : c.status.startsWith('RFI') ? '#888' : colors.WHITE;
        text(c.name, cols[0], y, 16, hot ? '#ffd040' : col);
        text(c.P ? c.P.toFixed(3) : '—', cols[1] + 60, y, 16, col, 'right');
        text(c.DM ? c.DM.toFixed(1) : '—', cols[2] + 50, y, 16, col, 'right');
        text(c.snr.toFixed(1), cols[3] + 40, y, 16, col, 'right');
        text(c.status, cols[4], y, 13, col, 'right');
      });
      if (!cands.length) text('searching…', 1220, 700, 18, '#888', 'center');
    }
    // what the search is doing right now
    const msg = stage + (phase === 'result' && cands[0] ? `: ${cands[0].name} \u2014 ${cands[0].status}` : '');
    text(msg, 1220, 528, 16, '#ffd040', 'center');
    R.simulatedTag();
  }

  newSource();
  for (let i = 0; i < NT; i++) addColumn();
  R.register({ id: 'pulsar', title: 'Pulsar Search', tick, draw });
})();
