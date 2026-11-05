using System;
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
        public static string Name = "Anonymous Listener";
        public static double WuMinutes = 15;
        public static bool ShowPanels = true;
        public static int Wus;
        public static double Cpu;
        public static DateTime Since = DateTime.Now;

        public static void Load()
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(Key))
                {
                    Name = k.GetValue("Name", Name) as string ?? Name;
                    WuMinutes = ParseD(k.GetValue("WuMinutes"), WuMinutes);
                    ShowPanels = ParseD(k.GetValue("ShowPanels"), 1) != 0;
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
                    k.SetValue("WuMinutes", WuMinutes.ToString(CultureInfo.InvariantCulture));
                    k.SetValue("ShowPanels", ShowPanels ? "1" : "0");
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
            ClientSize = new Size(380, 230);

            var lblName = new Label { Text = "User name:", Location = new Point(16, 20), AutoSize = true };
            var txtName = new TextBox { Text = Settings.Name, Location = new Point(150, 16), Width = 210, MaxLength = 40 };
            var lblWu = new Label { Text = "Minutes per work unit:", Location = new Point(16, 56), AutoSize = true };
            var numWu = new NumericUpDown { Minimum = 1, Maximum = 600, Value = (decimal)Math.Max(1, Math.Min(600, Settings.WuMinutes)), Location = new Point(150, 52), Width = 80 };
            var chkPanels = new CheckBox { Text = "Show info panels (H toggles while running)", Checked = Settings.ShowPanels, Location = new Point(16, 90), AutoSize = true };
            var info = new Label
            {
                Text = "While running, Retro SETI keeps the display on and stops the PC going to sleep.\n" +
                       "Run \"RetroSETI.scr /w\" for a normal window (F11 = fullscreen).",
                Location = new Point(16, 120), Size = new Size(350, 50), ForeColor = SystemColors.GrayText,
            };
            var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Location = new Point(196, 186), Width = 80 };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Location = new Point(284, 186), Width = 80 };
            var reset = new Button { Text = "Reset stats", Location = new Point(16, 186), Width = 100 };
            reset.Click += (s, e) =>
            {
                if (MessageBox.Show(this, "Reset work unit count and CPU time?", Text, MessageBoxButtons.YesNo) == DialogResult.Yes)
                { Settings.Wus = 0; Settings.Cpu = 0; Settings.SaveStats(); }
            };
            AcceptButton = ok; CancelButton = cancel;
            Controls.AddRange(new Control[] { lblName, txtName, lblWu, numWu, chkPanels, info, ok, cancel, reset });

            FormClosing += (s, e) =>
            {
                if (DialogResult != DialogResult.OK) return;
                Settings.Name = string.IsNullOrWhiteSpace(txtName.Text) ? "Anonymous Listener" : txtName.Text.Trim();
                Settings.WuMinutes = (double)numWu.Value;
                Settings.ShowPanels = chkPanels.Checked;
                Settings.SaveSettings();
            };
        }
    }
}
