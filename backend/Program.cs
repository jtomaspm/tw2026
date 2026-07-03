using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Options;

// File watching can block application startup when the project is on a
// mapped/network drive. Native deployments read settings once at startup.
Environment.SetEnvironmentVariable(
    "DOTNET_HOSTBUILDER__RELOADCONFIGONCHANGE",
    "false");
var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddOptions<SnipeSchedulerOptions>()
    .Bind(builder.Configuration.GetSection(SnipeSchedulerOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddSingleton<ConcurrentDictionary<string, long>>();
builder.Services.AddSingleton<SnipeScheduler>();
builder.Services.AddHostedService(serviceProvider =>
    serviceProvider.GetRequiredService<SnipeScheduler>());

var app = builder.Build();
var requestReceivedTicksKey = new object();

app.Use((context, next) =>
{
    context.Items[requestReceivedTicksKey] = Stopwatch.GetTimestamp();
    return next(context);
});

app.MapPost("/attack", (
    AttackRequest request,
    ConcurrentDictionary<string, long> attackHistory) =>
{
    if (!Coordinate.TryNormalize(request.Source, out var source))
    {
        return Results.BadRequest("Invalid source coordinate. Use format 444|232.");
    }

    if (!Coordinate.TryNormalize(request.Target, out var target))
    {
        return Results.BadRequest("Invalid target coordinate. Use format 444|232.");
    }

    attackHistory[AttackKey(source, target)] =
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    return Results.NoContent();
});

app.MapGet("/attack", (
    string? source,
    string? target,
    ConcurrentDictionary<string, long> attackHistory) =>
{
    if (!Coordinate.TryNormalize(source, out var normalizedSource))
    {
        return Results.BadRequest("Invalid source coordinate. Use format 444|232.");
    }

    if (!Coordinate.TryNormalize(target, out var normalizedTarget))
    {
        return Results.BadRequest("Invalid target coordinate. Use format 444|232.");
    }

    if (!attackHistory.TryGetValue(
            AttackKey(normalizedSource, normalizedTarget),
            out var lastAttackAt))
    {
        return Results.NotFound();
    }

    var elapsedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - lastAttackAt;
    return Results.Text(elapsedMs.ToString(), "text/plain");
});

app.MapGet("/snipe/v1/health", (
    SnipeScheduler scheduler,
    IOptions<SnipeSchedulerOptions> options) =>
{
    var settings = options.Value;

    return Results.Json(new SnipeHealthResponse(
        Status: "ready",
        ActiveJobs: scheduler.ActiveJobCount,
        Frequency: Stopwatch.Frequency,
        WakeLeadMilliseconds: settings.WakeLeadMilliseconds,
        MaximumWakeLeadMilliseconds: settings.MaximumWakeLeadMilliseconds,
        LateToleranceMilliseconds: settings.LateToleranceMilliseconds,
        ReconnectWindowMilliseconds: settings.ReconnectWindowMilliseconds,
        MaximumJobs: settings.MaximumJobs));
});

app.MapGet("/snipe/v1/clock", async (HttpContext context) =>
{
    var receivedTicks = Stopwatch.GetTimestamp();
    context.Response.ContentType = "application/json";
    var sentTicks = Stopwatch.GetTimestamp();

    await context.Response.WriteAsJsonAsync(
        new SnipeClockResponse(receivedTicks, sentTicks, Stopwatch.Frequency),
        context.RequestAborted);
});

app.MapPost("/snipe/v1/jobs/{jobId:guid}/wait", async (
    Guid jobId,
    SnipeWaitRequest request,
    SnipeScheduler scheduler,
    HttpContext context) =>
{
    var receivedAtTicks = context.Items.TryGetValue(
        requestReceivedTicksKey,
        out var receivedAt)
        && receivedAt is long ticks
            ? ticks
            : Stopwatch.GetTimestamp();

    var registration = request.FireInMilliseconds is double fireInMilliseconds
        ? scheduler.RegisterAfter(
            jobId,
            request.Generation,
            fireInMilliseconds,
            receivedAtTicks,
            request.WakeLeadMilliseconds)
        : scheduler.Register(
            jobId,
            request.Generation,
            request.FireAtTicks ?? 0);

    if (!registration.Accepted)
    {
        return registration.Failure switch
        {
            SnipeRegistrationFailure.Capacity =>
                Results.Problem(
                    "The scheduler has reached its configured job limit.",
                    statusCode: StatusCodes.Status503ServiceUnavailable),
            SnipeRegistrationFailure.StaleGeneration =>
                Results.Conflict(new { error = "stale_generation" }),
            SnipeRegistrationFailure.InvalidDeadline =>
                Results.BadRequest("The supplied monotonic deadline is invalid."),
            _ => Results.BadRequest()
        };
    }

    try
    {
        var result = await registration.Completion!.WaitAsync(
            context.RequestAborted);

        return result.State switch
        {
            SnipeJobState.Released => Results.Json(new SnipeWaitResponse(
                jobId,
                result.Generation,
                result.FireAtTicks,
                result.WakeAtTicks,
                result.CompletedAtTicks)),
            SnipeJobState.Superseded =>
                Results.Conflict(new { error = "superseded" }),
            SnipeJobState.Expired =>
                Results.Problem(
                    "The scheduled job expired.",
                    statusCode: StatusCodes.Status410Gone),
            _ => Results.Problem(
                "The scheduled job was cancelled.",
                statusCode: StatusCodes.Status410Gone)
        };
    }
    catch (OperationCanceledException)
    {
        scheduler.Cancel(
            jobId,
            request.Generation,
            SnipeJobState.Disconnected);

        return Results.Empty;
    }
});

app.MapDelete("/snipe/v1/jobs/{jobId:guid}", (
    Guid jobId,
    long generation,
    SnipeScheduler scheduler) =>
{
    scheduler.Cancel(jobId, generation, SnipeJobState.Cancelled);
    return Results.NoContent();
});

app.Run();

static string AttackKey(string source, string target) =>
    $"attack:{source}:{target}";

public sealed record AttackRequest(string Source, string Target);

public sealed record SnipeWaitRequest(
    long Generation,
    long? FireAtTicks,
    double? FireInMilliseconds,
    double? WakeLeadMilliseconds);

public sealed record SnipeWaitResponse(
    Guid JobId,
    long Generation,
    long FireAtTicks,
    long WakeAtTicks,
    long ReleasedAtTicks);

public sealed record SnipeClockResponse(
    long ReceivedTicks,
    long SentTicks,
    long Frequency);

public sealed record SnipeHealthResponse(
    string Status,
    int ActiveJobs,
    long Frequency,
    double WakeLeadMilliseconds,
    double MaximumWakeLeadMilliseconds,
    double LateToleranceMilliseconds,
    double ReconnectWindowMilliseconds,
    int MaximumJobs);
