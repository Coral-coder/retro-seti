// Simulation of a classic-style work unit. Mirrors web/seti.js.
using System;
using System.Collections.Generic;

namespace RetroSeti
{
    sealed class Gauss
    {
        public int Bin, Len, I;
        public double Sigma, Amp;
        public List<double> Samples = new List<double>();
    }

    sealed class BestGauss
    {
        public double Power, Fit, Score, Sigma, Amp, Chirp;
        public int Len;
        public double[] Samples;
    }

    sealed class BestSpike
    {
        public double Power, Chirp, Freq;
        public int Bin, Fft;
        public double[] Spectrum;
    }

    sealed class WorkUnit
    {
        public string Name;
        public double Jd, Ra, Dec, BaseHz, Angle, P, Cpu;
        public int ChirpSteps;
        public BestGauss BestGauss;
        public BestSpike BestSpike;
        public Gauss Gauss;
    }

    struct Analysis
    {
        public string Act;
        public double Chirp;
        public int Fft;
    }

    enum Phase { Analyze, Sending, Receiving }

    static class Sim
    {
        public const int NF = 48, NT = 40;
        const double RowsPerSec = 9;
        static readonly int[] Ffts = { 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072 };
        static readonly string[] Months = { "ja", "fe", "mr", "ap", "my", "jn", "jl", "au", "se", "oc", "no", "de" };
        static readonly Random Rng = new Random();

        public static double WuSeconds = 15 * 60;
        public static bool CountStats = true;   // false for the tiny preview window
        public static WorkUnit Wu;
        public static Phase Phase = Phase.Analyze;
        public static double PhaseT;
        public static readonly List<double[]> Rows = new List<double[]>();
        public static double RowAcc;
        static double saveAcc;

        public static double Rand(double a, double b) => a + Rng.NextDouble() * (b - a);

        public static DateTime JdToDate(double jd) =>
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds((jd - 2440587.5) * 86400000.0);

        public static void Init()
        {
            WuSeconds = Math.Max(0.5, Math.Min(600, Settings.WuMinutes)) * 60;
            Wu = NewWorkUnit();
            Rows.Clear();
            for (int i = 0; i < NT; i++) Rows.Add(new double[NF]);
        }

        static WorkUnit NewWorkUnit()
        {
            double jd = Rand(2451179.5, 2453550);
            var d = JdToDate(jd);
            string name = string.Format("{0:00}{1}{2:00}a{3}.{4}.{5}.{6}.{7}",
                d.Day, Months[d.Month - 1], d.Year % 100, "abcdefgh"[Rng.Next(8)],
                Rng.Next(10000, 32000), Rng.Next(1000, 9999), Rng.Next(100000, 999999), Rng.Next(1, 250));
            return new WorkUnit
            {
                Name = name, Jd = jd, Ra = Rand(0, 24), Dec = Rand(-1.5, 38),
                BaseHz = 1418750000 + Rng.Next(256) * 9765.625, Angle = Rand(0.003, 3.2),
                ChirpSteps = Math.Max(8, (int)Math.Round(WuSeconds / 20)),
            };
        }

        public static Analysis State(double p)
        {
            if (p < 0.012) return new Analysis { Act = "Doing baseline smoothing" };
            double q = (p - 0.012) / 0.988 * Wu.ChirpSteps;
            int ci = (int)Math.Floor(q);
            double fr = q - ci;
            int k = (ci + 1) / 2;
            int sign = ci % 2 == 1 ? 1 : -1;
            double chirp = sign * k * (50.0 / (Wu.ChirpSteps / 2.0));
            double fx = fr * Ffts.Length;
            int fi = Math.Min(Ffts.Length - 1, (int)Math.Floor(fx));
            double ff = fx - fi;
            string act = ff < 0.5 ? "Computing Fourier transforms"
                : ff < 0.68 ? "Searching for spikes"
                : ff < 0.86 ? "Searching for gaussians"
                : "Searching for pulses and triplets";
            return new Analysis { Act = act, Chirp = chirp, Fft = Ffts[fi] };
        }

