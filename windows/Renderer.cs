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
        const float VW = 1500, VH = 885;
        const string BodyFont = "Arial", TitleFont = "Arial Black";
        static readonly CultureInfo CI = CultureInfo.InvariantCulture;

        // colours from the 3.08 client's static colour table
        static readonly Color Purple = Color.FromArgb(153, 102, 255), Green = Color.FromArgb(0x35, 0xde, 0xa7),
            White = Color.White, LineRed = Color.FromArgb(255, 0, 0), Grey = Color.FromArgb(127, 127, 127);

        static readonly Dictionary<(string, float, bool), Font> Fonts = new Dictionary<(string, float, bool), Font>();
        static readonly Dictionary<Color, SolidBrush> Brushes = new Dictionary<Color, SolidBrush>();
        static readonly StringFormat Fmt = (StringFormat)StringFormat.GenericTypographic.Clone();

        static Renderer()
        {
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

        // the classic client's HLS -> RGB (results truncated to 0..255)
        static (int r, int g, int b) HlsToRgb(double h, double l, double s)
        {
            if (s == 0) { int v = (int)(l * 255); return (v, v, v); }
            double m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
            return ((int)(HueToRgb(m1, m2, h + 1.0 / 3) * 255), (int)(HueToRgb(m1, m2, h) * 255), (int)(HueToRgb(m1, m2, h - 1.0 / 3) * 255));
        }

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

            g.TranslateTransform(ox, oy);
            g.ScaleTransform(s, s);
            g.TextRenderingHint = s < 0.35f ? TextRenderingHint.SingleBitPerPixelGridFit : TextRenderingHint.AntiAliasGridFit;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            DrawHeader(g);
            DrawFrame(g);
            DrawAnalysis(g);
            DrawDataInfo(g);
            DrawUserInfo(g);
            DrawGraph(g);
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
            if (Sim.Phase != Phase.Analyze) (act, sub) = Sim.TransferStatus();
            sub = Math.Max(0, Math.Min(1, sub));
            Text(g, act, 24, 167, 21, White);
            Text(g, $"{(int)(sub * 100)}%", 565, 167, 21, White, Align.Right);
            g.FillRectangle(B(White), 582, 153, (float)Math.Max(2, 200 * sub), 11);

            if (Sim.Phase == Phase.Analyze)
            {
                Text(g, "Doppler drift rate: " + Fx(st.Drift, 6, 4) + " Hz/sec    Resolution: " + Fx(st.Res, 5, 3) + " Hz", 24, 195, 21, White);
                Text(g, Sim.SignalText(Sim.Shown, Sim.ShownBest), 24, 223, 21, White);
                DrawMiniGraph(g, 24, 238, 773, 96);
            }

            // 3D tube progress bar (the client's red shades and grey outline)
            float x = 24, y = 354, w = 746, h = 36, dx = 12, dy = -12;
            float fw = (float)(w * wu.P);
            var sm = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.None;
            if (fw > 0.5f)
            {
                g.FillRectangle(B(Color.FromArgb(120, 0, 0)), x, y, fw, h);
                g.FillPolygon(B(Color.FromArgb(240, 0, 0)), new[] { new PointF(x, y), new PointF(x + dx, y + dy), new PointF(x + fw + dx, y + dy), new PointF(x + fw, y) });
                g.FillPolygon(B(Color.FromArgb(80, 0, 0)), new[] { new PointF(x + fw, y), new PointF(x + fw + dx, y + dy), new PointF(x + fw + dx, y + dy + h), new PointF(x + fw, y + h) });
            }
            using (var p = new Pen(Grey, 2))
            {
                g.DrawRectangle(p, x, y, w, h);
                g.DrawLines(p, new[] { new PointF(x, y), new PointF(x + dx, y + dy), new PointF(x + w + dx, y + dy), new PointF(x + w + dx, y + h + dy), new PointF(x + w, y + h) });
                g.DrawLine(p, x + w, y, x + w + dx, y + dy);
            }
            g.SmoothingMode = sm;

            Text(g, "Overall: " + Fx(wu.P * 100, 6, 3) + "% done", 24, 418, 21, White);
            Text(g, "CPU time: " + Hms(wu.Cpu), 747, 418, 21, White, Align.Right);
        }

        static string Fx(double v, int w, int p) => v.ToString("F" + p, CI).PadLeft(w);

        // stepped graph, normalised to its own maximum
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
            Text(g, $"From: {raH,2} hr {raM,2}' {raS,2}\" RA, +{dD,3} deg {dM,2}' {dS,2}\" Dec", 906, 167, 21, White);
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

        // ---- the 3D graph: pixel renderer, exactly as the 3.08 client drew it ----
        // At the original resolution (750x206 panel at the bottom of a 753x444 window), then
        // scaled up without smoothing. Each row is a run of 1-pixel columns coloured
        // HLS(0.5 + 0.5*(ncols-col)/ncols, 0.2 + 0.6*h/maxH, 1); black fills the steps where the
        // neighbour on the open side is taller, otherwise one black pixel caps the column.
        const int PanelY = 238;
        const float Scale = VW / 753f;
        const int Black32 = unchecked((int)0xff000000), Grey32 = unchecked((int)0xff7f7f7f);
        static readonly int[] pbuf = new int[Sim.PW * Sim.PH];
        static readonly Bitmap panel = new Bitmap(Sim.PW, Sim.PH, PixelFormat.Format32bppArgb);
        static int drawnGen = -1, drawnRows;

        static int Rgb32(int r, int g, int b) => unchecked((int)0xff000000) | (r << 16) | (g << 8) | b;
        static void Put(int x, int y, int c) { if (x >= 0 && x < Sim.PW && y >= 0 && y < Sim.PH) pbuf[y * Sim.PW + x] = c; }

        static void PLine(int x0, int y0, int x1, int y1, int c)
        {
            int dx = Math.Abs(x1 - x0), dy = -Math.Abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
            for (;;)
            {
                Put(x0, y0, c);
                if (x0 == x1 && y0 == y1) break;
                int e2 = 2 * err;
                if (e2 >= dy) { err += dy; x0 += sx; }
                if (e2 <= dx) { err += dx; y0 += sy; }
            }
        }

        struct Corners { public Point FL, FR, BL, BR; }
        static Corners GraphCorners()
        {
            var G = Sim.G;
            int fx = G.Flag != 0 ? Sim.Marg : Sim.Marg + G.Dx, bx = G.Flag != 0 ? Sim.Marg + G.Dx : Sim.Marg;
            return new Corners
            {
                FL = new Point(fx - 2, Sim.Base + 1), FR = new Point(fx + G.NCols, Sim.Base + 1),
                BL = new Point(bx - 2, Sim.Base - G.Dy), BR = new Point(bx + G.NCols, Sim.Base - G.Dy),
            };
        }

        static void DrawBox()
        {
            var k = GraphCorners(); int mh = Sim.G.MaxH;
            void L(Point a, Point b) => PLine(a.X, a.Y, b.X, b.Y, Grey32);
            Point Up(Point p) => new Point(p.X, p.Y - mh);
            L(k.FL, k.FR); L(k.FL, k.BL); L(k.BL, k.BR); L(k.FR, k.BR);
            L(k.BL, Up(k.BL)); L(k.BR, Up(k.BR)); L(Up(k.BL), Up(k.BR));
            if (Sim.G.Flag != 0) { L(k.FL, Up(k.FL)); L(Up(k.FL), Up(k.BL)); }
            else { L(k.FR, Up(k.FR)); L(Up(k.FR), Up(k.BR)); }
        }

        static void DrawRow(int r)
        {
            var G = Sim.G;
            var h = G.Rows[r];
            int n = G.N, ncols = G.NCols;
            int xs = G.Flag != 0 ? G.Dx * (n - r - 1) / n : G.Dx * r / n;
            int ys = G.Dy * (n - r - 1) / n;
            for (int c = 0; c < ncols; c++)
            {
                int hc = h[c], x = Sim.Marg + xs + c;
                var (R, Gc, Bl) = HlsToRgb(0.5 + 0.5 * (ncols - c) / ncols, 0.2 + 0.6 * hc / G.MaxH, 1);
                int col = Rgb32(R, Gc, Bl);
                for (int y = ys; y < ys + hc; y++) Put(x, Sim.Base - y, col);
                int nb = G.Flag != 0 ? c + 1 : c - 1;
                if (nb >= 0 && nb < ncols && h[nb] > hc) { for (int y = ys + hc; y < ys + h[nb]; y++) Put(x, Sim.Base - y, Black32); }
                else Put(x, Sim.Base - (ys + hc), Black32);
            }
        }

        static void UpdatePanel()
        {
            bool changed = false;
            if (drawnGen != Sim.G.Gen)
            {
                for (int i = 0; i < pbuf.Length; i++) pbuf[i] = Black32;
                DrawBox(); drawnGen = Sim.G.Gen; drawnRows = 0; changed = true;
            }
            while (drawnRows < Sim.G.Emitted) { DrawRow(drawnRows++); changed = true; }
            if (!changed) return;
            var bd = panel.LockBits(new Rectangle(0, 0, Sim.PW, Sim.PH), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            System.Runtime.InteropServices.Marshal.Copy(pbuf, 0, bd.Scan0, pbuf.Length);
            panel.UnlockBits(bd);
        }

        static PointF ToV(float px, float py) => new PointF(px * Scale, (PanelY + py) * Scale);

        static void DrawGraph(Graphics g)
        {
            UpdatePanel();
            var im = g.InterpolationMode; var po = g.PixelOffsetMode;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(panel, new RectangleF(0, PanelY * Scale, Sim.PW * Scale, Sim.PH * Scale));
            g.InterpolationMode = im; g.PixelOffsetMode = po;

            var k = GraphCorners();
            float below = Sim.Base + 14;
            var p = ToV(k.FL.X + 6, below); Text(g, "0.0", p.X, p.Y, 21, White);
            p = ToV((k.FL.X + k.FR.X) / 2f + 13, below); Text(g, "Frequency (Hz)", p.X, p.Y, 21, White, Align.Center);
            p = ToV(k.FR.X + 3, below); Text(g, (Sim.Bandwidth - 0.005).ToString("0.000", CI), p.X, p.Y, 21, White, Align.Right);
            bool right = Sim.G.Flag != 0;
            int side = right ? 1 : -1;
            Point back = right ? k.BR : k.BL, front = right ? k.FR : k.FL;
            var al = right ? Align.Left : Align.Right;
            p = ToV(back.X + side * 12, back.Y + 7); Text(g, Sim.WuTime.ToString("0.0", CI), p.X, p.Y, 21, White, al);
            p = ToV((back.X + front.X) / 2f + side * 13, (back.Y + front.Y) / 2f + 3); Text(g, "Time (sec)", p.X, p.Y, 21, White, al);
            p = ToV(front.X + side * 15, front.Y - 3); Text(g, "0", p.X, p.Y, 21, White, al);
            float px = right ? 23 : Sim.PW - 23;
            p = ToV(px, 177); Text(g, "Power", p.X, p.Y, 21, White, Align.Center);
            var a0 = ToV(px, 163); var a1 = ToV(px, 127);
            using (var pen = new Pen(White, 2))
            {
                g.DrawLine(pen, a0, a1);
                g.DrawLines(pen, new[] { new PointF(a1.X - 9, a1.Y + 12), a1, new PointF(a1.X + 9, a1.Y + 12) });
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
