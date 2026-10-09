using System.Text.Json;
using System.Text.Json.Serialization;
using Autodesk.Revit.DB;

namespace BimHubPublisher;

// ── DTOs que viajan al visor como JSON ───────────────────────────

/// <summary>Un elemento del modelo, unido al 3D por <see cref="Tag"/> (= ElementId, que Revit
/// escribe en IfcElement.Tag al exportar el IFC).</summary>
public class ElementMeta
{
    public long Tag { get; set; }
    public string Cat { get; set; } = "";   // categoría
    public string Fam { get; set; } = "";   // familia
    public string Typ { get; set; } = "";   // tipo
    public string Lvl { get; set; } = "";   // nivel
    /// <summary>Cantidades por campo (ya en unidades de proyecto). Siempre incluye "Conteo"=1.</summary>
    public Dictionary<string, double> Q { get; set; } = new();
}

public class ScheduleFieldMeta
{
    public string Name { get; set; } = "";
    public string Unit { get; set; } = "";
}

/// <summary>Una Tabla de Cantidades de Revit: qué categoría cuenta y qué campos totaliza.</summary>
public class ScheduleMeta
{
    public string Name { get; set; } = "";
    public string Cat { get; set; } = "";
    public List<ScheduleFieldMeta> Fields { get; set; } = new();
}

/// <summary>Extrae metadata por elemento y las tablas de cantidades del documento y las
/// serializa a los JSON que consume el visor 3D (meta.json y schedules.json).</summary>
public static class MetadataExtractor
{
    static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    class FieldDef
    {
        public string Name = "";
        public ElementId? ParamId;
        public ForgeTypeId? Unit;
    }

    /// <summary>Construye los dos JSON. <paramref name="filterViewId"/> = la misma vista 3D usada
    /// para exportar el IFC, para que la metadata cubra exactamente los mismos elementos.</summary>
    public static (string metaJson, string schedulesJson, int elementCount) BuildJson(
        Document doc, ElementId? filterViewId)
    {
        var warnings = new List<string>();

        // 1) Tablas de cantidades → por categoría, qué campos se totalizan (con su parámetro y unidad).
        var schedules = new List<ScheduleMeta>();
        var catFields = new Dictionary<string, Dictionary<string, FieldDef>>(StringComparer.OrdinalIgnoreCase);
        CollectSchedules(doc, schedules, catFields, warnings);

        // 2) Elementos del modelo (los mismos que van al IFC).
        var elements = new List<ElementMeta>();
        FilteredElementCollector collector =
            filterViewId != null && filterViewId != ElementId.InvalidElementId
                ? new FilteredElementCollector(doc, filterViewId)
                : new FilteredElementCollector(doc).WhereElementIsViewIndependent();

        foreach (Element e in collector.WhereElementIsNotElementType())
        {
            Category? cat = null;
            try { cat = e.Category; } catch { }
            if (cat == null || cat.CategoryType != CategoryType.Model) continue;

            string catName = SafeName(cat.Name);
            var em = new ElementMeta
            {
                Tag = IdValue(e.Id),
                Cat = catName,
                Lvl = LevelName(doc, e),
            };
            (em.Fam, em.Typ) = TypeInfo(doc, e);

            var q = new Dictionary<string, double> { ["Conteo"] = 1 };
            if (catFields.TryGetValue(catName, out Dictionary<string, FieldDef>? fdefs))
                foreach (FieldDef fd in fdefs.Values)
                {
                    try
                    {
                        double? v = ReadParamValue(e, fd.ParamId, fd.Unit);
                        if (v.HasValue) q[fd.Name] = Round(v.Value);
                    }
                    catch { /* campo no legible en este elemento */ }
                }
            // Cantidades genéricas útiles aunque la categoría no tenga tabla.
            TryAddGeneric(doc, e, q, "Longitud", BuiltInParameter.CURVE_ELEM_LENGTH, SpecTypeId.Length);
            TryAddGeneric(doc, e, q, "Área", BuiltInParameter.HOST_AREA_COMPUTED, SpecTypeId.Area);
            TryAddGeneric(doc, e, q, "Volumen", BuiltInParameter.HOST_VOLUME_COMPUTED, SpecTypeId.Volume);
            em.Q = q;

            elements.Add(em);
        }

        string metaJson = JsonSerializer.Serialize(elements, JsonOpts);
        string schedulesJson = JsonSerializer.Serialize(
            new SchedulesPayload { Schedules = schedules, Warnings = warnings, Units = GenericUnits(doc) }, JsonOpts);
        return (metaJson, schedulesJson, elements.Count);
    }

