using System.Collections.Concurrent;

namespace backend.Endpoints;

public sealed record AttackRequest(string Source, string Target);

public static class AttackEndpoints
{
    readonly static string BASE_ROUTE = "/attack";

    public static IEndpointRouteBuilder MountAttackEndpoints (
        this IEndpointRouteBuilder app
    ) {
        app.MapPost(BASE_ROUTE, PostAttack);
        app.MapGet(BASE_ROUTE + "/timings", GetAttackTimings);
        app.MapGet(BASE_ROUTE, GetAttack);
        return app;
    }

    static IResult PostAttack (
        AttackRequest request,
        ConcurrentDictionary<string, long> attackHistory
    ) {
        if (!Coordinate.TryNormalize(request.Source, out var source))
            return Results.BadRequest(
                "Invalid source coordinate. Use format 444|232.");

        if (!Coordinate.TryNormalize(request.Target, out var target))
            return Results.BadRequest(
                "Invalid target coordinate. Use format 444|232.");

        attackHistory[AttackKey(source, target)] =
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        return Results.NoContent();
    }

    static IResult GetAttack (
        string? source,
        string? target,
        ConcurrentDictionary<string, long> attackHistory
    ) {
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
    }

    static IResult GetAttackTimings (
        string? source,
        string[] targets,
        ConcurrentDictionary<string, long> attackHistory
    ) {
        if (!Coordinate.TryNormalize(source, out var normalizedSource))
            return Results.BadRequest(
                "Invalid source coordinate. Use format 444|232.");

        var normalizedTargets = new string[targets.Length];
        for (var i = 0; i < targets.Length; i++)
        {
            if (!Coordinate.TryNormalize(targets[i], out normalizedTargets[i]))
                return Results.BadRequest(
                    "Invalid target coordinate. Use format 444|232.");
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var timings = new Dictionary<string, long>(normalizedTargets.Length);
        foreach (var target in normalizedTargets)
        {
            if (attackHistory.TryGetValue(AttackKey(normalizedSource, target), out var attackedAt))
                timings[target] = now - attackedAt;
        }

        return Results.Json(timings);
    }

    static string AttackKey(string source, string target) =>
        $"attack:{source}:{target}";

}
