// GDI+ renderer. Layout mirrors web/seti.js (virtual 1600x1000 canvas, letterboxed).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;

namespace RetroSeti
{
    static class Renderer
    {
        const float VW = 1600, VH = 1000;
        const int Levels = 64;
        const string FontName = "Verdana";

        static readonly Color CPanel = Color.FromArgb(235, 0, 8, 40), CBorder = Color.FromArgb(0x3d, 0x5a, 0xa0),
            CTitle = Color.FromArgb(0xff, 0xd0, 0x40), CTitleBar = Color.FromArgb(0x0b, 0x1d, 0x5c),
            CLabel = Color.FromArgb(0x8f, 0xa8, 0xe8), CValue = Color.White, CDim = Color.FromArgb(0x5b, 0x6f, 0xa8),
            CRed = Color.FromArgb(0xff, 0x3a, 0x2a), CPlot = Color.FromArgb(0, 4, 24);

        static readonly (double t, int r, int g, int b)[] Stops =
        {
            (0, 20, 40, 200), (0.22, 0, 150, 255), (0.42, 0, 215, 90),
            (0.62, 240, 235, 0), (0.8, 255, 130, 0), (1, 255, 25, 25),
        };

        static readonly SolidBrush[] Front = new SolidBrush[Levels], Top = new SolidBrush[Levels], Side = new SolidBrush[Levels];
        static readonly Dictionary<(float, bool), Font> Fonts = new Dictionary<(float, bool), Font>();
        static readonly Dictionary<Color, SolidBrush> Brushes = new Dictionary<Color, SolidBrush>();
        static readonly StringFormat Fmt = (StringFormat)StringFormat.GenericTypographic.Clone();
        static readonly PointF[] Quad = new PointF[4];

        static Renderer()
        {
            for (int i = 0; i < Levels; i++)
            {
                var c = Heat(i / (double)(Levels - 1));
                Front[i] = new SolidBrush(Shade(c, 0.85));
                Top[i] = new SolidBrush(Shade(c, 1.25));
                Side[i] = new SolidBrush(Shade(c, 0.55));
            }
            Fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
        }

        static Color Heat(double t)
        {
            t = Math.Max(0, Math.Min(1, t));
            for (int i = 1; i < Stops.Length; i++)
            {
                if (t <= Stops[i].t)
                {
                    var a = Stops[i - 1]; var b = Stops[i];
                    double f = (t - a.t) / (b.t - a.t);
                    return Color.FromArgb((int)Math.Round(a.r + (b.r - a.r) * f), (int)Math.Round(a.g + (b.g - a.g) * f), (int)Math.Round(a.b + (b.b - a.b) * f));
                }
            }
            var l = Stops[Stops.Length - 1];
            return Color.FromArgb(l.r, l.g, l.b);
        }

        static Color Shade(Color c, double k) =>
            Color.FromArgb(Math.Min(255, (int)Math.Round(c.R * k)), Math.Min(255, (int)Math.Round(c.G * k)), Math.Min(255, (int)Math.Round(c.B * k)));

