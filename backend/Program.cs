using System.Collections.Concurrent;

// File watching can block application startup when the project is on a
// mapped/network drive. Native deployments read settings once at startup.
Environment.SetEnvironmentVariable(
    "DOTNET_HOSTBUILDER__RELOADCONFIGONCHANGE",
    "false");
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<ConcurrentDictionary<string, long>>();

var app = builder.Build();

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

app.Run();

static string AttackKey(string source, string target) =>
    $"attack:{source}:{target}";

public sealed record AttackRequest(string Source, string Target);
