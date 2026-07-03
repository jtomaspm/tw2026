using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Options;

public sealed class SnipeScheduler : IHostedService, IDisposable
{
    private readonly ConcurrentDictionary<Guid, ScheduledJob> _jobs = new();
    private readonly PriorityQueue<ScheduledJob, long> _queue = new();
    private readonly object _gate = new();
    private readonly AutoResetEvent _scheduleChanged = new(false);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly SnipeSchedulerOptions _options;
    private readonly ILogger<SnipeScheduler> _logger;
    private Thread? _thread;
    private HighResolutionWaitableTimer? _timer;
    private int _disposed;

    public SnipeScheduler(
        IOptions<SnipeSchedulerOptions> options,
        ILogger<SnipeScheduler> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public int ActiveJobCount => _jobs.Count;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new HighResolutionWaitableTimer();
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "Snipe high-resolution scheduler",
            Priority = ThreadPriority.Highest
        };
        _thread.Start();

        _logger.LogInformation(
            "Native snipe scheduler started at {Frequency} ticks/second.",
            Stopwatch.Frequency);

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _shutdown.Cancel();
        _scheduleChanged.Set();

        if (_thread is not null)
        {
            _thread.Join(TimeSpan.FromSeconds(5));
        }

        foreach (var job in _jobs.Values)
        {
            job.TryComplete(SnipeJobState.Cancelled, Stopwatch.GetTimestamp());
        }

        _jobs.Clear();
        return Task.CompletedTask;
    }

    public SnipeRegistration Register(
        Guid jobId,
        long generation,
        long fireAtTicks)
    {
        var now = Stopwatch.GetTimestamp();

        if (jobId == Guid.Empty
            || generation <= 0
            || fireAtTicks <= now)
        {
            return SnipeRegistration.Rejected(
                SnipeRegistrationFailure.InvalidDeadline);
        }

        return RegisterAt(
            jobId,
            generation,
            fireAtTicks,
            now,
            _options.WakeLeadMilliseconds);
    }

    public SnipeRegistration RegisterAfter(
        Guid jobId,
        long generation,
        double fireInMilliseconds,
        long receivedAtTicks,
        double? requestedWakeLeadMilliseconds)
    {
        if (jobId == Guid.Empty
            || generation <= 0
            || !double.IsFinite(fireInMilliseconds)
            || fireInMilliseconds <= 0
            || receivedAtTicks <= 0
            || requestedWakeLeadMilliseconds is double requestedWakeLead
                && (!double.IsFinite(requestedWakeLead)
                    || requestedWakeLead < 10
                    || requestedWakeLead
                        > _options.MaximumWakeLeadMilliseconds))
        {
            return SnipeRegistration.Rejected(
                SnipeRegistrationFailure.InvalidDeadline);
        }

        long fireAtTicks;

        try
        {
            fireAtTicks = checked(
                receivedAtTicks + MillisecondsToTicks(fireInMilliseconds));
        }
        catch (OverflowException)
        {
            return SnipeRegistration.Rejected(
                SnipeRegistrationFailure.InvalidDeadline);
        }

        return RegisterAt(
            jobId,
            generation,
            fireAtTicks,
            Stopwatch.GetTimestamp(),
            requestedWakeLeadMilliseconds
                ?? _options.WakeLeadMilliseconds);
    }

    private SnipeRegistration RegisterAt(
        Guid jobId,
        long generation,
        long fireAtTicks,
        long now,
        double wakeLeadMilliseconds)
    {
        if (fireAtTicks <= now)
        {
            return SnipeRegistration.Rejected(
                SnipeRegistrationFailure.InvalidDeadline);
        }

        var wakeLeadTicks = MillisecondsToTicks(
            wakeLeadMilliseconds);
        var wakeAtTicks = Math.Max(now, fireAtTicks - wakeLeadTicks);
        var expiresAtTicks = fireAtTicks
            + MillisecondsToTicks(_options.JobExpiryMilliseconds);
        ScheduledJob? superseded = null;
        ScheduledJob job;

        lock (_gate)
        {
            if (_jobs.TryGetValue(jobId, out var existing))
            {
                if (existing.Generation >= generation)
                {
                    return SnipeRegistration.Rejected(
                        SnipeRegistrationFailure.StaleGeneration);
                }

                superseded = existing;
            }
            else if (_jobs.Count >= _options.MaximumJobs)
            {
                return SnipeRegistration.Rejected(
                    SnipeRegistrationFailure.Capacity);
            }

            job = new ScheduledJob(
                jobId,
                generation,
                fireAtTicks,
                wakeAtTicks,
                expiresAtTicks);

            _jobs[jobId] = job;
            _queue.Enqueue(job, job.WakeAtTicks);
        }

        superseded?.TryComplete(
            SnipeJobState.Superseded,
            Stopwatch.GetTimestamp());
        _scheduleChanged.Set();

        return SnipeRegistration.AcceptedJob(job.Completion.Task);
    }

    public bool Cancel(
        Guid jobId,
        long generation,
        SnipeJobState state)
    {
        ScheduledJob? job = null;

        lock (_gate)
        {
            if (_jobs.TryGetValue(jobId, out var current)
                && current.Generation == generation
                && _jobs.TryRemove(
                    new KeyValuePair<Guid, ScheduledJob>(jobId, current)))
            {
                job = current;
            }
        }

        if (job is null)
        {
            return false;
        }

        job.TryComplete(state, Stopwatch.GetTimestamp());
        _scheduleChanged.Set();
        return true;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _shutdown.Cancel();
        _scheduleChanged.Dispose();
        _shutdown.Dispose();
        _timer?.Dispose();
    }

    private void Run()
    {
        var waits = new WaitHandle[] { _scheduleChanged, _timer! };
        var spinTicks = MillisecondsToTicks(_options.FinalSpinMilliseconds);

        while (!_shutdown.IsCancellationRequested)
        {
            ScheduledJob? next;
            var now = Stopwatch.GetTimestamp();

            lock (_gate)
            {
                RemoveStaleQueueEntries();
                ExpireJobs(now);
                RemoveStaleQueueEntries();
                next = _queue.Count > 0 ? _queue.Peek() : null;
            }

            if (next is null)
            {
                _scheduleChanged.WaitOne(TimeSpan.FromSeconds(1));
                continue;
            }

            var remainingTicks = next.WakeAtTicks - Stopwatch.GetTimestamp();

            if (remainingTicks > spinTicks)
            {
                var waitTicks = remainingTicks - spinTicks;
                _timer!.Arm(TicksToTimeSpan(waitTicks));
                WaitHandle.WaitAny(waits);
                continue;
            }

            while (!_shutdown.IsCancellationRequested
                   && Stopwatch.GetTimestamp() < next.WakeAtTicks)
            {
                Thread.SpinWait(32);
            }

            ReleaseDueJobs(Stopwatch.GetTimestamp());
        }
    }

    private void ReleaseDueJobs(long now)
    {
        List<ScheduledJob>? due = null;

        lock (_gate)
        {
            RemoveStaleQueueEntries();

            while (_queue.Count > 0
                   && _queue.Peek().WakeAtTicks <= now)
            {
                var job = _queue.Dequeue();

                if (_jobs.TryGetValue(job.Id, out var current)
                    && ReferenceEquals(current, job)
                    && _jobs.TryRemove(
                        new KeyValuePair<Guid, ScheduledJob>(job.Id, job)))
                {
                    (due ??= []).Add(job);
                }

                RemoveStaleQueueEntries();
            }
        }

        if (due is null)
        {
            return;
        }

        foreach (var job in due)
        {
            job.TryComplete(SnipeJobState.Released, now);
        }
    }

    private void ExpireJobs(long now)
    {
        foreach (var pair in _jobs)
        {
            if (pair.Value.ExpiresAtTicks > now)
            {
                continue;
            }

            if (_jobs.TryRemove(pair))
            {
                pair.Value.TryComplete(SnipeJobState.Expired, now);
            }
        }
    }

    private void RemoveStaleQueueEntries()
    {
        while (_queue.Count > 0)
        {
            var candidate = _queue.Peek();

            if (_jobs.TryGetValue(candidate.Id, out var current)
                && ReferenceEquals(candidate, current))
            {
                return;
            }

            _queue.Dequeue();
        }
    }

    private static long MillisecondsToTicks(double milliseconds) =>
        checked((long)Math.Ceiling(
            milliseconds * Stopwatch.Frequency / 1000d));

    private static TimeSpan TicksToTimeSpan(long ticks) =>
        TimeSpan.FromSeconds(ticks / (double)Stopwatch.Frequency);
}