        static double[] MakeRow()
        {
            var row = new double[NF];
            for (int i = 0; i < NF; i++) row[i] = -Math.Log(1 - Rng.NextDouble()) * 1.2;
            var st = State(Wu.P);

            if (Rng.NextDouble() < 0.035)
            {
                int b = Rng.Next(NF);
                row[b] += Rand(4, 14);
                if (b > 0) row[b - 1] += Rand(0, 2);
                if (b < NF - 1) row[b + 1] += Rand(0, 2);
            }
            if (Wu.Gauss == null && Rng.NextDouble() < 0.025)
            {
                int len = Rng.Next(28, 44);
                Wu.Gauss = new Gauss { Bin = Rng.Next(2, NF - 2), Len = len, Sigma = len / Rand(5, 7), Amp = Rand(1.5, 7) };
            }
            if (Wu.Gauss != null)
            {
                var g = Wu.Gauss;
                double c = g.Len / 2.0;
                double v = g.Amp * Math.Exp(-0.5 * Math.Pow((g.I - c) / g.Sigma, 2));
                row[g.Bin] += v;
                if (g.Bin > 0) row[g.Bin - 1] += v * 0.25;
                g.Samples.Add(row[g.Bin]);
                if (++g.I >= g.Len)
                {
                    double fit = Rand(0.4, 4.5);
                    double power = g.Amp + Rand(-0.3, 0.3);
                    double score = power / fit;
                    if (Wu.BestGauss == null || score > Wu.BestGauss.Score)
                        Wu.BestGauss = new BestGauss { Power = power, Fit = fit, Score = score, Samples = g.Samples.ToArray(), Sigma = g.Sigma, Amp = g.Amp, Len = g.Len, Chirp = st.Chirp };
                    Wu.Gauss = null;
                }
            }
            int mi = 0;
            for (int i = 1; i < NF; i++) if (row[i] > row[mi]) mi = i;
            if (Wu.BestSpike == null || row[mi] > Wu.BestSpike.Power)
                Wu.BestSpike = new BestSpike { Power = row[mi], Bin = mi, Spectrum = (double[])row.Clone(), Chirp = st.Chirp, Fft = st.Fft == 0 ? 8 : st.Fft, Freq = Rand(-1.2e6, 1.2e6) };
            return row;
        }

        static void Push(double[] row)
        {
            Rows.Insert(0, row);
            if (Rows.Count > NT + 1) Rows.RemoveRange(NT + 1, Rows.Count - NT - 1);
        }

        public static void Tick(double dt)
        {
            PhaseT += dt;
            if (Phase == Phase.Analyze)
            {
                Wu.P += dt / WuSeconds;
                Wu.Cpu += dt;
                if (CountStats) Settings.Cpu += dt;
                RowAcc += dt * RowsPerSec;
                while (RowAcc >= 1) { RowAcc -= 1; Push(MakeRow()); }
                if (Wu.P >= 1)
                {
                    Wu.P = 1; Phase = Phase.Sending; PhaseT = 0;
                    if (CountStats) { Settings.Wus++; Settings.SaveStats(); }
                }
            }
            else
            {
                if (Phase == Phase.Sending && PhaseT > 4) { Phase = Phase.Receiving; PhaseT = 0; }
                else if (Phase == Phase.Receiving && PhaseT > 4) { Wu = NewWorkUnit(); Phase = Phase.Analyze; PhaseT = 0; }
                RowAcc += dt * RowsPerSec;
                while (RowAcc >= 1) { RowAcc -= 1; Push(new double[NF]); }
            }
            saveAcc += dt;
            if (saveAcc > 10 && CountStats) { saveAcc = 0; Settings.SaveStats(); }
        }
    }
}
