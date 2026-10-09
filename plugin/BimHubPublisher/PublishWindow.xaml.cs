using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Autodesk.Revit.DB;
using Microsoft.Win32;

namespace BimHubPublisher;

public partial class PublishWindow : Window
{
    readonly Document _doc;
    readonly ObservableCollection<SheetItem> _sheets = new();
    readonly ObservableCollection<string> _extraIfcs = new();
    string? _resultUrl;

    public PublishWindow(Document doc)
    {
        _doc = doc;
        InitializeComponent();

        foreach (SheetItem s in RevitExporter.GetSheets(doc)) _sheets.Add(s);
        lbSheets.ItemsSource = _sheets;
        lbExtraIfc.ItemsSource = _extraIfcs;
        tbSheetCount.Text = $"{_sheets.Count} planos en el documento";

        tbProjectName.Text = doc.Title;
        tbModelName.Text = doc.Title;

        PluginSettings s0 = PluginSettings.Load();
        tbHubUrl.Text = string.IsNullOrWhiteSpace(s0.HubUrl) ? PluginSettings.DefaultHubUrl : s0.HubUrl;
        pbToken.Password = s0.Token;
        chkRemember.IsChecked = s0.Remember;
    }

    // ── Helpers ──────────────────────────────────────────────────

    void Log(string msg, string level = "")
    {
        string prefix = level switch { "ok" => "✔ ", "err" => "✖ ", "run" => "· ", _ => "" };
        Dispatcher.Invoke(() =>
        {
            tbLog.AppendText(prefix + msg + Environment.NewLine);
            tbLog.ScrollToEnd();
        });
    }

    HubClient? BuildClient()
    {
        string url = tbHubUrl.Text.Trim();
        string token = pbToken.Password.Trim();
        if (!url.StartsWith("http")) { Log("Indica la URL del hub (https://…).", "err"); return null; }
        if (!token.StartsWith("hub_")) { Log("Pega el token de publicación (empieza por hub_). Se crea en la web del hub → Administración.", "err"); return null; }
        return new HubClient(url, token);
    }

    void SaveSettings()
    {
        new PluginSettings
        {
            HubUrl = tbHubUrl.Text.Trim(),
            Token = chkRemember.IsChecked == true ? pbToken.Password.Trim() : "",
            Remember = chkRemember.IsChecked == true,
        }.Save();
    }

    // ── Eventos UI ───────────────────────────────────────────────

    async void Connect_Click(object sender, RoutedEventArgs e)
    {
        using HubClient? hub = BuildClient();
        if (hub == null) return;
        btnConnect.IsEnabled = false;
        try
        {
            Log("Conectando con el hub…", "run");
            List<HubProject> projects = await hub.ListProjectsAsync();
            Log("Conectado", "ok");
            cbProjects.ItemsSource = projects;
            cbProjects.IsEnabled = projects.Count > 0;
            if (projects.Count > 0) cbProjects.SelectedIndex = 0;
            Log($"{projects.Count} proyecto(s) en el hub", "ok");
            SaveSettings();
        }
        catch (Exception ex) { Log(ex.Message, "err"); }
        finally { btnConnect.IsEnabled = true; }
    }

    void ProjectMode_Changed(object sender, RoutedEventArgs e)
    {
        if (tbProjectName == null || cbProjects == null) return; // durante InitializeComponent
        tbProjectName.IsEnabled = rbNew.IsChecked == true;
        cbProjects.IsEnabled = rbExisting.IsChecked == true && cbProjects.Items.Count > 0;
    }

