// GDI+ renderer. Mirrors web/seti.js: virtual 1500x885 canvas (the original's aspect), letterboxed.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;

namespace RetroSeti
{
    static class Renderer
    {
        const float VW = 1500, VH = 885, GraphTop = 455;
        const int Levels = 16;
        const string BodyFont = "Arial", TitleFont = "Arial Black";
        static readonly CultureInfo CI = CultureInfo.InvariantCulture;

        static readonly Color Purple = Color.FromArgb(0x9a, 0x66, 0xf6), Green = Color.FromArgb(0x35, 0xde, 0xa7),
            White = Color.White, LineRed = Color.FromArgb(0xc8, 0x32, 0x32), Grey = Color.FromArgb(0xa0, 0xa0, 0xa0);

        const double Hue0 = 1.0, DHue = -0.5;    // red -> magenta -> blue -> cyan

        // per column, per height level: front / top / side brushes
        static readonly SolidBrush[,] Front = new SolidBrush[Sim.NF, Levels], Top = new SolidBrush[Sim.NF, Levels], Side = new SolidBrush[Sim.NF, Levels];
        static readonly Dictionary<(string, float, bool), Font> Fonts = new Dictionary<(string, float, bool), Font>();
        static readonly Dictionary<Color, SolidBrush> Brushes = new Dictionary<Color, SolidBrush>();
        static readonly StringFormat Fmt = (StringFormat)StringFormat.GenericTypographic.Clone();
        static readonly PointF[] Quad = new PointF[4];

        // graph geometry: front edge (232..1400, 848); depth runs up-left to (118..1286, 570)
        const float MaxH = 92;

        static Bitmap graphBmp;
        static int graphVersion = -1;
        static float graphScale;

        static Renderer()
        {
            for (int i = 0; i < Sim.NF; i++)
            {
                double hu = Hue0 + DHue * i / Sim.NF;
                if (hu < 0) hu += 1; if (hu > 1) hu -= 1;
                for (int l = 0; l < Levels; l++)
                {
                    var (r, g, bl) = HlsToRgb(hu, 0.5 + l / (double)(Levels - 1) / 2, 1);
                    Front[i, l] = new SolidBrush(Mul(r, g, bl, 0.82));
                    Top[i, l] = new SolidBrush(Mul(r, g, bl, 1.15));
                    Side[i, l] = new SolidBrush(Mul(r, g, bl, 0.4));
                }
            }
            Fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
        }

        static double HueToRgb(double m1, double m2, double h)
        {
            if (h < 0) h += 1; if (h > 1) h -= 1;
            if (6 * h < 1) return m1 + (m2 - m1) * h * 6;
            if (2 * h < 1) return m2;
            if (3 * h < 2) return m1 + (m2 - m1) * (2.0 / 3 - h) * 6;
            return m1;
        }

        static (double r, double g, double b) HlsToRgb(double h, double l, double s)
        {
            double m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
            return (HueToRgb(m1, m2, h + 1.0 / 3) * 255, HueToRgb(m1, m2, h) * 255, HueToRgb(m1, m2, h - 1.0 / 3) * 255);
        }

        static Color Mul(double r, double g, double b, double k) =>
            Color.FromArgb(C255(r * k), C255(g * k), C255(b * k));
        static int C255(double v) => (int)Math.Round(Math.Max(0, Math.Min(255, v)));

        static Font F(float px, bool bold = false, string fam = BodyFont)
        {
            if (!Fonts.TryGetValue((fam, px, bold), out var f))
            {
                try { f = new Font(fam, px, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel); }
                catch { f = new Font(FontFamily.GenericSansSerif, px, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel); }
                Fonts[(fam, px, bold)] = f;
            }
            return f;
        }

        static SolidBrush B(Color c)
        {
            if (!Brushes.TryGetValue(c, out var b)) Brushes[c] = b = new SolidBrush(c);
            return b;
        }

        enum Align { Left, Center, Right }

