// Data unit simulation. Mirrors web/seti.js. Status strings, readout formats and the 3D graph's
// geometry and scaling follow the original SETI@home 3.08 Windows client (studied, not copied).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RetroSeti
{
    sealed class Signal
    {
        public string Type;                  // "gauss" | "pulse" | "triplet"
        public double Peak, Mean, Sigma, Ind, ChiSqr, Period, Score;
        public double[] Pot;
        public int[] Ticks;
    }

    sealed class WorkUnit
    {
        public double Ra, Dec, BaseHz, P, Cpu;
        public DateTime Recorded;
        public int Slots;
        public readonly Dictionary<string, Signal> Best = new Dictionary<string, Signal>();
    }

    struct SlotState
    {
        public int K, Fft;
        public double Drift, Sub, Res;
        public string Act;
    }

    enum Phase { Analyze, Sending, Receiving }

    /// <summary>State of the current 3D graph, as the 3.08 client built it.</summary>
    sealed class ClassicGraph
    {
        // Lean = signed sideways depth shift (negative: rows lean up-left); Span = room reserved for it.
        public double Lean = -57;                 // fractional while swaying, so the motion is smooth
        public int Gen, Span = 57, Dy = 143, N = 143, NCols = 583, MaxH = 43, Fft = 1024, Emitted, LastSpec = -1;
        public int[] Lut;
        public double MaxSoFar, Start = -1e9;
        public readonly List<byte[]> Rows = new List<byte[]>();
    }

    static class Sim
    {
        public const double Bandwidth = 9765.625, WuTime = 107.374;
        const int GaussPotLen = 64, PulsePotLen = 256, TripletPotLen = 256, WuSamples = 1048576;
        // graph panel in the original's pixels: width = panel - 110, height = panel - 20
        public const int PW = 750, PH = 206, WG = PW - 110, HG = PH - 20, Base = PH - 20, Marg = 60;
        static readonly int[] Ffts = { 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072 };
        static readonly Random Rng = new Random();
        static readonly CultureInfo CI = CultureInfo.InvariantCulture;

        public static double WuSeconds = 15 * 60;
        public static bool CountStats = true;   // false for the tiny preview window
        public static WorkUnit Wu;
        public static Phase Phase = Phase.Analyze;
        public static double PhaseT, Clock;
        public static readonly ClassicGraph G = new ClassicGraph();

        public static Signal Shown;
        public static bool ShownBest;
        static double nextSignal, scan, period = 0.002, tripletUntil, saveAcc;

        public static double Rand(double a, double b) => a + Rng.NextDouble() * (b - a);
        static double Expo() => -Math.Log(1 - Rng.NextDouble());
        static double Clamp(double v, double a, double b) => Math.Max(a, Math.Min(b, v));

        public static void Init()
        {
            WuSeconds = Math.Max(0.5, Math.Min(600, Settings.WuMinutes)) * 60;
            Wu = NewWorkUnit();
            NewGraph(1024);
            G.Start = Clock - Settings.GrowSeconds;
            while (G.Emitted < G.N) EmitRow();
        }

        static WorkUnit NewWorkUnit() => new WorkUnit
        {
            Ra = Rand(0, 24), Dec = Rand(0, 38),
            Recorded = new DateTime(1999, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Rand(0, 7 * 365.25 * 86400000.0)),
            BaseHz = 1418750000 + Rng.Next(256) * Bandwidth,
            Slots = Math.Max(6, (int)Math.Round(WuSeconds / Settings.StepSeconds)),
        };

        public static void RecomputeSlots() =>
            Wu.Slots = Math.Max(6, (int)Math.Round(Math.Max(0.5, Math.Min(600, Settings.WuMinutes)) * 60 / Settings.StepSeconds));

        public static SlotState State(double p)
        {
            double q = p * Wu.Slots;
            int k = Math.Min(Wu.Slots - 1, (int)Math.Floor(q));
            double f = q - k;
            int fft = Ffts[k % Ffts.Length];
            int ci = k / Ffts.Length;
            int n = (ci + 1) / 2, sign = ci % 2 == 1 ? 1 : -1;
            double drift = sign * n * 0.0833 * (1 + (ci % 3) * 0.5);
            bool chirping = k % Ffts.Length == 0 && k > 0;
            string act; double a, b;
            if (p < 0.004) { act = "Doing Baseline Smoothing"; a = 0; b = 1; }
            else if (chirping && f < 0.08) { act = "Chirping data"; a = 0; b = 0.08; }
            else if (f < 0.45) { act = "Computing Fast Fourier Transform"; a = chirping ? 0.08 : 0; b = 0.45; }
            else if (f < 0.65) { act = "Searching for Gaussians"; a = 0.45; b = 0.65; }
            else { act = "Searching for Pulses / Triplets"; a = 0.65; b = 1; }
            double sub = p < 0.004 ? p / 0.004 : (f - a) / (b - a);
            return new SlotState { K = k, Fft = fft, Drift = drift, Act = act, Sub = Clamp(sub, 0, 1), Res = Bandwidth / fft };
        }

        // ---- the 3D graph: random viewpoint per graph, rows emitted as the "FFTs" complete ----
        static double GumbelMax(double q) =>
            q <= 1 ? Expo() : Math.Log(q) - Math.Log(-Math.Log(1 - Rng.NextDouble() * 0.999999));

        public static double RockLean() => G.Span * Math.Sin(2 * Math.PI * Clock / Settings.RockSeconds);

        public static void NewGraph(int fft)
        {
            int lean, span, dy;
            if (Settings.GraphAngle == "rock")
            {
                // the sway never stops; each new graph still gets the original's random steepness
                span = (int)Settings.RockAmount; dy = 200 - (50 + Rng.Next(70)); lean = 0;
            }
            else
            {
                bool fixedView = Settings.GraphAngle == "fixed";
                int dx = fixedView ? 57 : 50 + Rng.Next(70);
                bool right = !fixedView && Rng.Next(2) == 1;
                span = dx; dy = 200 - dx; lean = right ? dx : -dx;
            }
            int ncols = WG - span, maxH = HG - dy;
            var lut = new int[ncols * (maxH + 1)];
            for (int c = 0; c < ncols; c++)
                for (int h = 0; h <= maxH; h++)
                    lut[c * (maxH + 1) + h] = Renderer.ClassicColour(0.5 + 0.5 * (ncols - c) / ncols, 0.2 + 0.6 * h / maxH);
            G.Gen++; G.Lean = lean; G.Span = span; G.Dy = dy; G.N = Math.Max(span, dy);
            G.NCols = ncols; G.MaxH = maxH; G.Fft = fft; G.Lut = lut;
            G.Rows.Clear(); G.MaxSoFar = 0; G.Start = Clock; G.Emitted = 0; G.LastSpec = -1;
            if (Settings.GraphAngle == "rock") G.Lean = RockLean();
        }

        static void EmitRow()
        {
            int r = G.Emitted, n = G.N, ncols = G.NCols;
            int nfft = WuSamples / G.Fft;
            int spec = (int)((long)r * Math.Min(nfft, n) / n);
            byte[] h;
            if (spec == G.LastSpec && r > 0) h = G.Rows[r - 1];
            else
            {
                int m = Math.Max(1, nfft / n);
                var v = new double[ncols];
                if (G.Fft >= ncols)
                {
                    double k = (G.Fft / ncols) * (double)m;
                    for (int c = 0; c < ncols; c++) v[c] = GumbelMax(k);
                }
                else
                {
                    double w = ncols / (double)G.Fft;
                    for (int b = 0; b < G.Fft; b++)
                    {
                        double val = GumbelMax(m);
                        for (int c = (int)Math.Floor(b * w); c < (int)Math.Floor((b + 1) * w); c++) v[c] = val;
                    }
                }
                if (Rng.NextDouble() < 0.04)
                {
                    int c0 = Rng.Next(ncols), wid = Math.Max(1, ncols / G.Fft);
                    double boost = Rand(2, 5);
                    for (int c = c0; c < Math.Min(ncols, c0 + wid); c++) v[c] *= boost;
                }
                double rowMax = v.Max();
                G.MaxSoFar = Math.Max(G.MaxSoFar, rowMax);
                h = new byte[ncols];
                for (int c = 0; c < ncols; c++) h[c] = (byte)(int)(G.MaxH * v[c] / G.MaxSoFar);
                G.LastSpec = spec;
            }
            G.Rows.Add(h);
            G.Emitted++;
        }

        // ---- signals ----
        static Signal MakeGauss()
        {
            double sigma = Rand(3, 8), ind = Rand(20, 44), peak = Rand(0.4, 3.5), mean = Rand(0.8, 1.2);
            var pot = new double[GaussPotLen];
            for (int i = 0; i < pot.Length; i++)
            {
                double d = (i - ind) / sigma;
                pot[i] = Math.Max(0, mean + peak * Math.Exp(-d * d * 0.693) + (Expo() - 1) * 0.6);
            }
            double chisqr = Rand(0.6, 9);
            return new Signal { Type = "gauss", Peak = peak, Mean = mean, Sigma = sigma, Ind = ind, Pot = pot, ChiSqr = chisqr, Score = peak / Math.Sqrt(chisqr) };
        }

        // one frame of the pulse search: the profile folded at the period being tried
        static Signal MakePulse(double trialPeriod)
        {
            double peak = Rand(0.3, 1.4) + (Rng.NextDouble() < 0.08 ? Rand(0.8, 1.6) : 0);
            var pot = new double[PulsePotLen];
            for (int i = 0; i < pot.Length; i++) pot[i] = Math.Min(255, 70 + Expo() * 28);
            int at = Rng.Next(PulsePotLen), wid = 1 + Rng.Next(4);
            for (int i = at; i < Math.Min(PulsePotLen, at + wid); i++) pot[i] = Math.Min(255, 110 + peak * 100);
            return new Signal { Type = "pulse", Peak = peak, Period = trialPeriod, Pot = pot, Score = peak * Rand(0.3, 0.6) };
        }

        static Signal MakeTriplet()
        {
            double peak = Rand(5, 14);
            var pot = new double[TripletPotLen];
            for (int i = 0; i < pot.Length; i++) pot[i] = Math.Min(255, 60 + Expo() * 25);
            int t0 = Rng.Next(10, 80), step = Rng.Next(30, 80);
            var ticks = new[] { t0, t0 + step, t0 + 2 * step }.Where(t => t < TripletPotLen).ToArray();
            foreach (var t in ticks) pot[t] = 255;
            return new Signal { Type = "triplet", Peak = peak, Period = Rand(0.01, 2), Pot = pot, Ticks = ticks, Score = peak };
        }

        static void KeepBest(Signal s)
        {
            if (!Wu.Best.TryGetValue(s.Type, out var cur) || s.Score > cur.Score) Wu.Best[s.Type] = s;
        }

        // During a search the small graph plays rapidly through the data being examined
        // (SignalFps frames a second): the Gaussian fit window slides along the data and the
        // pulse search flicks through folded profiles as the period is stepped. Otherwise it
        // shows the best found so far (blank until something turns up).
        static void ChooseSignal(SlotState st)
        {
            bool searching = Phase == Phase.Analyze &&
                (st.Act == "Searching for Gaussians" || st.Act == "Searching for Pulses / Triplets");
            if (!searching)
            {
                Wu.Best.TryGetValue("gauss", out var bg);
                Wu.Best.TryGetValue("pulse", out var bp);
                Wu.Best.TryGetValue("triplet", out var bt);
                Shown = bg ?? bp ?? bt; ShownBest = true; scan = 0; period = 0.002; return;
            }
            if (Clock < nextSignal) return;
            nextSignal = Clock + 1 / Settings.SignalFps;
            if (st.Act == "Searching for Gaussians")
            {
                scan = (scan + 1.5) % (GaussPotLen + 16);
                var g = MakeGauss();
                g.Ind = scan - 8;
                for (int i = 0; i < g.Pot.Length; i++)
                {
                    double d = (i - g.Ind) / g.Sigma;
                    g.Pot[i] = Math.Max(0, g.Mean + g.Peak * Math.Exp(-d * d * 0.693) + (Expo() - 1) * 0.6);
                }
                KeepBest(g); Shown = g; ShownBest = false; return;
            }
            if (Clock < tripletUntil) return;
            if (Rng.NextDouble() < 0.01)
            {
                var t = MakeTriplet(); KeepBest(t); Shown = t; ShownBest = true; tripletUntil = Clock + 1.2; return;
            }
            period = period >= 1.2 ? 0.002 : period * 1.07;
            var p = MakePulse(period); KeepBest(p); Shown = p; ShownBest = false;
        }

        static string F(double v, int w, int p) => v.ToString("F" + p, CI).PadLeft(w);

        public static string SignalText(Signal s, bool best)
        {
            if (s == null) return "";
            string pre = best ? "Best " : "";
            if (s.Type == "gauss") return $"{pre}Gaussian: power {F(s.Peak, 5, 2)}, fit {F(s.ChiSqr, 5, 3)}";
            if (s.Type == "pulse") return $"{pre}Pulse: power {F(s.Peak, 5, 2)}, period {F(s.Period, 6, 4)}, score {F(s.Score, 5, 2)}";
            return $"Best Triplet: power {F(s.Peak, 5, 2)}, period {F(s.Period, 6, 4)}";
        }

        public static (string text, double sub) TransferStatus()
        {
            double t = PhaseT;
            if (Phase == Phase.Sending)
            {
                if (t < 1) return ("Sending result - connecting to server.", t);
                if (t < 4.2) return ($"Sending data: {Math.Max(1, (int)((t - 1) / 3.2 * 18))}K", t / 5);
                return ("All data sent.", 1);
            }
            if (t < 1) return ("Getting data - connecting to server.", t / 6);
            if (t < 5) return ($"Receiving data: {Math.Max(1, (int)((t - 1) / 4 * 340))}K", t / 6);
            return ("All data received.", 1);
        }

        public static void Tick(double dt)
        {
            Clock += dt;
            PhaseT += dt;
            var st = State(Math.Min(Wu.P, 0.99999));
            if (Phase == Phase.Analyze)
            {
                Wu.P += dt / WuSeconds;
                Wu.Cpu += dt;
                if (CountStats) Settings.Cpu += dt;
                if (Clock - G.Start >= Settings.GrowSeconds + Settings.HoldSeconds) NewGraph(st.Fft);
                if (Wu.P >= 1)
                {
                    Wu.P = 1; Phase = Phase.Sending; PhaseT = 0;
                    if (CountStats) { Settings.Wus++; Settings.SaveStats(); }
                }
            }
            else if (Phase == Phase.Sending && PhaseT > 5) { Phase = Phase.Receiving; PhaseT = 0; }
            else if (Phase == Phase.Receiving && PhaseT > 6) { Wu = NewWorkUnit(); Phase = Phase.Analyze; PhaseT = 0; }

            int due = Math.Min(G.N, (int)Math.Floor(G.N * (Clock - G.Start) / Settings.GrowSeconds));
            while (G.Emitted < due) EmitRow();
            ChooseSignal(st);

            saveAcc += dt;
            if (saveAcc > 10 && CountStats) { saveAcc = 0; Settings.SaveStats(); }
        }
    }
}
