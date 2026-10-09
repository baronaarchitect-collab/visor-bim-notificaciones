using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BimHubPublisher;

public class HubProject
{
    [JsonPropertyName("slug")] public string Slug { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("share_id")] public string ShareId { get; set; } = "";
    public override string ToString() => Name;
}

/// <summary>
/// Cliente del BIM Hub (Cloudflare Worker). Se autentica con un token "hub_…" creado por un
/// administrador en la web. Los archivos van al bucket R2 privado a través del Worker:
/// directos si pesan ≤ 80 MB, o por partes (multipart R2) si son más grandes.
/// </summary>
public class HubClient : IDisposable
{
    const long DirectLimit = 80L * 1024 * 1024;
    const int PartSize = 64 * 1024 * 1024;   // todas las partes (menos la última) deben medir igual
    static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    readonly HttpClient _http;
    public string BaseUrl { get; }

    public HubClient(string baseUrl, string token)
    {
        BaseUrl = baseUrl.Trim().TrimEnd('/');
        _http = new HttpClient { BaseAddress = new Uri(BaseUrl + "/"), Timeout = TimeSpan.FromMinutes(30) };
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("BimHubPublisher/1.0");
    }

    public void Dispose() => _http.Dispose();

    public string ProjectUrl(HubProject p) => $"{BaseUrl}/p/{p.ShareId}";

    // ── Proyectos ────────────────────────────────────────────────

    public async Task<List<HubProject>> ListProjectsAsync()
    {
        using JsonDocument doc = await SendJsonAsync(HttpMethod.Get, "api/me", null);
        if (!doc.RootElement.TryGetProperty("admin", out JsonElement admin) || admin.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException("El token no tiene permisos de publicación.");
        return doc.RootElement.GetProperty("projects").Deserialize<List<HubProject>>(JsonOpts) ?? new();
    }

    /// <summary>Crea el proyecto (o devuelve el existente con el mismo nombre).</summary>
    public async Task<HubProject> CreateProjectAsync(string name)
    {
        using JsonDocument doc = await SendJsonAsync(HttpMethod.Post, "api/admin/projects", new { name });
        return doc.RootElement.Deserialize<HubProject>(JsonOpts)!;
    }

    public async Task RegisterModelAsync(string slug, string id, string name, string fileKey, string? metaKey, string? schedulesKey, long size)
    {
        using var _ = await SendJsonAsync(HttpMethod.Post, $"api/admin/projects/{slug}/models",
            new { id, name, file_key = fileKey, meta_key = metaKey, schedules_key = schedulesKey, size });
    }

    /// <param name="grupo">Grupo del plano en el visor: el modelo que lo contiene.</param>
    public async Task RegisterPlanoAsync(string slug, string grupo, string number, string name, string fileKey)
    {
        using var _ = await SendJsonAsync(HttpMethod.Post, $"api/admin/projects/{slug}/planos",
            new { grupo, number, name, file_key = fileKey });
    }

    // ── Subidas ──────────────────────────────────────────────────

    public async Task UploadTextAsync(string slug, string key, string text, string contentType)
    {
        var content = new ByteArrayContent(Encoding.UTF8.GetBytes(text));
        content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        using HttpResponseMessage r = await _http.PutAsync($"api/admin/projects/{slug}/upload?key={Uri.EscapeDataString(key)}", content);
        await EnsureOk(r);
    }

    /// <param name="progress">progress(bytesSubidos, total)</param>
    public async Task UploadFileAsync(string slug, string key, string path, string contentType, Action<long, long>? progress = null)
    {
        long total = new FileInfo(path).Length;
        if (total <= DirectLimit)
        {
            using FileStream fs = File.OpenRead(path);
            var content = new StreamContent(fs);
            content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
            content.Headers.ContentLength = total;
            using HttpResponseMessage r = await _http.PutAsync($"api/admin/projects/{slug}/upload?key={Uri.EscapeDataString(key)}", content);
            await EnsureOk(r);
            progress?.Invoke(total, total);
            return;
        }

        string uploadId;
        using (JsonDocument start = await SendJsonAsync(HttpMethod.Post, $"api/admin/projects/{slug}/upload/start", new { key, contentType }))
            uploadId = start.RootElement.GetProperty("uploadId").GetString()!;

        var parts = new List<object>();
        try
        {
            using FileStream fs = File.OpenRead(path);
            byte[] buffer = new byte[PartSize];
            long done = 0;
            for (int partNumber = 1; done < total; partNumber++)
            {
                int read = await ReadFullAsync(fs, buffer);
                string url = $"api/admin/projects/{slug}/upload/part?key={Uri.EscapeDataString(key)}&uploadId={Uri.EscapeDataString(uploadId)}&part={partNumber}";
                JsonElement part = await WithRetry(async () =>
                {
                    var content = new ByteArrayContent(buffer, 0, read);
                    content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                    using HttpResponseMessage r = await _http.PutAsync(url, content);
                    await EnsureOk(r);
                    using JsonDocument j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
                    return j.RootElement.Clone();
                });
                parts.Add(new { partNumber = part.GetProperty("partNumber").GetInt32(), etag = part.GetProperty("etag").GetString() });
                done += read;
                progress?.Invoke(done, total);
            }
            using var _ = await SendJsonAsync(HttpMethod.Post, $"api/admin/projects/{slug}/upload/complete", new { key, uploadId, parts });
        }
        catch
        {
            try { using var _ = await SendJsonAsync(HttpMethod.Post, $"api/admin/projects/{slug}/upload/abort", new { key, uploadId }); } catch { }
            throw;
        }
    }

    // ── Utilidades HTTP ──────────────────────────────────────────

    async Task<JsonDocument> SendJsonAsync(HttpMethod method, string path, object? body)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body != null)
            req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using HttpResponseMessage r = await _http.SendAsync(req);
        await EnsureOk(r);
        return JsonDocument.Parse(await r.Content.ReadAsStringAsync());
    }

    static async Task EnsureOk(HttpResponseMessage r)
    {
        if (r.IsSuccessStatusCode) return;
        string msg = await r.Content.ReadAsStringAsync();
        try { using JsonDocument j = JsonDocument.Parse(msg); if (j.RootElement.TryGetProperty("error", out JsonElement e)) msg = e.GetString() ?? msg; }
        catch { /* respuesta no JSON */ }
        if (r.StatusCode == System.Net.HttpStatusCode.Unauthorized) msg = "Token inválido o revocado (" + msg + ")";
        throw new HttpRequestException($"HTTP {(int)r.StatusCode}: {msg}");
    }

    static async Task<int> ReadFullAsync(Stream s, byte[] buffer)
    {
        int total = 0, n;
        while (total < buffer.Length && (n = await s.ReadAsync(buffer, total, buffer.Length - total)) > 0) total += n;
        return total;
    }

    static async Task<T> WithRetry<T>(Func<Task<T>> action)
    {
        for (int attempt = 1; ; attempt++)
        {
            try { return await action(); }
            catch (Exception) when (attempt < 3) { await Task.Delay(2000 * attempt); }
        }
    }
}