        static Font F(float px, bool bold = false)
        {
            if (!Fonts.TryGetValue((px, bold), out var f))
                Fonts[(px, bold)] = f = new Font(FontName, px, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
            return f;
        }

        static SolidBrush B(Color c)
        {
            if (!Brushes.TryGetValue(c, out var b)) Brushes[c] = b = new SolidBrush(c);
            return b;
        }

        static int Level(double v) => Math.Max(0, Math.Min(Levels - 1, (int)Math.Floor(v * Levels)));

        // ---- text, positioned by baseline like canvas fillText ----
        enum Align { Left, Center, Right }

        static void Text(Graphics g, string s, float x, float baseline, float px, Color c, bool bold = false, Align align = Align.Left)
        {
            var f = F(px, bold);
            float ascent = px * f.FontFamily.GetCellAscent(f.Style) / f.FontFamily.GetEmHeight(f.Style);
            float w = align == Align.Left ? 0 : g.MeasureString(s, f, PointF.Empty, Fmt).Width;
            float dx = align == Align.Center ? -w / 2 : align == Align.Right ? -w : 0;
            g.DrawString(s, f, B(c), x + dx, baseline - ascent, Fmt);
        }

        static void Kv(Graphics g, float x, float y, string label, string value, float labelW = 150)
        {
            Text(g, label, x, y, 16, CLabel);
            Text(g, value, x + labelW, y, 16, CValue);
        }

        static void Panel(Graphics g, float x, float y, float w, float h, string title)
        {
            g.FillRectangle(B(CPanel), x, y, w, h);
            g.FillRectangle(B(CTitleBar), x, y, w, 30);
            using (var p = new Pen(CBorder, 2))
            {
                g.DrawRectangle(p, x + 1, y + 1, w - 2, h - 2);
                g.DrawLine(p, x, y + 30, x + w, y + 30);
            }
            Text(g, title, x + 12, y + 22, 17, CTitle, true);
        }

        static string Pad(double n) => ((int)Math.Floor(n)).ToString("00");

        static string FmtDuration(double sec)
        {
            int h = (int)(sec / 3600), m = (int)(sec / 60) % 60;
            double s = sec % 60;
            return $"{h} hr {m:00} min {s.ToString("00.0", CultureInfo.InvariantCulture)} sec";
        }

        // ---- frame ----
        public static void Draw(Graphics g, int cw, int ch)
        {
            g.ResetTransform();
            g.Clear(Color.Black);
            float s = Math.Min(cw / VW, ch / VH);
            g.TranslateTransform((cw - VW * s) / 2, (ch - VH * s) / 2);
            g.ScaleTransform(s, s);
            g.TextRenderingHint = s < 0.4f ? TextRenderingHint.SingleBitPerPixelGridFit : TextRenderingHint.AntiAliasGridFit;
            g.SmoothingMode = SmoothingMode.None;

            DrawHeader(g);
            if (Settings.ShowPanels)
            {
                DrawAnalysis(g, 20, 76, 600, 262);
                DrawDataInfo(g, 636, 76, 468, 262);
                DrawUserInfo(g, 1120, 76, 460, 262);
                DrawGraph(g, 20, 354, 1064, 626);
                DrawGaussian(g, 1100, 354, 480, 305);
                DrawSpike(g, 1100, 675, 480, 305);
            }
            else DrawGraph(g, 20, 76, 1560, 904);
            DrawOverlay(g);
        }

        static void DrawHeader(Graphics g)
        {
            Text(g, "RETRO", 24, 50, 34, CTitle, true);
            float w = g.MeasureString("RETRO ", F(34, true), PointF.Empty, Fmt).Width;
            Text(g, "SETI", 24 + w, 50, 34, CRed, true);
            float w2 = g.MeasureString("SETI", F(34, true), PointF.Empty, Fmt).Width;
            Text(g, "Search for Extraterrestrial Intelligence  •  classic screensaver tribute", 24 + w + w2 + 14, 47, 15, CDim);
            Text(g, DateTime.Now.ToString("ddd, MMM d, h:mm:ss tt"), VW - 24, 46, 16, CLabel, false, Align.Right);
        }

        static void DrawAnalysis(Graphics g, float x, float y, float w, float h)
        {
            Panel(g, x, y, w, h, "Data Analysis");
            var wu = Sim.Wu;
            var st = Sim.State(wu.P);
            string act = Sim.Phase == Phase.Sending ? "Work unit complete — sending results"
                : Sim.Phase == Phase.Receiving ? "Receiving new work unit" : st.Act;
            act += new string('.', 1 + (int)(Environment.TickCount / 400 % 3));
            Text(g, act, x + 16, y + 64, 20, CTitle, true);
            bool an = Sim.Phase == Phase.Analyze;
            Kv(g, x + 16, y + 98, "Chirp rate:", an ? st.Chirp.ToString("0.0000", CultureInfo.InvariantCulture) + " Hz/sec" : "—");
            Kv(g, x + 16, y + 124, "FFT length:", an && st.Fft != 0 ? st.Fft.ToString() : "—");
            Kv(g, x + 16, y + 150, "CPU time:", FmtDuration(wu.Cpu));
            Kv(g, x + 16, y + 176, "Work unit:", wu.Name);

            float bx = x + 16, by = y + h - 46, bw = w - 32 - 110, bh = 22;
            g.FillRectangle(B(CPlot), bx, by, bw, bh);
            if (wu.P > 0.001)
            {
                using (var lg = new LinearGradientBrush(new PointF(bx - 1, 0), new PointF(bx + bw + 1, 0), Color.FromArgb(0x14, 0x28, 0xc8), Color.FromArgb(0, 0xdc, 0x5a)))
                {
                    lg.InterpolationColors = new ColorBlend
                    {
                        Colors = new[] { Color.FromArgb(0x14, 0x28, 0xc8), Color.FromArgb(0, 0xa0, 0xff), Color.FromArgb(0, 0xdc, 0x5a) },
                        Positions = new[] { 0f, 0.5f, 1f },
                    };
                    g.FillRectangle(lg, bx, by, (float)(bw * wu.P), bh);
                }
            }
            using (var p = new Pen(CBorder)) g.DrawRectangle(p, bx, by, bw - 1, bh - 1);
            Text(g, (wu.P * 100).ToString("0.000", CultureInfo.InvariantCulture) + "%", x + w - 16, by + 18, 18, CValue, true, Align.Right);
        }

        static void DrawDataInfo(Graphics g, float x, float y, float w, float h)
        {
            Panel(g, x, y, w, h, "Data Info");
            var wu = Sim.Wu;
            var d = Sim.JdToDate(wu.Jd);
            int rh = (int)wu.Ra, rm = (int)((wu.Ra - rh) * 60), rs = (int)(((wu.Ra - rh) * 60 - rm) * 60);
            var ci = CultureInfo.InvariantCulture;
            Kv(g, x + 16, y + 64, "From:", $"{rh} hr {rm:00} min {rs:00} sec RA", 130);
            Kv(g, x + 16, y + 90, "", (wu.Dec >= 0 ? "+" : "") + wu.Dec.ToString("0.00", ci) + " Dec", 130);
            Kv(g, x + 16, y + 120, "Recorded on:", wu.Jd.ToString("0.00000", ci), 130);
            Kv(g, x + 16, y + 146, "", d.ToString("ddd, dd MMM yyyy HH:mm:ss", ci) + " UTC", 130);
            Kv(g, x + 16, y + 176, "Source:", "Arecibo Radio Observatory", 130);
            Kv(g, x + 16, y + 206, "Base freq.:", (wu.BaseHz / 1e9).ToString("0.000000000", ci) + " GHz", 130);
            Kv(g, x + 16, y + 236, "Angle range:", wu.Angle.ToString("0.000", ci), 130);
        }

        static void DrawUserInfo(Graphics g, float x, float y, float w, float h)
        {
            Panel(g, x, y, w, h, "User Info");
            string name = Settings.Name.Length > 28 ? Settings.Name.Substring(0, 28) : Settings.Name;
            Kv(g, x + 16, y + 64, "Name:", name, 160);
            Kv(g, x + 16, y + 94, "Work units:", Settings.Wus.ToString("N0"), 160);
            int hrs = (int)(Settings.Cpu / 3600), mins = (int)(Settings.Cpu / 60) % 60;
            Kv(g, x + 16, y + 124, "Total CPU time:", $"{hrs:N0} hr {mins:00} min", 160);
            string avg = "—";
            if (Settings.Wus > 0)
            {
                double a = Settings.Cpu / Settings.Wus;
                avg = $"{(int)(a / 3600)} hr {(int)(a / 60) % 60:00} min {(int)(a % 60):00} sec";
            }
            Kv(g, x + 16, y + 154, "Avg per unit:", avg, 160);
            Kv(g, x + 16, y + 184, "Listening since:", Settings.Since.ToShortDateString(), 160);
            Text(g, "Simulated data — no real signals were harmed.", x + 16, y + h - 18, 13, CDim);
        }

        static void DrawGraph(Graphics g, float x, float y, float w, float h)
        {
            Panel(g, x, y, w, h, "Power vs. Frequency vs. Time");
            const int NF = Sim.NF, NT = Sim.NT;
            const float DX = 6.6f, DY = 5.6f;
            float left = x + 70, baseY = y + h - 70;
            float cw = (w - 110 - NT * DX) / NF;
            float bw = cw * 0.72f;
            float maxH = baseY - (y + 50) - NT * DY;
            float fw = NF * cw;
            float ddx = DX * 0.7f, ddy = DY * 0.7f;

            // floor
            using (var floor = new SolidBrush(Color.FromArgb(89, 20, 40, 110)))
                g.FillPolygon(floor, new[] { new PointF(left, baseY), new PointF(left + fw, baseY), new PointF(left + fw + NT * DX, baseY - NT * DY), new PointF(left + NT * DX, baseY - NT * DY) });
            using (var grid = new Pen(Color.FromArgb(115, 80, 110, 190)))
            {
                for (int i = 0; i <= NF; i += 6) g.DrawLine(grid, left + i * cw, baseY, left + i * cw + NT * DX, baseY - NT * DY);
                for (int t = 0; t <= NT; t += 5) g.DrawLine(grid, left + t * DX, baseY - t * DY, left + fw + t * DX, baseY - t * DY);
            }
            using (var wall = new Pen(Color.FromArgb(56, 80, 110, 190)))
            {
                float bwx = left + NT * DX, bwy = baseY - NT * DY;
                for (int k = 0; k <= 4; k++) g.DrawLine(wall, bwx, bwy - maxH * k / 4, bwx + fw, bwy - maxH * k / 4);
                g.DrawLine(wall, bwx, bwy, bwx, bwy - maxH);
            }

            // bars: back to front, left to right
            float frac = (float)(Sim.RowAcc % 1);
            var rows = Sim.Rows;
            for (int t = rows.Count - 1; t >= 0; t--)
            {
                float tt = t + frac;
                if (tt > NT - 0.5f) continue;
                var row = rows[t];
                float ox = left + tt * DX, oy = baseY - tt * DY;
                for (int i = 0; i < NF; i++)
                {
                    double v = 1 - Math.Exp(-row[i] / 5.5);
                    float hg = Math.Max(1.5f, (float)(v * maxH));
                    int lv = Level(v);
                    float bx = ox + i * cw, by = oy;
                    Quad[0] = new PointF(bx + bw, by); Quad[1] = new PointF(bx + bw + ddx, by - ddy);
                    Quad[2] = new PointF(bx + bw + ddx, by - hg - ddy); Quad[3] = new PointF(bx + bw, by - hg);
                    g.FillPolygon(Side[lv], Quad);
                    Quad[0] = new PointF(bx, by - hg); Quad[1] = new PointF(bx + bw, by - hg);
                    Quad[2] = new PointF(bx + bw + ddx, by - hg - ddy); Quad[3] = new PointF(bx + ddx, by - hg - ddy);
                    g.FillPolygon(Top[lv], Quad);
                    g.FillRectangle(Front[lv], bx, by - hg, bw, hg);
                }
            }

            // labels
            Text(g, "Frequency →", left + fw / 2, baseY + 30, 15, CLabel, false, Align.Center);
            var st = g.Save();
            g.TranslateTransform(left + fw + NT * DX / 2 + 26, baseY - NT * DY / 2 + 10);
            g.RotateTransform((float)(-Math.Atan2(DY, DX) * 180 / Math.PI));
            Text(g, "← Time", 0, 0, 15, CLabel, false, Align.Center);
            g.Restore(st);
            st = g.Save();
            g.TranslateTransform(left - 26, baseY - maxH / 2);
            g.RotateTransform(-90);
            Text(g, "Power →", 0, 0, 15, CLabel, false, Align.Center);
            g.Restore(st);
            var ci = CultureInfo.InvariantCulture;
            Text(g, (Sim.Wu.BaseHz / 1e9).ToString("0.000000", ci) + " GHz", left, baseY + 52, 13, CDim);
            Text(g, "+" + (NF * 9765.625 / 1000 / 4).ToString("0.0", ci) + " kHz", left + fw, baseY + 52, 13, CDim, false, Align.Right);

            // colour legend
            float lx = x + w - 40, ly = y + 50, lh = 140;
            for (int k = 0; k < lh; k++) g.FillRectangle(B(Heat(1 - k / lh)), lx, ly + k, 14, 1);
            using (var p = new Pen(CBorder)) g.DrawRectangle(p, lx - 0.5f, ly - 0.5f, 15, lh + 1);
        }

        static void PlotFrame(Graphics g, float x, float y, float w, float h)
        {
            g.FillRectangle(B(CPlot), x, y, w, h);
            using (var p = new Pen(Color.FromArgb(64, 80, 110, 190)))
                for (int k = 1; k < 4; k++) g.DrawLine(p, x, y + h * k / 4, x + w, y + h * k / 4);
            using (var p = new Pen(CBorder)) g.DrawRectangle(p, x, y, w - 1, h - 1);
        }

        static void DrawGaussian(Graphics g, float x, float y, float w, float h)
        {
            Panel(g, x, y, w, h, "Best Gaussian");
            var bg = Sim.Wu.BestGauss;
            float px = x + 16, py = y + 44, pw = w - 32, ph = h - 130;
            PlotFrame(g, px, py, pw, ph);
            if (bg == null)
            {
                Text(g, "No gaussians found yet", px + pw / 2, py + ph / 2, 15, CDim, false, Align.Center);
                return;
            }
            int n = bg.Samples.Length;
            double maxV = bg.Amp + 1.5;
            foreach (var sv in bg.Samples) maxV = Math.Max(maxV, sv);
            maxV *= 1.08;
            float sw = pw / n;
            for (int i = 0; i < n; i++)
            {
                double v = bg.Samples[i] / maxV;
                float bh = (float)(v * (ph - 4));
                g.FillRectangle(Front[Level(Math.Min(0.999, v))], px + i * sw + 1, py + ph - bh - 2, Math.Max(1, sw - 2), bh);
            }
            var pts = new PointF[121];
            for (int k = 0; k <= 120; k++)
            {
                double i = k / 120.0 * n, c = bg.Len / 2.0;
                double v = (1.2 + bg.Amp * Math.Exp(-0.5 * Math.Pow((i - c) / bg.Sigma, 2))) / maxV;
                pts[k] = new PointF((float)(px + i * sw), (float)(py + ph - 2 - v * (ph - 4)));
            }
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var p = new Pen(CRed, 2.5f)) g.DrawLines(p, pts);
            g.SmoothingMode = SmoothingMode.None;
            var ci = CultureInfo.InvariantCulture;
            Kv(g, px, y + h - 54, "Power:", bg.Power.ToString("0.000", ci), 70);
            Kv(g, px + pw / 2, y + h - 54, "Fit:", bg.Fit.ToString("0.000", ci), 50);
            Kv(g, px, y + h - 26, "Score:", bg.Score.ToString("0.000", ci), 70);
            Kv(g, px + pw / 2, y + h - 26, "Chirp:", bg.Chirp.ToString("0.000", ci), 60);
        }

