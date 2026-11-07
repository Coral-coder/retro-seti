# Retro SETI

A tribute to the classic (v3.x, 1999–2005) SETI@home screensaver. The layout, purple frame,
fonts, palette and the red-to-cyan 3D power/frequency/time graph are matched against
screenshots of the original v3.07 client: Data Analysis (activity, Doppler drift rate,
resolution, pulse/gaussian/peak readout, red mini-graph, 3D tube progress bar), Data Info,
User Info, and the graph that sweeps front-to-back for each FFT pass. Data units complete,
"send" and get replaced. **All data is simulated.** Nothing is downloaded or uploaded. The
globe/wave logo and dish are redrawn, not copied from the original.

### How closely it follows the original

Behaviour, formats and colours come from studying Berkeley's original **SETI@home 3.08
Windows client** (from the Internet Archive's "UC Berkeley SETI@home classic clients"
collection). It was taken apart and read, never run, and none of its code or artwork is copied:

- **3D graph:** drawn the way 3.08 drew it, from its 750×206 panel geometry. We render it at
  2× that resolution, so the sway moves in sub-pixel steps and the outlines are thinner, then
  scale it smoothly to the screen. Each row is a run of 1-pixel vertical lines coloured with HLS
  (hue = 0.5 + 0.5·(ncols−col)/ncols, lightness = 0.2 + 0.6·height/maxHeight, saturation 1).
  Black fills the steps where the neighbouring column is taller; otherwise one black pixel
  caps each column.
- **Viewpoint:** in 3.08 every new graph gets a random lean (left or right) and steepness:
  dx = 50–119 px, dy = 200 − dx, one row per pixel of depth. By default we also sway the lean
  constantly from side to side while the graph keeps drawing, the way later versions
  remembered it. *Per graph* in Settings gives the pure 3.08 behaviour.
- **Graph data:** FFT bins are max-reduced onto the columns, or stretched when the FFT is
  shorter than the width, which gives the blocky look at low resolution. Each row is scaled
  linearly against the largest value seen so far in the graph, and rows appear back to front
  as the analysis produces them.
- **Text:** the client's own formats, e.g. `Doppler drift rate: %6.4f Hz/sec    Resolution: %5.3f Hz`,
  `%sGaussian: power %5.2f, fit %5.3f`, `Best Triplet: power %5.2f, period %6.4f`,
  `Overall: %6.3f%% done`, `%2d hr %2d' %2d" RA`, `+%3d deg %2d' %2d" Dec`.
- **Status lines:** *Doing Baseline Smoothing*, *Chirping data*, *Computing Fast Fourier
  Transform*, *Searching for Gaussians*, *Searching for Pulses / Triplets*, then
  *Sending result - connecting to server.*, *Sending data: nK*, *All data sent.*,
  *Getting data - connecting to server.*, *Receiving data: nK* and *All data received.*
- **Small graph:** blank until something interesting turns up. During a search it plays
  rapidly through the data being examined: the Gaussian fit window slides along, and the
  pulse search flicks through folded profiles as the period is stepped. Otherwise it shows
  the best so far ("Best ...").
- **Colours:** purple frame 153,102,255; graph line pure red; grey 127; progress-bar reds
  240/120/80.
- **Sound:** the 3.08 client imports no audio APIs at all, so it was silent, and so is this.

### Custom title logo

Each viewer can use their own logo. The title then becomes **[globe] S.E.T.I. @ {logo}**
instead of the classic "The Search for Extraterrestrial Intelligence at HOME".

- **Web:** click **Upload logo** (or press **L**) and pick an image. It's scaled down and kept
  in that browser's `localStorage`; nothing is uploaded to a server. **Remove logo** restores
  the classic title. `?logo=https://…/image.png` also works for a one-off.
- **Windows:** open the screensaver's settings (`/c`, or *Settings* in Screen Saver Settings)
  and click **Choose logo…**. The image is copied to `%LOCALAPPDATA%\RetroSETI\logo.png`.

A wide PNG with a transparent or black background looks best.

## Web version (GitHub Pages)

`web/` is a dependency-free static page (`index.html` + `seti.js`, canvas-rendered).

- **Keeps the display awake** using the Screen Wake Lock API (with a muted-video fallback for
  browsers without it). The *Display awake* button toggles it; the browser releases the lock
  when the tab is hidden and the page re-takes it when you come back.
- **F1**: info box · **S**: Settings · **F** or double-click: fullscreen · **N**: set your name · **L**: upload a logo
- **Settings** window: data unit length, analysis step, graph grow/hold time, signal graph
  playthrough speed, rock period and amount, and the graph angle: *Rock* (default: the graph
  sways side to side all the time while it keeps drawing), *Per graph* (a random lean for each
  new graph, which is all the 3.08 binary does) or *Fixed*
- URL options: `?name=Your+Name`, `?wu=15` (minutes per data unit)
- Work units completed and total CPU time are remembered in `localStorage`.

Deployment: `.github/workflows/pages.yml` runs on every push to `main`, builds the Windows
screensaver, and publishes `web/` (with the `.scr` at `download/RetroSETI.scr`) to Pages.
Pages must be set to **Source: GitHub Actions**.

## Displays and rotation

The screensaver page cycles through several observatory displays, all with simulated data
(Settings → *Switch display every N min* and *Displays in rotation*; ← / → or 1–5 switch
by hand; `?display=dsn` (or `pulsar`, `hline`, …) pins one):

1. **SETI@home classic**: the original look. Work units are "recorded" in November 2020,
   the last month before Arecibo collapsed.