    void AddIfc_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Filter = "Modelos IFC (*.ifc)|*.ifc",
            Multiselect = true,
            Title = "Agregar modelos IFC al proyecto",
        };
        if (dlg.ShowDialog() == true)
            foreach (string f in dlg.FileNames)
                if (!_extraIfcs.Contains(f)) _extraIfcs.Add(f);
    }

    void RemoveIfc_Click(object sender, RoutedEventArgs e)
    {
        if (lbExtraIfc.SelectedItem is string sel) _extraIfcs.Remove(sel);
    }

    void SelectAll_Click(object sender, RoutedEventArgs e) => SetAllSheets(true);
    void SelectNone_Click(object sender, RoutedEventArgs e) => SetAllSheets(false);

    void SetAllSheets(bool value)
    {
        foreach (SheetItem s in _sheets) s.Selected = value;
        lbSheets.Items.Refresh();
    }

    async void Publish_Click(object sender, RoutedEventArgs e)
    {
        HubClient? hub = BuildClient();
        if (hub == null) return;

        // Proyecto destino
        string projectName;
        HubProject? existing = null;
        if (rbExisting.IsChecked == true)
        {
            if (cbProjects.SelectedItem is not HubProject sel)
            { Log("Selecciona un proyecto existente (pulsa Conectar primero).", "err"); hub.Dispose(); return; }
            projectName = sel.Name;
            existing = sel;
        }
        else
        {
            projectName = tbProjectName.Text.Trim();
            if (string.IsNullOrWhiteSpace(projectName)) { Log("Indica el nombre del proyecto.", "err"); hub.Dispose(); return; }
        }

        bool exportModel = chkExportModel.IsChecked == true;
        List<SheetItem> selectedSheets = _sheets.Where(s => s.Selected).ToList();
        if (!exportModel && _extraIfcs.Count == 0 && selectedSheets.Count == 0)
        { Log("No hay nada que publicar: marca el modelo, planos o agrega IFCs.", "err"); hub.Dispose(); return; }

        string modelName = string.IsNullOrWhiteSpace(tbModelName.Text) ? _doc.Title : tbModelName.Text.Trim();

        btnPublish.IsEnabled = false;
        btnConnect.IsEnabled = false;
        tbStatus.Text = "Publicando…";
        panelResult.Visibility = System.Windows.Visibility.Collapsed;
        tbLog.Clear();
        SaveSettings();

        try
        {
            var job = new PublishJob { ProjectName = projectName, Existing = existing, PlanoGroup = modelName };

            // ── Exportaciones Revit: SIEMPRE antes del primer await (contexto de la API)
            string workDir = Path.Combine(Path.GetTempPath(), "BimHubPublisher",
                                          DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            Directory.CreateDirectory(workDir);

            if (exportModel)
            {
                Log($"Exportando modelo a IFC ({modelName})…", "run");
                string ifcPath = RevitExporter.ExportIfc(_doc, workDir, Util.Slugify(modelName));
                long mb = new FileInfo(ifcPath).Length / 1048576;
                Log($"IFC exportado ({mb} MB)", "ok");

                // Metadata por elemento + tablas de cantidades (mismo hilo de Revit, misma vista).
                string? metaJson = null, schedulesJson = null;
                try
                {
                    Log("Extrayendo categorías, niveles y tablas de cantidades…", "run");
                    ElementId? viewId = null; // mismo alcance que el IFC (modelo completo)
                    (metaJson, schedulesJson, int count) = MetadataExtractor.BuildJson(_doc, viewId);
                    Log($"Metadata de {count} elemento(s) lista", "ok");
                }
                catch (Exception ex)
                {
                    Log("No se pudo extraer la metadata (el visor cargará solo el 3D): " + ex.Message, "err");
                }

                job.Models.Add(new ModelUpload
                {
                    Name = modelName, LocalPath = ifcPath,
                    MetaJson = metaJson, SchedulesJson = schedulesJson,
                });
            }

            foreach (string extra in _extraIfcs)
                job.Models.Add(new ModelUpload
                {
                    Name = Path.GetFileNameWithoutExtension(extra),
                    LocalPath = extra,
                });

            if (selectedSheets.Count > 0)
            {
                string pdfDir = Path.Combine(workDir, "planos");
                foreach (SheetItem sheet in selectedSheets)
                {
                    Log($"Exportando plano {sheet.Number} — {sheet.Name} a PDF…", "run");
                    string pdfPath = RevitExporter.ExportSheetPdf(_doc, sheet, pdfDir,
                                                                  Util.Slugify($"{sheet.Number} {sheet.Name}"));
                    job.Planos.Add(new PlanoUpload { Number = sheet.Number, Name = sheet.Name, LocalPath = pdfPath });
                }
                Log($"{selectedSheets.Count} plano(s) exportado(s)", "ok");
            }

            // ── Subida (red, fuera del hilo de Revit)
            var publisher = new HubPublisher(hub);
            _resultUrl = await Task.Run(() => publisher.PublishAsync(job, Log));

            Log("¡Listo! 🎉  Comparte este link: " + _resultUrl, "ok");
            tbResultUrl.Text = _resultUrl;
            panelResult.Visibility = System.Windows.Visibility.Visible;
            tbStatus.Text = "Publicación completada";
        }
        catch (Exception ex)
        {
            Log(ex.Message, "err");
            tbStatus.Text = "Error en la publicación";
        }
        finally
        {
            hub.Dispose();
            btnPublish.IsEnabled = true;
            btnConnect.IsEnabled = true;
        }
    }

    void OpenUrl_Click(object sender, RoutedEventArgs e)
    {
        if (_resultUrl != null)
            Process.Start(new ProcessStartInfo(_resultUrl) { UseShellExecute = true });
    }

    void CopyUrl_Click(object sender, RoutedEventArgs e)
    {
        if (_resultUrl != null) { Clipboard.SetText(_resultUrl); Log("Link copiado al portapapeles", "ok"); }
    }
}
