using System.Globalization;
using System.Text;

namespace BimHubPublisher;

public static class Util
{
    /// <summary>Convierte un nombre a slug URL-safe: "Torre Norte Ñ" → "torre-norte-n".</summary>
    public static string Slugify(string s)
    {
        string normalized = s.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder();
        foreach (char c in normalized)
        {
            var cat = CharUnicodeInfo.GetUnicodeCategory(c);
            if (cat == UnicodeCategory.NonSpacingMark) continue;
            char lc = char.ToLowerInvariant(c);
            if (lc is >= 'a' and <= 'z' or >= '0' and <= '9') sb.Append(lc);
            else sb.Append('-');
        }
        string slug = sb.ToString();
        while (slug.Contains("--")) slug = slug.Replace("--", "-");
        slug = slug.Trim('-');
        return string.IsNullOrEmpty(slug) ? "proyecto" : slug;
    }
}