    class SchedulesPayload
    {
        public List<ScheduleMeta> Schedules { get; set; } = new();
        public List<string> Warnings { get; set; } = new();
        /// <summary>Unidad de las cantidades genericas (Longitud, Area, Volumen) segun las unidades del proyecto.</summary>
        public Dictionary<string, string> Units { get; set; } = new();
    }

    static Dictionary<string, string> GenericUnits(Document doc)
    {
        var units = new Dictionary<string, string>();
        foreach ((string label, ForgeTypeId spec) in new[] {
                     ("Longitud", SpecTypeId.Length), ("Área", SpecTypeId.Area), ("Volumen", SpecTypeId.Volume) })
        {
            try { units[label] = LabelUtils.GetLabelForUnit(doc.GetUnits().GetFormatOptions(spec).GetUnitTypeId()); }
            catch { /* sin unidad */ }
        }
        return units;
    }

    // ── Tablas de cantidades ─────────────────────────────────────

    static void CollectSchedules(Document doc, List<ScheduleMeta> schedules,
        Dictionary<string, Dictionary<string, FieldDef>> catFields, List<string> warnings)
    {
        foreach (ViewSchedule vs in new FilteredElementCollector(doc)
                     .OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>())
        {
            if (vs.IsTemplate) continue;
            try
            {
                ScheduleDefinition def = vs.Definition;
                if (def == null) continue;
                ElementId catId = def.CategoryId;
                Category? cat = (catId != null && catId != ElementId.InvalidElementId)
                    ? Category.GetCategory(doc, catId) : null;
                if (cat == null || cat.CategoryType != CategoryType.Model) continue; // ignora tablas de anotación/clave

                string catName = SafeName(cat.Name);
                var sm = new ScheduleMeta { Name = vs.Name, Cat = catName };

                int n = def.GetFieldCount();
                for (int i = 0; i < n; i++)
                {
                    ScheduleField f;
                    try { f = def.GetField(i); } catch { continue; }
                    // DisplayType == Totals equivale a la casilla "Calcular totales" del campo.
                    if (f.DisplayType != ScheduleFieldDisplayType.Totals) continue;

                    string fname = f.GetName();
                    ForgeTypeId? unit = null;
                    string unitLabel = "";
                    try
                    {
                        ForgeTypeId spec = f.GetSpecTypeId();
                        if (spec != null && !spec.Empty())
                        {
                            FormatOptions fo = doc.GetUnits().GetFormatOptions(spec);
                            unit = fo.GetUnitTypeId();
                            if (unit != null && !unit.Empty())
                                try { unitLabel = LabelUtils.GetLabelForUnit(unit); } catch { }
                        }
                    }
                    catch { }

                    sm.Fields.Add(new ScheduleFieldMeta { Name = fname, Unit = unitLabel });

                    if (!catFields.TryGetValue(catName, out Dictionary<string, FieldDef>? fd))
                    {
                        fd = new Dictionary<string, FieldDef>(StringComparer.OrdinalIgnoreCase);
                        catFields[catName] = fd;
                    }
                    if (!fd.ContainsKey(fname))
                        fd[fname] = new FieldDef { Name = fname, ParamId = f.ParameterId, Unit = unit };
                }

                if (sm.Fields.Count > 0) schedules.Add(sm);
            }
            catch (Exception ex)
            {
                warnings.Add($"No se pudo leer la tabla '{Try(() => vs.Name)}': {ex.Message}");
            }
        }
    }