        static void DrawSpike(Graphics g, float x, float y, float w, float h)
        {
            Panel(g, x, y, w, h, "Best Spike");
            var s = Sim.Wu.BestSpike;
            float px = x + 16, py = y + 44, pw = w - 32, ph = h - 130;
            PlotFrame(g, px, py, pw, ph);
            if (s == null) return;
            double maxV = s.Power * 1.08;
            float sw = pw / Sim.NF;
            for (int i = 0; i < Sim.NF; i++)
            {
                float bh = (float)(s.Spectrum[i] / maxV * (ph - 4));
                g.FillRectangle(B(i == s.Bin ? CRed : Color.FromArgb(0, 0x90, 0xee)), px + i * sw + 1, py + ph - bh - 2, Math.Max(1, sw - 2), bh);
            }
            var ci = CultureInfo.InvariantCulture;
            Kv(g, px, y + h - 54, "Power:", s.Power.ToString("0.000", ci), 70);
            Kv(g, px + pw / 2, y + h - 54, "FFT len:", s.Fft.ToString(), 80);
            Kv(g, px, y + h - 26, "Freq:", (s.Freq >= 0 ? "+" : "") + s.Freq.ToString("0.00", ci) + " Hz", 70);
            Kv(g, px + pw / 2, y + h - 26, "Chirp:", s.Chirp.ToString("0.000", ci), 80);
        }

        static void DrawOverlay(Graphics g)
        {
            if (Sim.Phase == Phase.Analyze) return;
            string msg = Sim.Phase == Phase.Sending ? "Sending results to the server..." : "Receiving a new work unit...";
            float t = (float)Math.Min(1, Sim.PhaseT / 4);
            float w = 640, h = 130, x = (VW - w) / 2, y = 470;
            g.FillRectangle(B(Color.FromArgb(242, 0, 6, 30)), x, y, w, h);
            using (var p = new Pen(CTitle, 2)) g.DrawRectangle(p, x, y, w, h);
            Text(g, msg, VW / 2, y + 52, 24, CTitle, true, Align.Center);
            g.FillRectangle(B(CPlot), x + 40, y + 76, w - 80, 20);
            g.FillRectangle(B(Color.FromArgb(0, 0xdc, 0x5a)), x + 40, y + 76, (w - 80) * t, 20);
            using (var p = new Pen(CBorder)) g.DrawRectangle(p, x + 40, y + 76, w - 81, 19);
        }
    }
}
