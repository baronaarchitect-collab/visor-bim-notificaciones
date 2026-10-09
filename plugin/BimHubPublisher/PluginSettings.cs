using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BimHubPublisher;

/// <summary>Configuración persistente (%AppData%\BimHubPublisher\settings.json).
/// El token se guarda cifrado con DPAPI (solo lo puede leer este usuario de Windows).</summary>
public class PluginSettings
{
    public const string DefaultHubUrl = "https://bim-hub-visor.lifecity.workers.dev";

    public string HubUrl { get; set; } = DefaultHubUrl;
    public string TokenProtected { get; set; } = "";
    public bool Remember { get; set; } = true;

    static string FilePath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BimHubPublisher", "settings.json");

    [System.Text.Json.Serialization.JsonIgnore]
    public string Token
    {
        get
        {
            if (string.IsNullOrEmpty(TokenProtected)) return "";
            try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(TokenProtected), null, DataProtectionScope.CurrentUser)); }
            catch { return ""; }
        }
        set => TokenProtected = string.IsNullOrEmpty(value) ? ""
            : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    }

    public static PluginSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<PluginSettings>(File.ReadAllText(FilePath)) ?? new();
        }
        catch { /* configuración corrupta → empezar de cero */ }
        return new PluginSettings();
    }

    public void Save()
    {
        if (!Remember) TokenProtected = "";
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
