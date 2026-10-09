using System.IO;

namespace BimHubPublisher;

public class ModelUpload
{
    public required string Name { get; init; }
    public required string LocalPath { get; init; }
    /// <summary>meta.json (metadata por elemento) generado desde Revit; null para IFC externos.</summary>
    public string? MetaJson { get; init; }
    /// <summary>schedules.json (tablas de cantidades) generado desde Revit; null para IFC externos.</summary>
    public string? SchedulesJson { get; init; }
}

public class PlanoUpload
{
    public required string Number { get; init; }
    public required string Name { get; init; }
    public required string LocalPath { get; init; }
}

public class PublishJob
{
    /// <summary>Proyecto existente; null = crear uno con <see cref="ProjectName"/>.</summary>
    public HubProject? Existing { get; init; }
    public required string ProjectName { get; init; }
    /// <summary>Nombre del modelo al que pertenecen los planos (así se agrupan en el visor).</summary>
    public string PlanoGroup { get; init; } = "General";
    public List<ModelUpload> Models { get; } = new();
    public List<PlanoUpload> Planos { get; } = new();
}

/// <summary>Sube modelos IFC (+ cantidades) y planos PDF al BIM Hub y los registra en el proyecto.</summary>
public class HubPublisher
{
    readonly HubClient _hub;
    public HubPublisher(HubClient hub) => _hub = hub;

    /// <param name="log">log(mensaje, nivel) — nivel: "run" | "ok" | "err"</param>
    /// <returns>El link del proyecto para compartir.</returns>
    public async Task<string> PublishAsync(PublishJob job, Action<string, string> log)
    {
        HubProject project = job.Existing ?? await _hub.CreateProjectAsync(job.ProjectName);
        string slug = project.Slug;
        log($"Proyecto \"{project.Name}\" listo", "ok");

        foreach (ModelUpload m in job.Models)
        {
            string id = Util.Slugify(m.Name);
            string fileKey = $"{slug}/modelos/{id}.ifc";
            long size = new FileInfo(m.LocalPath).Length;
            long sizeMb = size / 1048576;
            log($"Subiendo modelo \"{m.Name}\" ({sizeMb} MB)…", "run");

            int lastPct = -1;
            await _hub.UploadFileAsync(slug, fileKey, m.LocalPath, "application/octet-stream", (done, total) =>
            {
                int pct = (int)(done * 100 / Math.Max(total, 1));
                if (pct / 10 > lastPct / 10) { lastPct = pct; log($"   … {pct}% de {sizeMb} MB", "run"); }
            });

            string? metaKey = null, schedKey = null;
            if (!string.IsNullOrEmpty(m.MetaJson))
            {
                metaKey = $"{slug}/modelos/{id}.meta.json";
                await _hub.UploadTextAsync(slug, metaKey, m.MetaJson!, "application/json");
            }
            if (!string.IsNullOrEmpty(m.SchedulesJson))
            {
                schedKey = $"{slug}/modelos/{id}.schedules.json";
                await _hub.UploadTextAsync(slug, schedKey, m.SchedulesJson!, "application/json");
            }
            await _hub.RegisterModelAsync(slug, id, m.Name, fileKey, metaKey, schedKey, size);
            log($"Modelo \"{m.Name}\" publicado" + (metaKey != null ? " (con cantidades)" : ""), "ok");
        }

        foreach (PlanoUpload p in job.Planos)
        {
            string fileKey = $"{slug}/planos/{Util.Slugify(job.PlanoGroup)}/{Util.Slugify($"{p.Number} {p.Name}")}.pdf";
            log($"Subiendo plano {p.Number} — {p.Name}…", "run");
            await _hub.UploadFileAsync(slug, fileKey, p.LocalPath, "application/pdf");
            await _hub.RegisterPlanoAsync(slug, job.PlanoGroup, p.Number, p.Name, fileKey);
        }
        if (job.Planos.Count > 0) log($"{job.Planos.Count} plano(s) publicados", "ok");

        return _hub.ProjectUrl(project);
    }
}
