using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RetroSeti
{
    /// <summary>Settings and lifetime stats, stored in HKCU\Software\RetroSETI.</summary>
    static class Settings
    {
        const string Key = @"Software\RetroSETI";
        public static string Name = "anonymous";
        public static int Wus;
        public static double Cpu;
        public static DateTime Since = DateTime.Now;

        // ---- speeds (same names, defaults and limits as the web Settings window) ----
        public static double WuMinutes = 15;      // length of one simulated data unit
        public static double StepSeconds = 20;    // one (drift rate, FFT length) analysis pass
        public static double GrowSeconds = 6;     // 3D graph grows in row by row
        public static double HoldSeconds = 4;     // 3D graph holds before the next array
        public static double SignalSeconds = 8;   // each best signal is shown this long
        /// <summary>"classic" = random lean per graph (as 3.08 did), "rock" = sweeps side to side, "fixed".</summary>
        public static string GraphAngle = "classic";
        public static readonly string[] GraphAngles = { "classic", "rock", "fixed" };
        public static readonly string[] GraphAngleLabels =
        {
            "Classic: random lean for each new graph (as 3.08 did)",
            "Rock: lean sweeps slowly left and right, graph by graph",
            "Fixed: always the v3.07 screenshot angle",
        };

        public sealed class Speed
        {
            public string Key, Label, Unit;
            public double Min, Max, Step, Default;
            public Func<double> Get;
            public Action<double> Set;
        }

        public static readonly Speed[] Speeds =
        {
            new Speed { Key = "WuMinutes", Label = "Data unit length", Unit = "min", Min = 1, Max = 600, Step = 1, Default = 15, Get = () => WuMinutes, Set = v => WuMinutes = v },
            new Speed { Key = "StepSeconds", Label = "Analysis step (per FFT pass)", Unit = "s", Min = 5, Max = 60, Step = 1, Default = 20, Get = () => StepSeconds, Set = v => StepSeconds = v },
            new Speed { Key = "GrowSeconds", Label = "Graph grow time", Unit = "s", Min = 1, Max = 20, Step = 0.5, Default = 6, Get = () => GrowSeconds, Set = v => GrowSeconds = v },
            new Speed { Key = "HoldSeconds", Label = "Graph hold time", Unit = "s", Min = 0, Max = 20, Step = 0.5, Default = 4, Get = () => HoldSeconds, Set = v => HoldSeconds = v },
            new Speed { Key = "SignalSeconds", Label = "Signal display time", Unit = "s", Min = 2, Max = 30, Step = 1, Default = 8, Get = () => SignalSeconds, Set = v => SignalSeconds = v },
        };

        /// <summary>User-chosen title logo; the title becomes "S.E.T.I. @ {logo}" when it exists.</summary>
        public static string LogoPath => System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RetroSETI", "logo.png");

        public static void Load()
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(Key))
                {
                    Name = k.GetValue("Name", Name) as string ?? Name;
                    foreach (var sp in Speeds)
                        sp.Set(Math.Max(sp.Min, Math.Min(sp.Max, ParseD(k.GetValue(sp.Key), sp.Default))));
                    var ga = k.GetValue("GraphAngle") as string;
                    if (Array.IndexOf(GraphAngles, ga) >= 0) GraphAngle = ga;
                    Wus = (int)ParseD(k.GetValue("Wus"), 0);
                    Cpu = ParseD(k.GetValue("Cpu"), 0);
                    var s = k.GetValue("Since") as string;
                    if (s != null && long.TryParse(s, out var ticks)) Since = new DateTime(ticks);
                    else k.SetValue("Since", Since.Ticks.ToString(CultureInfo.InvariantCulture));
                }
            }
            catch { /* run with defaults */ }
        }

        static double ParseD(object o, double d) =>
            o != null && double.TryParse(o.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : d;

        public static void SaveSettings()
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(Key))
                {
                    k.SetValue("Name", Name);
                    foreach (var sp in Speeds) k.SetValue(sp.Key, sp.Get().ToString(CultureInfo.InvariantCulture));
                    k.SetValue("GraphAngle", GraphAngle);
                }
            }
            catch { }
        }

        public static void SaveStats()
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(Key))
                {
                    k.SetValue("Wus", Wus.ToString(CultureInfo.InvariantCulture));
                    k.SetValue("Cpu", Cpu.ToString("R", CultureInfo.InvariantCulture));
                }
            }
            catch { }
        }
    }

    sealed class SettingsForm : Form
    {
        public SettingsForm()
        {
            Text = "Retro SETI Settings";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Font;
            Font = new Font("Segoe UI", 9f);

            int y = 16;
            var lblName = new Label { Text = "User name:", Location = new Point(16, y + 4), AutoSize = true };
            var txtName = new TextBox { Text = Settings.Name, Location = new Point(230, y), Width = 170, MaxLength = 40 };
            y += 40;

            // speeds
            var speedBox = new GroupBox { Text = "Speeds", Location = new Point(12, y), Width = 396 };
            var nums = new Dictionary<Settings.Speed, NumericUpDown>();
            int sy = 24;
            foreach (var sp in Settings.Speeds)
            {
                var lbl = new Label { Text = sp.Label + ":", Location = new Point(12, sy + 4), AutoSize = true };
                var num = new NumericUpDown
                {
                    Minimum = (decimal)sp.Min, Maximum = (decimal)sp.Max, Increment = (decimal)sp.Step,
                    DecimalPlaces = sp.Step < 1 ? 1 : 0, Value = (decimal)sp.Get(),
                    Location = new Point(250, sy), Width = 80, TextAlign = HorizontalAlignment.Right,
                };
                var unit = new Label { Text = sp.Unit, Location = new Point(336, sy + 4), AutoSize = true };
                speedBox.Controls.AddRange(new Control[] { lbl, num, unit });
                nums[sp] = num;
                sy += 30;
            }
            var lblAngle = new Label { Text = "Graph angle:", Location = new Point(12, sy + 4), AutoSize = true };
            var angle = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(100, sy), Width = 284 };
            angle.Items.AddRange(Settings.GraphAngleLabels);
            angle.SelectedIndex = Math.Max(0, Array.IndexOf(Settings.GraphAngles, Settings.GraphAngle));
            speedBox.Controls.AddRange(new Control[] { lblAngle, angle });
            sy += 32;
            var defaults = new Button { Text = "Default speeds", Location = new Point(12, sy + 2), Width = 120 };
            defaults.Click += (s, e) => { foreach (var kv in nums) kv.Value.Value = (decimal)kv.Key.Default; angle.SelectedIndex = 0; };
            speedBox.Controls.Add(defaults);
            speedBox.Height = sy + 40;
            y += speedBox.Height + 12;

            // logo
            var lblLogo = new Label { Location = new Point(16, y + 5), AutoSize = true };
            var chooseLogo = new Button { Text = "Choose logo…", Location = new Point(190, y), Width = 105 };
            var removeLogo = new Button { Text = "Remove logo", Location = new Point(301, y), Width = 100 };
            void RefreshLogo()
            {
                bool has = System.IO.File.Exists(Settings.LogoPath);
                lblLogo.Text = has ? "Title logo: custom" : "Title logo: classic";
                removeLogo.Enabled = has;
            }
            RefreshLogo();
            chooseLogo.Click += (s, e) =>
            {
                using (var dlg = new OpenFileDialog { Title = "Choose a logo for the title", Filter = "Images|*.png;*.jpg;*.jpeg;*.gif;*.bmp|All files|*.*" })
                {
                    if (dlg.ShowDialog(this) != DialogResult.OK) return;
                    try
                    {
                        using (var img = Image.FromFile(dlg.FileName))
                        {
                            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Settings.LogoPath));
                            using (var copy = new Bitmap(img)) copy.Save(Settings.LogoPath, System.Drawing.Imaging.ImageFormat.Png);
                        }
                    }
                    catch (Exception ex) { MessageBox.Show(this, "Couldn't use that image:\n" + ex.Message, Text); }
                    RefreshLogo();
                }
            };
            removeLogo.Click += (s, e) => { try { System.IO.File.Delete(Settings.LogoPath); } catch { } RefreshLogo(); };
            y += 40;

            var info = new Label
            {
                Text = "While running, Retro SETI keeps the display on and stops the PC going to sleep. " +
                       "Run \"RetroSETI.scr /w\" for a normal window (F11 = fullscreen).",
                Location = new Point(16, y), Size = new Size(390, 36), ForeColor = SystemColors.GrayText,
            };
            y += 46;

            var reset = new Button { Text = "Reset stats", Location = new Point(16, y), Width = 100 };
            var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Location = new Point(236, y), Width = 80 };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Location = new Point(324, y), Width = 80 };
            reset.Click += (s, e) =>
            {
                if (MessageBox.Show(this, "Reset work unit count and CPU time?", Text, MessageBoxButtons.YesNo) == DialogResult.Yes)
                { Settings.Wus = 0; Settings.Cpu = 0; Settings.SaveStats(); }
            };
            AcceptButton = ok; CancelButton = cancel;
            Controls.AddRange(new Control[] { lblName, txtName, speedBox, lblLogo, chooseLogo, removeLogo, info, reset, ok, cancel });
            ClientSize = new Size(420, y + 40);

            FormClosing += (s, e) =>
            {
                if (DialogResult != DialogResult.OK) return;
                Settings.Name = string.IsNullOrWhiteSpace(txtName.Text) ? "anonymous" : txtName.Text.Trim();
                foreach (var kv in nums) kv.Key.Set((double)kv.Value.Value);
                Settings.GraphAngle = Settings.GraphAngles[Math.Max(0, angle.SelectedIndex)];
                Settings.SaveSettings();
            };
        }
    }
}
