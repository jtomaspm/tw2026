namespace backend.Endpoints;

public class LAState
{
    public string CurrentVillage = string.Empty;
}

public static class StateEndpoints
{
    readonly static string BASE_ROUTE = "/state";

    public static IEndpointRouteBuilder MountStateEndpoints (
        this IEndpointRouteBuilder app
    ) {
        app.MapPost(BASE_ROUTE+"/current-village", PostCurrentVillage);
        app.MapGet(BASE_ROUTE+"/current-village", GetCurrentVillage);
        return app;
    }

    static IResult GetCurrentVillage (
        LAState state
    ) {
        return Results.Text(state.CurrentVillage);
    }

    static IResult PostCurrentVillage (
        string? village,
        LAState state
    ) {
        if (!Coordinate.TryNormalize(village, out var normalizedVillage))
            return Results.BadRequest("Invalid village coordinate. Use format 444|232.");
        state.CurrentVillage = normalizedVillage;
        return Results.Created();
    }

    static string AttackKey(string source, string target) =>
        $"attack:{source}:{target}";

}