    // ── Helpers de elemento ──────────────────────────────────────

    static (string fam, string typ) TypeInfo(Document doc, Element e)
    {
        try
        {
            ElementId tid = e.GetTypeId();
            if (tid != null && tid != ElementId.InvalidElementId && doc.GetElement(tid) is Element et)
            {
                string typ = SafeName(et.Name);
                string fam = et is ElementType etype ? SafeName(etype.FamilyName) : "";
                return (fam, string.IsNullOrEmpty(typ) ? SafeName(e.Name) : typ);
            }
        }
        catch { }
        return ("", SafeName(Try(() => e.Name)));
    }

    static readonly BuiltInParameter[] LevelParams =
    {
        BuiltInParameter.FAMILY_LEVEL_PARAM,
        BuiltInParameter.SCHEDULE_LEVEL_PARAM,
        BuiltInParameter.RBS_START_LEVEL_PARAM,
        BuiltInParameter.LEVEL_PARAM,
    };

    static string LevelName(Document doc, Element e)
    {
        ElementId lid = ElementId.InvalidElementId;
        try { lid = e.LevelId; } catch { }

        if (lid == ElementId.InvalidElementId)
            foreach (BuiltInParameter bip in LevelParams)
            {
                try
                {
                    Parameter p = e.get_Parameter(bip);
                    if (p != null && p.StorageType == StorageType.ElementId)
                    {
                        ElementId v = p.AsElementId();
                        if (v != null && v != ElementId.InvalidElementId) { lid = v; break; }
                    }
                }
                catch { }
            }

        if (lid != ElementId.InvalidElementId && doc.GetElement(lid) is Level lvl)
            return SafeName(lvl.Name);
        return "Sin nivel";
    }

    static double? ReadParamValue(Element e, ElementId? pid, ForgeTypeId? unit)
    {
        if (pid == null) return null;
        int id = IdInt(pid);
        Parameter? p = null;
        if (id < 0)
            try { p = e.get_Parameter((BuiltInParameter)id); } catch { p = null; }
        if (p == null)
            foreach (Parameter pp in e.Parameters)
                if (IdInt(pp.Id) == id) { p = pp; break; }

        if (p == null || !p.HasValue) return null;
        switch (p.StorageType)
        {
            case StorageType.Double:
                double raw = p.AsDouble();
                if (unit != null && !unit.Empty())
                    try { return UnitUtils.ConvertFromInternalUnits(raw, unit); } catch { return raw; }
                return raw;
            case StorageType.Integer:
                return p.AsInteger();
            default:
                return null;
        }
    }

    static void TryAddGeneric(Document doc, Element e, Dictionary<string, double> q,
        string label, BuiltInParameter bip, ForgeTypeId spec)
    {
        if (q.ContainsKey(label)) return;
        Parameter? p;
        try { p = e.get_Parameter(bip); } catch { return; }
        if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return;
        double raw = p.AsDouble();
        if (raw <= 0) return;
        double val = raw;
        try
        {
            FormatOptions fo = doc.GetUnits().GetFormatOptions(spec);
            val = UnitUtils.ConvertFromInternalUnits(raw, fo.GetUnitTypeId());
        }
        catch { }
        q[label] = Round(val);
    }

    // ── Utilidades ───────────────────────────────────────────────

    static double Round(double v) => Math.Round(v, 4);

    static string SafeName(string? s) => string.IsNullOrWhiteSpace(s) ? "(sin nombre)" : s!.Trim();

    static string Try(Func<string> f) { try { return f() ?? ""; } catch { return "?"; } }

    /// <summary>ElementId → valor. En Revit 2025 es long (Value); en 2024 es int (IntegerValue).</summary>
    static long IdValue(ElementId id)
    {
#if REVIT2025
        return id.Value;
#else
        return id.IntegerValue;
#endif
    }

    static int IdInt(ElementId id)
    {
#if REVIT2025
        return unchecked((int)id.Value);
#else
        return id.IntegerValue;
#endif
    }
}
