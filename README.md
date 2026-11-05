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

## Windows screensaver

`windows/` is a native C# / GDI+ port of the same visuals that compiles to a single
`RetroSETI.scr` (.NET Framework 4.8, already part of Windows 10/11 — nothing to install).

Install: download `RetroSETI.scr` from the Pages site (or the workflow's artifact),
right-click it → **Install**, or copy it to `C:\Windows\System32`, then pick *Retro SETI* in
Screen Saver Settings.

| Command | What it does |
| --- | --- |
| `RetroSETI.scr /s` | Fullscreen on every monitor; mouse/keyboard exits |
| `RetroSETI.scr /w` | Normal window (F11 / double-click = fullscreen, F1 = info) |
| `RetroSETI.scr /c` | Settings: name, speeds (same as the web Settings window), title logo, reset stats |
| `RetroSETI.scr /p <hwnd>` | Little preview in Screen Saver Settings |

While running (`/s` or `/w`) it calls `SetThreadExecutionState(ES_DISPLAY_REQUIRED |
ES_SYSTEM_REQUIRED)` so the monitor won't power off and the PC won't go to standby. Use `/w`
when you want the visualizer up as an always-on display. Settings and stats live in
`HKCU\Software\RetroSETI`.

Because it's an unsigned download, Windows SmartScreen may warn on first run
(*More info → Run anyway*).

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