2. **Deep Space Network — LIVE** (real data, not simulated): NASA's live DSN Now feed
   shows which antenna at Goldstone, Madrid or Canberra is talking to which spacecraft right
   now. Each spacecraft appears at its real distance on a light-time scale (Voyager 1 is a
   light-day out), with beams and data packets flowing from today's DSCOVR/EPIC photo of Earth.
   A spotlight card covers each link in turn: distance, one-way light time, data rate, and
   received power in dBm and watts (Voyager arrives at about 10⁻¹⁹ W). The Sun on the left is
   SDO's last 48 hours, looping through the AIA channels, with the live GOES X-ray flare class
   and Kp index from NOAA. If a feed is unreachable it falls back to what it has (the DSN links
   to a built-in sample, clearly labelled).
3. **Hydrogen Line Survey**: a fast-forwarded drift scan of the Milky Way's 21 cm line
   (same physical model as the Observatory page): spectrum, waterfall, sky map and the
   longitude–velocity diagram.
4. **Pulsar Search**: a dynamic spectrum with dispersed pulses, the dispersion-measure
   search, folding (profile and phase-vs-time) and a candidate list.
5. **Black Hole Imaging**: an Earth-sized 230 GHz array at the real EHT sites. Earth's
   rotation fills the (u,v) plane and the image of M87*, Sgr A*, 3C 279 or Centaurus A is
   rebuilt from those samples.
6. **Deep Sky Scanner**: an all-sky map in galactic coordinates. The antenna slews to
   famous pulsars, quasars, black holes, masers and an FRB source (real positions, current
   time), locks on, and shows that kind of signal.

All displays except SETI use the current date and time. Rendering is capped at about 1440p
worth of pixels and scaled by the GPU, so 4K and high-DPI screens stay at 60 fps.

Live data credits: NASA/JPL Deep Space Network (DSN Now), NASA/SDO and the AIA science team,
NASA DSCOVR/EPIC, NOAA Space Weather Prediction Center (GOES X-ray flux, planetary Kp).

## Hydrogen Line Observatory (`web/hline.html`)

Turns a backyard dish + RTL-SDR into a hydrogen-line (1420.40575 MHz) radio telescope, or
simulates one first.

- **Demo sky:** a physical model of the Milky Way's hydrogen (a flaring disk, four spiral
  arms and a flat rotation curve), seen through your dish's beam with realistic noise and
  interference. Fast-forward it to watch a whole survey build up.
- **Your recordings:** load raw `rtl_sdr` captures (`.cu8`, 8-bit I/Q), e.g.
  `rtl_sdr -f 1420405751 -s 2400000 -g 40 -T capture.cu8`. They are processed in the
  browser at about 4× real time and only the averaged spectra are kept (in IndexedDB,
  about 1 MB per day).
- **Processing:** FFT power spectra → Doppler velocity → spike (interference) removal →
  bandpass flattening → correction for Earth's orbit and the Sun's motion (LSR) → sky
  position (RA/Dec and galactic l/b) from the time, your location and the dish pointing.
- **Products:**
  - spectrum and 24-hour waterfall
  - sky map
  - longitude–velocity diagram
  - rotation curve (tangent-point method, with the "no dark matter" curve for comparison)
  - face-on map of the Milky Way from kinematic distances
- **Survey planner:** the elevation and direction to point the dish each day.

A live USB connection to the RTL-SDR (WebUSB) is not included yet.

## Windows screensaver

`RetroSETI.scr` runs **the same displays as the website**: all six in rotation, including the
live NASA Deep Space Network and SDO feeds. It hosts the web app in **WebView2**, the
Edge/Chromium engine that ships with Windows 10 and 11.

It is still a single file. The web app and the WebView2 SDK's DLLs are embedded and unpacked
to `%LOCALAPPDATA%\RetroSETI` on first run, so it works offline apart from the live feeds.

Install: download `RetroSETI.scr` from the site, right-click it → **Install**, or copy it to
`C:\Windows\System32`, then pick *Retro SETI* in Screen Saver Settings.

| Command | What it does |
| --- | --- |
| `RetroSETI.scr /s` | Full screen on every monitor; mouse, key or click exits |
| `RetroSETI.scr /c` (or **Settings…** in Windows) | Opens the page in a window with its Settings panel (rotation interval, displays in rotation, speeds, name, logo); the screensaver uses the same settings |
| `RetroSETI.scr /w` | The page in a normal window (F11 or F for full screen) |
| `RetroSETI.scr /p <hwnd>` | Small preview in Screen Saver Settings (native SETI display) |
| `RetroSETI.scr /native` | Settings for the native fallback |

While running, it calls `SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)`
so the monitor won't power off and the PC won't sleep. If WebView2 isn't installed (very old
Windows 10), it falls back to the native C#/GDI+ SETI@home display, which is still included.

Because it's an unsigned download, Windows SmartScreen may warn on first run
(*More info → Run anyway*). Third-party licence: `windows/THIRD-PARTY-NOTICES.txt`
(Microsoft WebView2 SDK, BSD-style).

Build locally (Windows or Linux, .NET 8 SDK):

```
dotnet build windows/RetroSETI.csproj -c Release -o build
copy build\RetroSETI.exe RetroSETI.scr
```

## License

GPL-2.0-or-later (see `LICENSE`). Parts of the behaviour follow Berkeley's GPL-licensed
SETI@home/BOINC graphics code.

---
Not affiliated with UC Berkeley or the SETI@home project.
