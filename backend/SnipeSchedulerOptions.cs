using System.ComponentModel.DataAnnotations;

public sealed class SnipeSchedulerOptions
{
    public const string SectionName = "SnipeScheduler";

    [Range(10, 10000)]
    public double WakeLeadMilliseconds { get; init; } = 1500;

    [Range(1000, 60000)]
    public double MaximumWakeLeadMilliseconds { get; init; } = 10000;

    [Range(0.1, 20)]
    public double FinalSpinMilliseconds { get; init; } = 15;

    [Range(1, 1000)]
    public double LateToleranceMilliseconds { get; init; } = 50;

    [Range(100, 300000)]
    public double ReconnectWindowMilliseconds { get; init; } = 15000;

    [Range(1, 10000)]
    public int MaximumJobs { get; init; } = 256;

    [Range(1000, 3600000)]
    public double JobExpiryMilliseconds { get; init; } = 60000;
}
