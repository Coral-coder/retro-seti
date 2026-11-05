// Data unit simulation. Mirrors web/seti.js. Status strings, readout formats and the
// graph grow/hold timing follow Berkeley's GPL SETI@home graphics code (seti_boinc).
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

    static class Sim
    {
        public const int NF = 128, NT = 48;
        public const double Bandwidth = 9765.625, WuTime = 107.374;
        const int GaussPotLen = 64, PulsePotLen = 256, TripletPotLen = 256;
        static readonly int[] Ffts = { 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072 };
        static readonly Random Rng = new Random();
        static readonly CultureInfo CI = CultureInfo.InvariantCulture;

        public static double WuSeconds = 15 * 60;
        public static bool CountStats = true;   // false for the tiny preview window
        public static WorkUnit Wu;
        public static Phase Phase = Phase.Analyze;
        public static double PhaseT, Clock;

        // 3D graph: a new array every GrowTime+HoldTime seconds, revealed back-to-front
        public static double[][] GraphRows = new double[NT][];
        public static double GraphMin, GraphMax = 1;
        static double graphStart = -1e9;
        public static int GraphVisible = NT;
        public static int GraphVersion;          // bumps whenever the drawn graph changes

        // signal display: new ones immediately, otherwise rotate the bests every 5 s
        public static Signal Shown;
        static Signal dirty;
        static double shownUntil, saveAcc, findAcc;

        public static double Rand(double a, double b) => a + Rng.NextDouble() * (b - a);
        static double Expo() => -Math.Log(1 - Rng.NextDouble());
        static double Clamp(double v, double a, double b) => Math.Max(a, Math.Min(b, v));

        public static void Init()
        {
            WuSeconds = Math.Max(0.5, Math.Min(600, Settings.WuMinutes)) * 60;
            Wu = NewWorkUnit();
            NewGraphArray(1024);
            graphStart = Clock - Settings.GrowSeconds;
        }

        static WorkUnit NewWorkUnit() => new WorkUnit
        {
            Ra = Rand(0, 24), Dec = Rand(-1.5, 38),
            Recorded = new DateTime(1999, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Rand(0, 7 * 365.25 * 86400000.0)),
            BaseHz = 1418750000 + Rng.Next(256) * Bandwidth,
            Slots = Math.Max(6, (int)Math.Round(WuSeconds / Settings.StepSeconds)),
        };

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

        static double[] MakeRow(int fft)
        {
            var row = new double[NF];
            int k = fft < 256 ? 4 : 3;
            for (int i = 0; i < NF; i++) { double v = 0; for (int j = 0; j < k; j++) v += Expo(); row[i] = v / k; }
            if (Rng.NextDouble() < 0.5) row[Rng.Next(NF)] += Rand(2.5, 4.5);
            return row;
        }

        static void NewGraphArray(int fft)
        {
            double mn = double.MaxValue, mx = double.MinValue;
            for (int t = 0; t < NT; t++)
            {
                GraphRows[t] = MakeRow(fft);
                foreach (var v in GraphRows[t]) { mn = Math.Min(mn, v); mx = Math.Max(mx, v); }
            }
            GraphMin = mn; GraphMax = mx; graphStart = Clock;
            GraphVisible = -1;
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
            return new Signal { Type = "gauss", Peak = peak, Mean = mean, Sigma = sigma, Ind = ind, Pot = pot, ChiSqr = chisqr, Score = peak / Math.Sqrt(chisqr) * Rand(0.3, 0.9) };
        }

        static Signal MakePulse()
        {
            double peak = Rand(0.5, 2.2);
            var pot = new double[PulsePotLen];
            for (int i = 0; i < pot.Length; i++) pot[i] = Math.Min(255, 70 + Expo() * 30);
            pot[Rng.Next(PulsePotLen)] = 255;
            return new Signal { Type = "pulse", Peak = peak, Period = Rand(0.002, 1.2), Pot = pot, Score = peak * Rand(0.3, 0.6) };
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

        static void Found(Signal s)
        {
            if (!Wu.Best.TryGetValue(s.Type, out var cur) || s.Score > cur.Score) Wu.Best[s.Type] = s;
            dirty = s;
        }

        static void ChooseSignal()
        {
            if (dirty != null) { Shown = dirty; dirty = null; shownUntil = Clock + Settings.SignalSeconds; return; }
            if (Clock < shownUntil) return;
            var choices = new[] { "gauss", "pulse", "triplet" }.Where(Wu.Best.ContainsKey).Select(k => Wu.Best[k]).ToArray();
            Shown = choices.Length == 0 ? null : choices[(int)(Clock / Settings.SignalSeconds) % choices.Length];
        }

        static string F(double v, int w, int p) => v.ToString("F" + p, CI).PadLeft(w);

        public static string SignalText(Signal s)
        {
            if (s == null) return "";
            if (s.Type == "gauss") return $"Gaussian: power {F(s.Peak, 5, 2)}, fit {F(s.ChiSqr, 5, 3)}, score {F(s.Score, 5, 3)}";
            if (s.Type == "pulse") return $"Pulse: power {F(s.Peak, 5, 2)}, period {F(s.Period, 6, 4)}, score {F(s.Score, 5, 2)}";
            return $"Triplet: power {F(s.Peak, 5, 2)}, period {F(s.Period, 6, 4)}";
        }

        public static void Tick(double dt)
        {
            Clock += dt;
            PhaseT += dt;
            if (Phase == Phase.Analyze)
            {
                Wu.P += dt / WuSeconds;
                Wu.Cpu += dt;
                if (CountStats) Settings.Cpu += dt;
                var st = State(Math.Min(Wu.P, 0.99999));
                if (Clock - graphStart >= Settings.GrowSeconds + Settings.HoldSeconds) NewGraphArray(st.Fft);
                findAcc += dt;
                if (findAcc > Settings.StepSeconds / 10)
                {
                    findAcc = 0;
                    if (st.Act == "Searching for Gaussians" && Rng.NextDouble() < 0.35) Found(MakeGauss());
                    if (st.Act == "Searching for Pulses / Triplets")
                    {
                        if (Rng.NextDouble() < 0.3) Found(MakePulse());
                        else if (Rng.NextDouble() < 0.12) Found(MakeTriplet());
                    }
                }
                if (Wu.P >= 1)
                {
                    Wu.P = 1; Phase = Phase.Sending; PhaseT = 0;
                    if (CountStats) { Settings.Wus++; Settings.SaveStats(); }
                }
            }
            else if (Phase == Phase.Sending && PhaseT > 5) { Phase = Phase.Receiving; PhaseT = 0; }
            else if (Phase == Phase.Receiving && PhaseT > 5) { Wu = NewWorkUnit(); Phase = Phase.Analyze; PhaseT = 0; }

            ChooseSignal();
            double e = Clock - graphStart;
            int vis = e >= Settings.GrowSeconds ? NT : (int)Math.Floor(NT * e / Settings.GrowSeconds);
            if (vis != GraphVisible) { GraphVisible = vis; GraphVersion++; }

            saveAcc += dt;
            if (saveAcc > 10 && CountStats) { saveAcc = 0; Settings.SaveStats(); }
        }
    }
}
