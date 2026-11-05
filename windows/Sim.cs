// Data unit simulation. Mirrors web/seti.js.
using System;
using System.Globalization;

namespace RetroSeti
{
    sealed class WorkUnit
    {
        public double Ra, Dec, BaseHz, P, Cpu;
        public DateTime Recorded;
        public int Slots;
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
        const double SlotSeconds = 12;
        static readonly int[] Ffts = { 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072 };
        static readonly Random Rng = new Random();
        static readonly CultureInfo CI = CultureInfo.InvariantCulture;

        public static double WuSeconds = 15 * 60;
        public static bool CountStats = true;   // false for the tiny preview window
        public static WorkUnit Wu;
        public static Phase Phase = Phase.Analyze;
        public static double PhaseT;
        public static readonly double[][] Rows = new double[NT][];
        public static int SweepRow;
        static double sweepAcc, saveAcc;
        static int lastSlot = -1;
        public static int GraphVersion;           // bumps whenever the 3D graph data changes

        // Data Analysis detail line + mini graph
        public static string DetailText = "";
        public static double[] Series = new double[0];
        public static double[] Curve;
        static string detailKey = "";
        static double detailNext, clock;

        public static double Rand(double a, double b) => a + Rng.NextDouble() * (b - a);
        static double Expo() => -Math.Log(1 - Rng.NextDouble());

        public static void Init()
        {
            WuSeconds = Math.Max(0.5, Math.Min(600, Settings.WuMinutes)) * 60;
            Wu = NewWorkUnit();
            for (int t = 0; t < NT; t++) Rows[t] = MakeRow(1024);
            GraphVersion++;
        }

        static WorkUnit NewWorkUnit() => new WorkUnit
        {
            Ra = Rand(0, 24), Dec = Rand(-1.5, 38),
            Recorded = new DateTime(1999, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Rand(0, 7 * 365.25 * 86400000.0)),
            BaseHz = 1418750000 + Rng.Next(256) * Bandwidth,
            Slots = Math.Max(6, (int)Math.Round(WuSeconds / SlotSeconds)),
        };

        static double Clamp(double v, double a, double b) => Math.Max(a, Math.Min(b, v));

        public static SlotState State(double p)
        {
            double q = p * Wu.Slots;
            int k = Math.Min(Wu.Slots - 1, (int)Math.Floor(q));
            double f = q - k;
            int fft = Ffts[k % Ffts.Length];
            int ci = k / Ffts.Length;
            int n = (ci + 1) / 2, sign = ci % 2 == 1 ? 1 : -1;
            double drift = sign * n * 0.0833 * (1 + (ci % 3) * 0.5);
            string act; double sub;
            bool gauss = fft >= 128;
            if (p < 0.004) { act = "Doing baseline smoothing"; sub = p / 0.004; }
            else if (f < 0.45) { act = "Computing Fourier transforms"; sub = f / 0.45; }
            else if (f < 0.65 && gauss) { act = "Searching for Gaussians"; sub = (f - 0.45) / 0.2; }
            else { act = "Searching for Pulses / Triplets"; sub = (f - (gauss ? 0.65 : 0.45)) / (gauss ? 0.35 : 0.55); }
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

        static void UpdateDetail(SlotState st)
        {
            string key = st.Act + st.K;
            if (key == detailKey && clock < detailNext) return;
            bool fresh = key != detailKey;
            detailKey = key;
            bool pulses = st.Act.StartsWith("Searching for Pulses");
            detailNext = clock + (pulses ? 0.45 : 0.9);
            Curve = null;
            if (st.Act == "Computing Fourier transforms" || st.Act == "Doing baseline smoothing")
            {
                var row = Rows[Math.Max(0, SweepRow - 1)];
                Series = (double[])row.Clone();
                int mi = 0;
                for (int i = 1; i < NF; i++) if (row[i] > row[mi]) mi = i;
                double power = row[mi] * Rand(9, 14);
                DetailText = string.Format(CI, "Strongest peak: power {0:0.00}  ({1:0.0} Hz at {2:0.00} sec)",
                    power, mi / (double)NF * Bandwidth, SweepRow / (double)NT * WuTime);
            }
            else if (st.Act == "Searching for Gaussians")
            {
                int n = 64; double c = Rand(22, 42), sig = Rand(5, 9), amp = Rand(0.5, 3.5);
                Series = new double[n]; Curve = new double[n];
                for (int i = 0; i < n; i++)
                {
                    Curve[i] = 1 + amp * Math.Exp(-0.5 * Math.Pow((i - c) / sig, 2));
                    Series[i] = Curve[i] + (Expo() - 1) * 0.7;
                }
                double fit = Rand(0.6, 9);
                DetailText = string.Format(CI, "Gaussian: power {0:0.00}, fit {1:0.000}, score {2:0.00}", amp, fit, amp / Math.Sqrt(fit));
            }
            else
            {
                int n = 96;
                if (fresh || Series.Length != n)
                {
                    Series = new double[n];
                    for (int i = 0; i < n; i++) Series[i] = 1 + (Expo() - 1) * 0.35;
                }
                else
                {
                    for (int i = 0; i < n; i++)
                        Series[i] = Clamp(Series[i] * 0.6 + (1 + (Expo() - 1) * 0.35) * 0.4 + (Rng.NextDouble() < 0.04 ? Rand(0.6, 1.4) : 0), 0, 4);
                }
                double power = Rand(0.4, 1.6), period = Rand(0.02, 1.2);
                DetailText = Rng.NextDouble() < 0.25
                    ? string.Format(CI, "Triplet: power {0:0.00}, period {1:0.0000}", power * 6, period)
                    : string.Format(CI, "Pulse: power {0:0.00}, period {1:0.0000}, score {2:0.00}", power, period, power * Rand(0.3, 0.6));
            }
        }

        public static void Tick(double dt)
        {
            clock += dt;
            PhaseT += dt;
            if (Phase == Phase.Analyze)
            {
                Wu.P += dt / WuSeconds;
                Wu.Cpu += dt;
                if (CountStats) Settings.Cpu += dt;
                var st = State(Math.Min(Wu.P, 0.99999));
                if (st.K != lastSlot) { lastSlot = st.K; SweepRow = 0; }
                if (st.Act == "Computing Fourier transforms" && SweepRow < NT)
                {
                    sweepAcc += dt * NT / (SlotSeconds * 0.45 * 0.9);
                    while (sweepAcc >= 1 && SweepRow < NT) { sweepAcc -= 1; Rows[SweepRow++] = MakeRow(st.Fft); GraphVersion++; }
                }
                UpdateDetail(st);
                if (Wu.P >= 1)
                {
                    Wu.P = 1; Phase = Phase.Sending; PhaseT = 0;
                    if (CountStats) { Settings.Wus++; Settings.SaveStats(); }
                }
            }
            else if (Phase == Phase.Sending && PhaseT > 5) { Phase = Phase.Receiving; PhaseT = 0; }
            else if (Phase == Phase.Receiving && PhaseT > 5) { Wu = NewWorkUnit(); Phase = Phase.Analyze; PhaseT = 0; lastSlot = -1; }

            saveAcc += dt;
            if (saveAcc > 10 && CountStats) { saveAcc = 0; Settings.SaveStats(); }
        }
    }
}
