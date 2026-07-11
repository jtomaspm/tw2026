namespace backend;
internal static class Coordinate
{
    public static bool TryNormalize(string? value, out string coordinate)
    {
        coordinate = "";

        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var parts = value.Trim().Split('|', StringSplitOptions.TrimEntries);

        if (parts.Length != 2
            || !int.TryParse(parts[0], out var x)
            || !int.TryParse(parts[1], out var y)
            || x < 0
            || y < 0)
        {
            return false;
        }

        coordinate = $"{x}|{y}";
        return true;
    }
}
