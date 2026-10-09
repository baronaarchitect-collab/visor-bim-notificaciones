using System.IO;
using Autodesk.Revit.DB;

namespace BimHubPublisher;

/// <summary>Un plano (sheet) del documento, listado en el diálogo.</summary>
public class SheetItem
{
    public required ElementId Id { get; init; }
    public required string Number { get; init; }
    public required string Name { get; init; }
    public bool Selected { get; set; }
    public string Display => $"{Number} — {Name}";
}

/// <summary>Exportaciones nativas de Revit: modelo a IFC y planos a PDF.</summary>
public static class RevitExporter
{
    public static List<SheetItem> GetSheets(Document doc)
    {
        return new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsPlaceholder && s.CanBePrinted)
            .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
            .Select(s => new SheetItem { Id = s.Id, Number = s.SheetNumber, Name = s.Name })
            .ToList();
    }

    /// <summary>La vista 3D usada para exportar (primera 3D no-plantilla imprimible), o null.
    /// Se comparte con <see cref="MetadataExtractor"/> para que la metadata cubra los mismos
    /// elementos que el IFC.</summary>
    public static View3D? PickExportView(Document doc) =>
        new FilteredElementCollector(doc)
            .OfClass(typeof(View3D))
            .Cast<View3D>()
            .FirstOrDefault(v => !v.IsTemplate && v.CanBePrinted);

    /// <summary>Exporta el modelo completo a IFC. Devuelve la ruta del archivo generado.</summary>
    public static string ExportIfc(Document doc, string folder, string baseName)
    {
        Directory.CreateDirectory(folder);

        var options = new IFCExportOptions
        {
            FileVersion = IFCVersion.IFC2x3CV2,
            ExportBaseQuantities = false,
            WallAndColumnSplitting = false,
        };

        // Exportamos el MODELO COMPLETO (sin FilterViewId): filtrar por una vista
        // 3D arbitraria puede dar un IFC vacío si esa vista está recortada o con
        // elementos ocultos. Sin filtro, se garantiza la geometría del modelo.
        // (Antes: options.FilterViewId = PickExportView(doc)?.Id, que producía IFC vacío.)

        // El exportador IFC necesita una transacción abierta; se revierte para
        // no dejar cambios en el documento (el archivo en disco se conserva).
        using var tx = new Transaction(doc, "Exportar IFC (BIM Hub)");
        tx.Start();
        bool ok;
        try
        {
            ok = doc.Export(folder, baseName, options);
        }
        finally
        {
            tx.RollBack();
        }
        if (!ok) throw new InvalidOperationException("Revit no pudo exportar el modelo a IFC.");

        string path = Path.Combine(folder, baseName + ".ifc");
        if (!File.Exists(path))
        {
            // Algunas versiones respetan el nombre tal cual si ya trae extensión.
            string alt = Path.Combine(folder, baseName);
            if (File.Exists(alt)) path = alt;
            else throw new FileNotFoundException("No se encontró el IFC exportado.", path);
        }
        return path;
    }

    /// <summary>Exporta un plano a PDF. Devuelve la ruta del archivo generado.</summary>
    public static string ExportSheetPdf(Document doc, SheetItem sheet, string folder, string baseName)
    {
        Directory.CreateDirectory(folder);

        var options = new PDFExportOptions
        {
            Combine = true,          // un único archivo…
            FileName = baseName,     // …con este nombre (exportamos plano por plano)
            HideCropBoundaries = true,
            HideScopeBoxes = true,
            HideReferencePlane = true,
            HideUnreferencedViewTags = true,
            ColorDepth = ColorDepthType.Color,
            PaperFormat = ExportPaperFormat.Default, // usa el tamaño del plano
        };

        bool ok = doc.Export(folder, new List<ElementId> { sheet.Id }, options);
        if (!ok) throw new InvalidOperationException($"Revit no pudo exportar el plano {sheet.Number} a PDF.");

        string path = Path.Combine(folder, baseName + ".pdf");
        if (!File.Exists(path))
            throw new FileNotFoundException($"No se encontró el PDF exportado del plano {sheet.Number}.", path);
        return path;
    }
}
