// Hosts the Retro SETI web displays (the same files as the website) in WebView2, the
// Edge/Chromium engine built into Windows 10/11. Everything the website does (all displays,
// the live NASA DSN / SDO / EPIC / NOAA feeds, the SDO video) then works in the screensaver.
//
// The .scr stays a single file: the web app, the WebView2 SDK's managed DLLs and its native
// loader are embedded as resources and unpacked to %LOCALAPPDATA%\RetroSETI on first run.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace RetroSeti
{
    /// <summary>Unpacking and assembly loading. No WebView2 types here, so it is safe to call first.</summary>
    static class WebBoot
    {
        static readonly Assembly Me = typeof(WebBoot).Assembly;
        public static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RetroSETI");
        public static string WebFolder;
        public static string LoaderFolder;

        public static bool Init()
        {
            try
            {
                string stamp = Me.ManifestModule.ModuleVersionId.ToString("N").Substring(0, 12);
                AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
                {
                    string name = new AssemblyName(e.Name).Name + ".dll";
                    using (var st = Me.GetManifestResourceStream("lib/" + name))
                    {
                        if (st == null) return null;
                        var buf = new byte[st.Length];
                        st.Read(buf, 0, buf.Length);
                        return Assembly.Load(buf);
                    }
                };
                // the web app, unpacked once per build
                WebFolder = Path.Combine(Root, "web-" + stamp);
                if (!File.Exists(Path.Combine(WebFolder, "index.html")))
                {
                    foreach (var res in Me.GetManifestResourceNames().Where(n => n.StartsWith("web/")))
                        Extract(res, Path.Combine(WebFolder, res.Substring(4).Replace('\\', '/').Replace('/', Path.DirectorySeparatorChar)));
                    CleanOld("web-", stamp);
                }
                Extract("notices/THIRD-PARTY-NOTICES.txt", Path.Combine(Root, "THIRD-PARTY-NOTICES.txt"));
                // the native WebView2 loader for this process's architecture
                string arch = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "arm64" : Environment.Is64BitProcess ? "x64" : "x86";
                LoaderFolder = Path.Combine(Root, "bin-" + stamp, arch);
                string loader = Path.Combine(LoaderFolder, "WebView2Loader.dll");
                if (!File.Exists(loader)) { Extract($"native/{arch}/WebView2Loader.dll", loader); CleanOld("bin-", stamp); }
                return File.Exists(Path.Combine(WebFolder, "index.html")) && File.Exists(loader);
            }
            catch { return false; }
        }

        static void Extract(string resource, string path)
        {
            using (var st = Me.GetManifestResourceStream(resource))
            {
                if (st == null) return;
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                using (var f = File.Create(path)) st.CopyTo(f);
            }
        }

        static void CleanOld(string prefix, string keep)
        {
            try
            {
                foreach (var d in Directory.GetDirectories(Root, prefix + "*"))
                    if (!d.EndsWith(prefix + keep)) Directory.Delete(d, true);
            }
            catch { /* another copy may be running */ }
        }
    }

    /// <summary>Everything that touches WebView2 types (only called after WebBoot.Init).</summary>
    static class WebHost
    {
        const string Host = "retroseti.app";
        static Microsoft.Web.WebView2.Core.CoreWebView2Environment env;

        public static bool Available()
        {
            try
            {
                Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(WebBoot.LoaderFolder);
                return !string.IsNullOrEmpty(Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString());
            }
            catch { return false; }
        }

        static async System.Threading.Tasks.Task<Microsoft.Web.WebView2.Core.CoreWebView2Environment> Env()
        {
            if (env != null) return env;
            var opts = new Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
            env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, Path.Combine(WebBoot.Root, "WebView2"), opts);
            return env;
        }

        sealed class PageForm : Form
        {
            readonly Microsoft.Web.WebView2.WinForms.WebView2 view;
            readonly bool screensaver;

            public PageForm(bool screensaver, Rectangle bounds, string query)
            {
                this.screensaver = screensaver;
                Text = "Retro SETI";
                BackColor = Color.Black;
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
                    Size = new Size(Math.Min(1500, bounds.Width - 80), Math.Min(900, bounds.Height - 80));
                    Location = new Point(bounds.Left + (bounds.Width - Width) / 2, bounds.Top + (bounds.Height - Height) / 2);
                    KeyPreview = true;
                }
                view = new Microsoft.Web.WebView2.WinForms.WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
                Controls.Add(view);
                Load += async (s, e) =>
                {
                    try
                    {
                        await view.EnsureCoreWebView2Async(await Env());
                        var cw = view.CoreWebView2;
                        cw.SetVirtualHostNameToFolderMapping(Host, WebBoot.WebFolder, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
                        cw.Settings.AreDefaultContextMenusEnabled = !screensaver;
                        cw.Settings.AreDevToolsEnabled = false;
                        cw.Settings.IsZoomControlEnabled = false;
                        cw.Settings.IsStatusBarEnabled = false;
                        cw.WebMessageReceived += (o, m) => { if (screensaver && m.TryGetWebMessageAsString() == "exit") Application.Exit(); };
                        cw.ContainsFullScreenElementChanged += (o, m) => ToggleFullscreen(cw.ContainsFullScreenElement);
                        cw.Navigate($"https://{Host}/index.html?{query}");
                    }
                    catch (Exception ex)
                    {
                        if (!screensaver) MessageBox.Show(this, "Couldn't start the web view:\n" + ex.Message, Text);
                        Close();
                    }
                };
            }

            bool fullscreen; FormWindowState prevState; Rectangle prevBounds;
            void ToggleFullscreen(bool on)
            {
                if (screensaver || on == fullscreen) return;
                fullscreen = on;
                if (on) { prevState = WindowState; prevBounds = Bounds; WindowState = FormWindowState.Normal; FormBorderStyle = FormBorderStyle.None; Bounds = Screen.FromControl(this).Bounds; }
                else { FormBorderStyle = FormBorderStyle.Sizable; Bounds = prevBounds; WindowState = prevState; }
            }

            protected override void OnKeyDown(KeyEventArgs e)
            {
                base.OnKeyDown(e);
                if (!screensaver && e.KeyCode == Keys.F11) ToggleFullscreen(!fullscreen);
            }

            protected override void OnFormClosed(FormClosedEventArgs e)
            {
                base.OnFormClosed(e);
                if (!screensaver || Application.OpenForms.Count == 0) Application.Exit();
            }
        }

        /// <summary>Full screen on every monitor, exits on input. Returns false if WebView2 couldn't be used.</summary>
        public static bool RunScreensaver(Action keepAwake)
        {
            var forms = Screen.AllScreens.Select((s, i) => (Form)new PageForm(true, s.Bounds, "scr=1")).ToList();
            var timer = new Timer { Interval = 30000 };
            timer.Tick += (o, e) => keepAwake();
            timer.Start();
            foreach (var f in forms.Skip(1)) f.Show();
            Application.Run(forms[0]);
            timer.Stop();
            return true;
        }

        /// <summary>The page in a normal window. settings: open its Settings panel straight away.</summary>
        public static void RunWindow(bool settings, Action keepAwake)
        {
            var timer = new Timer { Interval = 30000 };
            timer.Tick += (o, e) => keepAwake();
            timer.Start();
            Application.Run(new PageForm(false, Screen.PrimaryScreen.WorkingArea, settings ? "settings=1" : ""));
            timer.Stop();
        }
    }
}