        // positioned by baseline, like canvas fillText
        static float Text(Graphics g, string s, float x, float baseline, float px, Color c, Align align = Align.Left, bool bold = false, string fam = BodyFont)
        {
            var f = F(px, bold, fam);
            float ascent = px * f.FontFamily.GetCellAscent(f.Style) / f.FontFamily.GetEmHeight(f.Style);
            float w = g.MeasureString(s, f, PointF.Empty, Fmt).Width;
            float dx = align == Align.Center ? -w / 2 : align == Align.Right ? -w : 0;
            g.DrawString(s, f, B(c), x + dx, baseline - ascent, Fmt);
            return w;
        }

        static GraphicsPath RoundRect(float x, float y, float w, float h, float r)
        {
            var p = new GraphicsPath();
            float d = r * 2;
            p.AddArc(x, y, d, d, 180, 90);
            p.AddArc(x + w - d, y, d, d, 270, 90);
            p.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            p.AddArc(x, y + h - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        static void FillRound(Graphics g, Brush b, float x, float y, float w, float h, float r)
        {
            using (var p = RoundRect(x, y, w, h, r)) g.FillPath(b, p);
        }

        static string Pad2(double n) => ((int)Math.Floor(n)).ToString("00");
        static string Hms(double c) =>
            $"{(int)(c / 3600)} hr {Pad2((c / 60) % 60)} min {(c % 60).ToString("00.0", CI)} sec";

        public static bool ShowInfo;
        public static string Url = "coral-coder.github.io/retro-seti";

        // ---- frame ----
        public static void Draw(Graphics g, int cw, int ch)
        {
            g.ResetTransform();
            g.Clear(Color.Black);
            if (cw < 2 || ch < 2) return;
            float s = Math.Min(cw / VW, ch / VH);
            float ox = (cw - VW * s) / 2, oy = (ch - VH * s) / 2;

            // 3D graph from cache (redrawn only when the data or size changes)
            bool rocked = UpdateAngle();
            if (rocked || graphVersion != Sim.GraphVersion || Math.Abs(graphScale - s) > 1e-4 || graphBmp == null)
            {
                RenderGraph(s);
                graphVersion = Sim.GraphVersion; graphScale = s;
            }
            g.DrawImageUnscaled(graphBmp, (int)Math.Round(ox), (int)Math.Round(oy + GraphTop * s));

            g.TranslateTransform(ox, oy);
            g.ScaleTransform(s, s);
            g.TextRenderingHint = s < 0.35f ? TextRenderingHint.SingleBitPerPixelGridFit : TextRenderingHint.AntiAliasGridFit;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            DrawHeader(g);
            DrawFrame(g);
            DrawAnalysis(g);
            DrawDataInfo(g);
            DrawUserInfo(g);
            DrawGraphLabels(g);
            DrawInfo(g);
        }

        static void DrawLogo(Graphics g)
        {
            using (var path = new GraphicsPath())
            {
                path.AddEllipse(23, 7, 62, 62);
                using (var pg = new PathGradientBrush(path)
                {
                    CenterPoint = new PointF(44, 30),
                    CenterColor = Color.FromArgb(0x9f, 0xf3, 0xff),
                    SurroundColors = new[] { Color.FromArgb(0x14, 0x30, 0x6a) },
                })
                {
                    pg.SetSigmaBellShape(0.6f);
                    g.FillPath(pg, path);
                }
            }
            using (var land = new SolidBrush(Color.FromArgb(190, 60, 200, 150)))
            {
                var st = g.Save();
                g.TranslateTransform(46, 30); g.RotateTransform(-29);
                g.FillEllipse(land, -12, -17, 24, 34);
                g.Restore(st);
                st = g.Save();
                g.TranslateTransform(66, 50); g.RotateTransform(23);
                g.FillEllipse(land, -8, -10, 16, 20);
                g.Restore(st);
            }
            var pts = new List<PointF>();
            for (int x = 70; x <= 250; x += 2)
            {
                double f = (x - 70) / 180.0;
                pts.Add(new PointF(x, (float)(38 - Math.Sin(f * Math.PI * 4.2) * (16 - f * 6))));
            }
            var arr = pts.ToArray();
            using (var b1 = new LinearGradientBrush(new PointF(69, 0), new PointF(251, 0), Color.FromArgb(255, 0x6a, 0x3f, 0xd0), Color.FromArgb(0, 110, 70, 220)))
            using (var p1 = new Pen(b1, 10) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                g.DrawLines(p1, arr);
            using (var b2 = new LinearGradientBrush(new PointF(69, 0), new PointF(251, 0), Color.FromArgb(255, 0xc9, 0xa8, 0xff), Color.FromArgb(0, 110, 70, 220)))
            using (var p2 = new Pen(b2, 3) { LineJoin = LineJoin.Round })
                g.DrawLines(p2, arr);
        }

        static void DrawDish(Graphics g, float x, float y)
        {
            var st = g.Save();
            g.TranslateTransform(x, y); g.RotateTransform(-20);
            g.FillPie(B(Green), -24, -11, 48, 22, 0, 180);
            g.FillEllipse(B(Color.FromArgb(0x1d, 0x8f, 0x68)), -24, -5, 48, 10);
            using (var p = new Pen(Green, 2)) g.DrawLine(p, 0, 0, 10, -16);
            g.Restore(st);
        }

        static Image customLogo;
        static bool logoChecked;

        // The user's own logo, chosen in the settings dialog (see Settings.LogoPath).
        static Image CustomLogo()
        {
            if (logoChecked) return customLogo;
            logoChecked = true;
            try
            {
                if (System.IO.File.Exists(Settings.LogoPath))
                    using (var fs = System.IO.File.OpenRead(Settings.LogoPath))
                    using (var img = Image.FromStream(fs))
                        customLogo = new Bitmap(img);   // copy so the file isn't kept locked
            }
            catch { customLogo = null; }
            return customLogo;
        }

        static void DrawHeader(Graphics g)
        {
            var logo = CustomLogo();
            if (logo != null)
            {
                var f = F(46, false, TitleFont);
                string label = "S.E.T.I. @ ";
                float tw = g.MeasureString(label, f, PointF.Empty, Fmt).Width;
                float k = Math.Min(560f / logo.Width, 70f / logo.Height);
                float lw = logo.Width * k, lh = logo.Height * k;
                DrawLogo(g);                  // the classic globe + signal wave stays on the left
                float x = 214;
                Text(g, label, x, 62, 46, White, Align.Left, false, TitleFont);
                var im = g.InterpolationMode;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(logo, x + tw, 44 - lh / 2, lw, lh);
                g.InterpolationMode = im;
                Text(g, "Press F1 for info", 995, 31, 21, White);
                Text(g, "Version 3.08", 1435, 31, 21, White, Align.Right);
                Text(g, Url, 1210, 58, 17, White, Align.Center);
                return;
            }
            DrawLogo(g);
            Text(g, "The Search for", 198, 32, 27, White, Align.Left, false, TitleFont);
            float w = Text(g, "Extraterrestrial Intelligence ", 285, 63, 27, White, Align.Left, false, TitleFont);
            float w2 = Text(g, "at HOME", 285 + w + 6, 63, 27, Green, Align.Left, false, TitleFont);
            DrawDish(g, 285 + w + w2 + 40, 40);
            Text(g, "Press F1 for info", 995, 31, 19, White);
            Text(g, "Version 3.08", 1435, 31, 19, White, Align.Right);
            Text(g, Url, 1210, 58, 17, White, Align.Center);
        }

        static void DrawFrame(Graphics g)
        {
            var pb = B(Purple);
            FillRound(g, pb, 14, 87, 1471, 13, 6.5f);
            FillRound(g, pb, 14, 437, 1471, 13, 6.5f);
            g.FillRectangle(pb, 790, 92, 120, 352);
            FillRound(g, pb, 860, 268, 625, 16, 8);
            var bb = B(Color.Black);
            FillRound(g, bb, -60, 100, 882, 337, 30);
            FillRound(g, bb, 882, 100, 700, 168, 30);
            FillRound(g, bb, 882, 284, 700, 153, 30);
        }

        static void DrawAnalysis(Graphics g)
        {
            var wu = Sim.Wu;
            var st = Sim.State(Math.Min(wu.P, 0.99999));
            Text(g, "Data Analysis", 361, 140, 22, White, Align.Center);
            string act = st.Act; double sub = st.Sub;
            if (Sim.Phase == Phase.Sending) { act = "Sending result to server"; sub = Math.Min(1, Sim.PhaseT / 5); }
            if (Sim.Phase == Phase.Receiving) { act = "Getting new data unit"; sub = Math.Min(1, Sim.PhaseT / 5); }
            Text(g, act, 24, 167, 21, White);
            Text(g, $"{(int)(sub * 100)}%", 565, 167, 21, White, Align.Right);
            g.FillRectangle(B(White), 582, 153, (float)Math.Max(2, 200 * sub), 11);

            if (Sim.Phase == Phase.Analyze)
            {
                Text(g, "Doppler drift rate: " + st.Drift.ToString("0.0000", CI) + " Hz/sec", 24, 195, 21, White);
                Text(g, "Resolution: " + st.Res.ToString("0.000", CI) + " Hz", 362, 195, 21, White);
                Text(g, Sim.SignalText(Sim.Shown), 24, 223, 21, White);
                DrawMiniGraph(g, 24, 238, 773, 96);
            }

            // 3D tube progress bar
            float x = 24, y = 354, w = 746, h = 36, dx = 12, dy = -12;
            float fw = (float)(w * wu.P);
            var sm = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.None;
            if (fw > 0.5f)
            {
                g.FillRectangle(B(Color.FromArgb(0xb0, 0x14, 0x1e)), x, y, fw, h);
                Quad[0] = new PointF(x, y); Quad[1] = new PointF(x + dx, y + dy); Quad[2] = new PointF(x + fw + dx, y + dy); Quad[3] = new PointF(x + fw, y);
                g.FillPolygon(B(Color.FromArgb(0xe0, 0x40, 0x48)), Quad);
                Quad[0] = new PointF(x + fw, y); Quad[1] = new PointF(x + fw + dx, y + dy); Quad[2] = new PointF(x + fw + dx, y + dy + h); Quad[3] = new PointF(x + fw, y + h);
                g.FillPolygon(B(Color.FromArgb(0x6e, 0x0a, 0x10)), Quad);
            }
            using (var p = new Pen(Grey, 2))
            {
                g.DrawRectangle(p, x, y, w, h);
                g.DrawLines(p, new[] { new PointF(x, y), new PointF(x + dx, y + dy), new PointF(x + w + dx, y + dy), new PointF(x + w + dx, y + h + dy), new PointF(x + w, y + h) });
                g.DrawLine(p, x + w, y, x + w + dx, y + dy);
            }
            g.SmoothingMode = sm;

            Text(g, "Overall:  " + (wu.P * 100).ToString("0.000", CI) + "% done", 24, 418, 21, White);
            Text(g, "CPU time: " + Hms(wu.Cpu), 747, 418, 21, White, Align.Right);
        }

        // stepped "ribbon" graph, normalised to its own maximum (as in gutil.cpp)
        static void Ribbon(Graphics g, double[] d, float x, float y, float w, float h, Color c)
        {
            double max = 0;
            foreach (var v in d) max = Math.Max(max, v);
            if (max == 0) max = 1;
            float sw = w / d.Length;
            var pts = new PointF[d.Length * 2];
            for (int i = 0; i < d.Length; i++)
            {
                float yy = (float)(y + h - d[i] / max * h);
                pts[i * 2] = new PointF(x + i * sw, yy);
                pts[i * 2 + 1] = new PointF(x + (i + 1) * sw, yy);
            }
            var sm = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.None;
            using (var p = new Pen(c, 2) { LineJoin = LineJoin.Miter }) g.DrawLines(p, pts);
            g.SmoothingMode = sm;
        }

        static void DrawMiniGraph(Graphics g, float x, float y, float w, float h)
        {
            var s = Sim.Shown;
            if (s == null) return;
            Ribbon(g, s.Pot, x, y, w, h, LineRed);
            if (s.Type == "gauss")
            {
                double max = 0;
                foreach (var v in s.Pot) max = Math.Max(max, v);
                var fit = new double[s.Pot.Length];
                for (int i = 0; i < fit.Length; i++) { double d = (i - s.Ind) / s.Sigma; fit[i] = (s.Mean + s.Peak * Math.Exp(-d * d * 0.693)) / max; }
                Ribbon(g, fit, x, y, w, h, White);
            }
            else if (s.Type == "triplet" && s.Ticks != null)
            {
                using (var p = new Pen(Green, 3))
                    foreach (var t in s.Ticks)
                    {
                        float xx = x + (t + 0.5f) * (w / s.Pot.Length);
                        g.DrawLine(p, xx, y + h * 0.2f, xx, y - h * 0.1f);
                    }
            }
        }

        static void DrawDataInfo(Graphics g)
        {
            var wu = Sim.Wu;
            Text(g, "Data Info", 1165, 140, 22, White, Align.Center);
            int raH = (int)wu.Ra, raM = (int)((wu.Ra - raH) * 60), raS = (int)(((wu.Ra - raH) * 60 - raM) * 60);
            double ad = Math.Abs(wu.Dec);
            int dD = (int)ad, dM = (int)((ad - dD) * 60), dS = (int)(((ad - dD) * 60 - dM) * 60);
            Text(g, $"From: {raH} hr {raM,2}' {raS,2}\" RA, {(wu.Dec < 0 ? "-" : "+")} {dD} deg {dM}' {dS}\" Dec", 906, 167, 21, White);
            Text(g, "Recorded on: " + wu.Recorded.ToString("ddd MMM dd HH:mm:ss yyyy", CI) + " GMT", 906, 195, 21, White);
            Text(g, "Source: Arecibo Radio Observatory", 906, 223, 21, White);
            Text(g, "Base Frequency: " + (wu.BaseHz / 1e9).ToString("0.000000000", CI) + " GHz", 906, 251, 21, White);
        }

        static void DrawUserInfo(Graphics g)
        {
            Text(g, "User Info", 1163, 323, 22, White, Align.Center);
            string name = Settings.Name.Length > 34 ? Settings.Name.Substring(0, 34) : Settings.Name;
            Text(g, "Name: " + name, 906, 351, 21, White);
            Text(g, "Data units completed: " + Settings.Wus, 906, 379, 21, White);
            Text(g, "Total computer time: " + Hms(Settings.Cpu), 906, 407, 21, White);
        }

        // ---- the 3D power / frequency / time graph, rendered to a cached bitmap ----
        // At rest it matches the classic view; it rocks like a turntable (rotation in the floor
        // plane, then the same oblique projection). Mirrors web/seti.js.
        const float Asp = 1.75f, Ax = 1168f / Asp, Bx = -114, By = -278;
        static readonly float DepthU = -Bx * Asp / 1168f;
        static readonly float Pcx = 232 + 1168 / 2f + Bx / 2, Pcy = 848 + By / 2;
        static float pk = 1, pc = 1, ps = 0;
        static double fitFor = -1, graphAngle = double.NaN;
        static readonly System.Diagnostics.Stopwatch graphClock = System.Diagnostics.Stopwatch.StartNew();
        static long graphDrawnAt = -1000;

        static void FitScale()
        {
            if (fitFor == Settings.RockDegrees) return;
            fitFor = Settings.RockDegrees;
            float k = 1;
            for (double a = -1; a <= 1; a += 0.25)
            {
                double th = a * Settings.RockDegrees * Math.PI / 180, c = Math.Cos(th), sn = Math.Sin(th);
                foreach (var x in new[] { 0f, 1f }) foreach (var z in new[] { 0f, 1f }) foreach (var yy in new[] { 0f, MaxH })
                {
                    double u = (x - 0.5) * Asp, v = z - 0.5, u2 = u * c + v * sn, v2 = -u * sn + v * c;
                    double dx = u2 * Ax + Bx * v2, dy = By * v2 - yy;
                    if (dx < 0) k = (float)Math.Min(k, (Pcx - 112) / -dx); else if (dx > 0) k = (float)Math.Min(k, (1405 - Pcx) / dx);
                    if (dy < 0) k = (float)Math.Min(k, (Pcy - 452) / -dy); else if (dy > 0) k = (float)Math.Min(k, (878 - Pcy) / dy);
                }
            }
            pk = k;
        }

        static PointF Corner(float x, float z, float y)
        {
            double u = (x - 0.5) * Asp, v = z - 0.5, u2 = u * pc + v * ps, v2 = -u * ps + v * pc;
            return new PointF((float)(Pcx + pk * (u2 * Ax + Bx * v2)), (float)(Pcy + pk * (By * v2) - y * pk));
        }

        // returns true when the graph needs redrawing because the rock angle moved
        static bool UpdateAngle()
        {
            FitScale();
            double th = Settings.RockDegrees > 0
                ? Math.Sin(2 * Math.PI * Sim.Clock / Settings.RockSeconds) * Settings.RockDegrees * Math.PI / 180 : 0;
            long now = graphClock.ElapsedMilliseconds;
            if (!(Math.Abs(th - graphAngle) > 0.0007 && now - graphDrawnAt > 100)) return false;  // slow rock: <= 10 redraws a second
            graphAngle = th; pc = (float)Math.Cos(th); ps = (float)Math.Sin(th); graphDrawnAt = now;
            return true;
        }

        const int NP = (Sim.NF + 1) * (Sim.NT + 1);
        static readonly float[] gx = new float[NP], gy = new float[NP], gkey = new float[NP];
        static readonly float[] barKey = new float[Sim.NF * Sim.NT];
        static readonly int[] order = new int[Sim.NF * Sim.NT];

        static void RenderGraph(float scale)
        {
            int w = Math.Max(1, (int)Math.Ceiling(VW * scale)), h = Math.Max(1, (int)Math.Ceiling((VH - GraphTop) * scale));
            if (graphBmp == null || graphBmp.Width != w || graphBmp.Height != h)
            {
                graphBmp?.Dispose();
                graphBmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb);
            }
            int NF = Sim.NF, NT = Sim.NT;
            for (int t = 0; t <= NT; t++)
            {
                double v = t / (double)NT - 0.5;
                for (int i = 0; i <= NF; i++)
                {
                    double u = (i / (double)NF - 0.5) * Asp, u2 = u * pc + v * ps, v2 = -u * ps + v * pc;
                    int n = t * (NF + 1) + i;
                    gx[n] = (float)(Pcx + pk * (u2 * Ax + Bx * v2)); gy[n] = (float)(Pcy + pk * By * v2); gkey[n] = (float)(DepthU * u2 + v2);
                }
            }
            for (int t = 0; t < NT; t++) for (int i = 0; i < NF; i++)
            {
                int n = t * (NF + 1) + i, id = t * NF + i;
                barKey[id] = -(gkey[n] + gkey[n + NF + 2]) / 2;       // negate: Array.Sort ascending => farthest first
                order[id] = id;
            }
            var keys = (float[])barKey.Clone();
            Array.Sort(keys, order);

            using (var g = Graphics.FromImage(graphBmp))
            {
                g.Clear(Color.Transparent);
                g.ScaleTransform(scale, scale);
                g.TranslateTransform(0, -GraphTop);
                g.SmoothingMode = SmoothingMode.None;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                int vis = Sim.GraphVisible < 0 ? NT : Sim.GraphVisible;
                double span = Sim.GraphMax - Sim.GraphMin; if (span <= 0) span = 1;
                using (var outline = new Pen(Color.Black, 1f / Math.Max(scale, 0.5f)))
                {
                    foreach (int id in order)
                    {
                        int t = id / NF, i = id - t * NF;
                        if (t < NT - vis) continue;                   // grows in from the back
                        double val = Sim.GraphRows[NT - 1 - t][i];
                        float hgt = (float)Math.Min(MaxH * 1.25, 4 + val * 30) * pk;
                        int lv = Math.Max(0, Math.Min(Levels - 1, (int)Math.Round((val - Sim.GraphMin) / span * (Levels - 1))));
                        int a = t * (NF + 1) + i, b = a + 1, d = a + NF + 1, e = d + 1;
                        if (gx[d] < gx[a]) { Quad[0] = new PointF(gx[a], gy[a]); Quad[1] = new PointF(gx[d], gy[d]); Quad[2] = new PointF(gx[d], gy[d] - hgt); Quad[3] = new PointF(gx[a], gy[a] - hgt); }
                        else { Quad[0] = new PointF(gx[b], gy[b]); Quad[1] = new PointF(gx[e], gy[e]); Quad[2] = new PointF(gx[e], gy[e] - hgt); Quad[3] = new PointF(gx[b], gy[b] - hgt); }
                        g.FillPolygon(Side[i, lv], Quad);
                        Quad[0] = new PointF(gx[a], gy[a] - hgt); Quad[1] = new PointF(gx[b], gy[b] - hgt); Quad[2] = new PointF(gx[e], gy[e] - hgt); Quad[3] = new PointF(gx[d], gy[d] - hgt);
                        g.FillPolygon(Top[i, lv], Quad);
                        g.DrawPolygon(outline, Quad);
                        Quad[0] = new PointF(gx[a], gy[a]); Quad[1] = new PointF(gx[b], gy[b]); Quad[2] = new PointF(gx[b], gy[b] - hgt); Quad[3] = new PointF(gx[a], gy[a] - hgt);
                        g.FillPolygon(Front[i, lv], Quad);
                        g.DrawPolygon(outline, Quad);
                    }
                }
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var p = new Pen(Color.FromArgb(0x8c, 0x8c, 0x8c), 1.5f))
                {
                    PointF fl = Corner(0, 0, 0), bl = Corner(0, 1, 0), blT = Corner(0, 1, MaxH), brT = Corner(1, 1, MaxH), frT = Corner(1, 0, MaxH), fr = Corner(1, 0, 0);
                    g.DrawLine(p, bl, fl);
                    g.DrawLines(p, new[] { bl, blT, brT, frT, fr });
                    g.DrawLine(p, fl, fr);
                }
            }
        }

        static void DrawGraphLabels(Graphics g)
        {
            PointF fl = Corner(0, 0, 0), bl = Corner(0, 1, 0), fr = Corner(1, 0, 0), fm = Corner(0.5f, 0, 0), lm = Corner(0, 0.5f, 0);
            float Below(float y) => Math.Min(y + 27, 880);
            Text(g, Sim.WuTime.ToString("0.0", CI), bl.X - 23, bl.Y + 14, 21, White, Align.Right);
            Text(g, "Time (sec)", lm.X - 26, lm.Y + 7, 21, White, Align.Right);
            Text(g, "0", fl.X - 30, fl.Y - 6, 21, White, Align.Right);
            Text(g, "0.0", fl.X + 13, Below(fl.Y), 21, White);
            Text(g, "Frequency (Hz)", fm.X + 26, Below(fm.Y), 21, White, Align.Center);
            Text(g, (Sim.Bandwidth - 0.005).ToString("0.000", CI), fr.X + 7, Below(fr.Y), 21, White, Align.Right);
            Text(g, "Power", 1449, 826, 21, White, Align.Center);
            using (var p = new Pen(White, 2))
            {
                g.DrawLine(p, 1449, 800, 1449, 728);
                g.DrawLines(p, new[] { new PointF(1440, 740), new PointF(1449, 728), new PointF(1458, 740) });
            }
        }

        static void DrawInfo(Graphics g)
        {
            if (!ShowInfo) return;
            float x = 300, y = 180, w = 900, h = 470;
            FillRound(g, B(Color.FromArgb(235, 0, 0, 0)), x, y, w, h, 24);
            using (var p = new Pen(Purple, 6)) using (var path = RoundRect(x, y, w, h, 24)) g.DrawPath(p, path);
            var lines = new (string s, float px, bool title)[]
            {
                ("Retro SETI", 26, true),
                ("A tribute to the classic SETI@home screensaver (1999–2005).", 19, false),
                ("The data shown is simulated — nothing is downloaded or analysed.", 19, false),
                ("Not affiliated with UC Berkeley or the SETI@home project.", 19, false),
                ("", 10, false),
                ("While running, the display is kept on and the PC won't sleep.", 19, false),
                ("Run with /w for a window (F11 = fullscreen), /c for settings.", 19, false),
                ("", 10, false),
                ("The real SETI@home ran from May 1999; the classic client", 19, false),
                ("retired on December 15, 2005 in favour of BOINC.", 19, false),
            };
            float yy = y + 60;
            foreach (var l in lines) { Text(g, l.s, VW / 2, yy, l.px, l.title ? Green : White, Align.Center, l.title); yy += l.px + 16; }
            Text(g, "press F1 to close", VW / 2, y + h - 26, 15, Grey, Align.Center);
        }
    }
}
