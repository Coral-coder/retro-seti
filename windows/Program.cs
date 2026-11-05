// Retro SETI Windows screensaver.
//   RetroSETI.scr /s          run fullscreen on every monitor (what Windows calls)
//   RetroSETI.scr /p <hwnd>   draw the little preview in Screen Saver Settings
//   RetroSETI.scr /c          settings dialog (also: no arguments)
//   RetroSETI.scr /w          run in a normal window (F11 = fullscreen, F1 = info)
// While running in /s or /w mode it keeps the display on and blocks sleep.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace RetroSeti
{
    static class Native
    {
        public const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;
        public const int GWL_STYLE = -16;
        public const int WS_CHILD = 0x40000000;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
        [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    }

    sealed class SaverForm : Form
    {
        readonly bool screensaver;
        Point? firstMouse;
        bool fullscreen;
        FormWindowState prevState;
        Rectangle prevBounds;

        public SaverForm(bool screensaver, Rectangle bounds)
        {
            this.screensaver = screensaver;
            Text = "Retro SETI";
            BackColor = Color.Black;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Opaque, true);
            KeyPreview = true;
            StartPosition = FormStartPosition.Manual;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            if (screensaver)
            {
                FormBorderStyle = FormBorderStyle.None;
                Bounds = bounds;
                TopMost = true;
                ShowInTaskbar = false;
                Cursor.Hide();
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                Size = new Size(1280, 800);
                Location = new Point(bounds.Left + (bounds.Width - 1280) / 2, bounds.Top + (bounds.Height - 800) / 2);
            }
        }

        protected override void OnPaint(PaintEventArgs e) => Renderer.Draw(e.Graphics, ClientSize.Width, ClientSize.Height);

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!screensaver) return;
            if (firstMouse == null) { firstMouse = e.Location; return; }
            if (Math.Abs(e.X - firstMouse.Value.X) > 8 || Math.Abs(e.Y - firstMouse.Value.Y) > 8) Application.Exit();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (screensaver) Application.Exit();
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            if (!screensaver) ToggleFullscreen();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (screensaver) { Application.Exit(); return; }
            if (e.KeyCode == Keys.F11 || e.KeyCode == Keys.F) ToggleFullscreen();
            else if (e.KeyCode == Keys.Escape && fullscreen) ToggleFullscreen();
            else if (e.KeyCode == Keys.F1) Renderer.ShowInfo = !Renderer.ShowInfo;
        }

        void ToggleFullscreen()
        {
            if (!fullscreen)
            {
                prevState = WindowState; prevBounds = Bounds;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).Bounds;
                fullscreen = true;
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                Bounds = prevBounds;
                WindowState = prevState;
                fullscreen = false;
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            Settings.SaveStats();
            if (!screensaver) Application.Exit();
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Settings.Load();

            // Windows passes e.g. "/s", "/p 1234", "/c:1234" (case varies).
            string mode = "/c";
            string arg2 = null;
            if (args.Length > 0)
            {
                string a = args[0].Trim().ToLowerInvariant();
                int colon = a.IndexOf(':');
                if (colon > 0) { arg2 = a.Substring(colon + 1); a = a.Substring(0, colon); }
                mode = a.Replace('-', '/');
                if (arg2 == null && args.Length > 1) arg2 = args[1];
            }

            switch (mode)
            {
                case "/s": Run(screensaver: true); break;
                case "/w": Run(screensaver: false); break;
                case "/p":
                    if (arg2 != null && long.TryParse(arg2, out var h)) RunPreview(new IntPtr(h));
                    break;
                default:
                    Application.Run(new SettingsForm());
                    break;
            }
        }

        static void KeepAwake(bool on) =>
            Native.SetThreadExecutionState(on
                ? Native.ES_CONTINUOUS | Native.ES_DISPLAY_REQUIRED | Native.ES_SYSTEM_REQUIRED
                : Native.ES_CONTINUOUS);

        static void Run(bool screensaver)
        {
            Sim.Init();
            var forms = new List<Form>();
            if (screensaver) foreach (var s in Screen.AllScreens) forms.Add(new SaverForm(true, s.Bounds));
            else forms.Add(new SaverForm(false, Screen.PrimaryScreen.WorkingArea));

            KeepAwake(true);
            var sw = Stopwatch.StartNew();
            double last = 0, awakeAcc = 0;
            var timer = new Timer { Interval = 33 };
            timer.Tick += (o, e) =>
            {
                double now = sw.Elapsed.TotalSeconds;
                double dt = Math.Min(0.25, now - last);
                last = now;
                Sim.Tick(dt);
                // re-assert every 30 s; some power policies need a nudge
                if ((awakeAcc += dt) > 30) { awakeAcc = 0; KeepAwake(true); }
                foreach (var f in forms) if (!f.IsDisposed) f.Invalidate();
            };
            foreach (var f in forms) f.Show();
            timer.Start();
            Application.Run(forms[0]);
            timer.Stop();
            KeepAwake(false);
            Settings.SaveStats();
        }

        static void RunPreview(IntPtr parent)
        {
            if (!Native.IsWindow(parent)) return;
            Sim.CountStats = false;
            Sim.Init();
            var f = new Form { FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false, BackColor = Color.Black, StartPosition = FormStartPosition.Manual };
            typeof(Control).GetProperty("DoubleBuffered", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).SetValue(f, true, null);
            f.Paint += (o, e) => Renderer.Draw(e.Graphics, f.ClientSize.Width, f.ClientSize.Height);
            f.HandleCreated += (o, e) =>
            {
                Native.SetParent(f.Handle, parent);
                Native.SetWindowLong(f.Handle, Native.GWL_STYLE, Native.GetWindowLong(f.Handle, Native.GWL_STYLE) | Native.WS_CHILD);
                Native.GetClientRect(parent, out var r);
                f.Location = Point.Empty;
                f.Size = new Size(r.Right - r.Left, r.Bottom - r.Top);
            };
            var sw = Stopwatch.StartNew();
            double last = 0;
            var timer = new Timer { Interval = 100 };
            timer.Tick += (o, e) =>
            {
                if (!Native.IsWindow(parent)) { Application.Exit(); return; }
                double now = sw.Elapsed.TotalSeconds;
                Sim.Tick(Math.Min(0.5, now - last));
                last = now;
                f.Invalidate();
            };
            timer.Start();
            Application.Run(f);
        }
    }
}
