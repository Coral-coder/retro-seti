# Retro SETI

A tribute to the classic (v3.x, 1999–2005) SETI@home screensaver. The layout, purple frame,
fonts, palette and the red-to-cyan 3D power/frequency/time graph are matched against
screenshots of the original v3.07 client: Data Analysis (activity, Doppler drift rate,
resolution, pulse/gaussian/peak readout, red mini-graph, 3D tube progress bar), Data Info,
User Info, and the graph that sweeps front-to-back for each FFT pass. Data units complete,
"send" and get replaced. **All data is simulated.** Nothing is downloaded or uploaded. The
globe/wave logo and dish are redrawn, not copied from the original.

## Web version (GitHub Pages)

`web/` is a dependency-free static page (`index.html` + `seti.js`, canvas-rendered).

- **Keeps the display awake** using the Screen Wake Lock API (with a muted-video fallback for
  browsers without it). The *Display awake* button toggles it; the browser releases the lock
  when the tab is hidden and the page re-takes it when you come back.
- **F1**: info box · **F** or double-click: fullscreen · **N**: set your name
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
| `RetroSETI.scr /c` | Settings: name, minutes per data unit, reset stats |
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

---
Not affiliated with UC Berkeley or the SETI@home project.