public sealed class ScheduledJob
{
    public ScheduledJob(
        Guid id,
        long generation,
        long fireAtTicks,
        long wakeAtTicks,
        long expiresAtTicks)
    {
        Id = id;
        Generation = generation;
        FireAtTicks = fireAtTicks;
        WakeAtTicks = wakeAtTicks;
        ExpiresAtTicks = expiresAtTicks;
    }

    public Guid Id { get; }
    public long Generation { get; }
    public long FireAtTicks { get; }
    public long WakeAtTicks { get; }
    public long ExpiresAtTicks { get; }
    public TaskCompletionSource<SnipeJobResult> Completion { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public bool TryComplete(SnipeJobState state, long completedAtTicks) =>
        Completion.TrySetResult(new SnipeJobResult(
            state,
            Generation,
            FireAtTicks,
            WakeAtTicks,
            completedAtTicks));
}

public sealed record SnipeJobResult(
    SnipeJobState State,
    long Generation,
    long FireAtTicks,
    long WakeAtTicks,
    long CompletedAtTicks);

public sealed record SnipeRegistration(
    bool Accepted,
    SnipeRegistrationFailure Failure,
    Task<SnipeJobResult>? Completion)
{
    public static SnipeRegistration AcceptedJob(
        Task<SnipeJobResult> completion) =>
        new(true, SnipeRegistrationFailure.None, completion);

    public static SnipeRegistration Rejected(
        SnipeRegistrationFailure failure) =>
        new(false, failure, null);
}

public enum SnipeRegistrationFailure
{
    None,
    Capacity,
    StaleGeneration,
    InvalidDeadline
}

public enum SnipeJobState
{
    Released,
    Cancelled,
    Disconnected,
    Superseded,
    Expired
}
