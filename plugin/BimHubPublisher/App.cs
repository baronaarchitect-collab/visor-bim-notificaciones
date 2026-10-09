using System.Reflection;
using System.Windows.Media.Imaging;
using Autodesk.Revit.UI;

namespace BimHubPublisher;

/// <summary>Registra el botón "Publicar al BIM Hub" en la pestaña Life City BIM
/// (o en Complementos si Revit ya no admite más pestañas).</summary>
public class App : IExternalApplication
{
    public Result OnStartup(UIControlledApplication application)
    {
        RibbonPanel panel = GetOrCreatePanel(application, "Life City BIM", "BIM Hub");
        var buttonData = new PushButtonData(
            "BimHub_Publicar",
            "Publicar\nBIM Hub",
            Assembly.GetExecutingAssembly().Location,
            typeof(PublishCommand).FullName)
        {
            ToolTip = "Exporta el modelo a IFC (con cantidades) y los planos a PDF, y los publica en el "
                    + "BIM Hub. Los profesionales entran con Google al link del proyecto.",
            LongDescription = "Puedes añadir varios modelos al mismo proyecto; en el visor cada modelo y cada plano "
                            + "se prende/apaga, y a cada elemento se le pueden adjuntar fichas técnicas.",
        };
        // Un fallo al dibujar el icono no debe impedir que el botón aparezca.
        try { buttonData.LargeImage = Icon(32); buttonData.Image = Icon(16); } catch { }
        panel.AddItem(buttonData);
        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application) => Result.Succeeded;

    static RibbonPanel GetOrCreatePanel(UIControlledApplication app, string tabName, string panelName)
    {
        try
        {
            try { app.CreateRibbonTab(tabName); } catch { /* la pestaña ya existe */ }
            return app.GetRibbonPanels(tabName).FirstOrDefault(p => p.Name == panelName)
                   ?? app.CreateRibbonPanel(tabName, panelName);
        }
        catch
        {
            // Límite de pestañas personalizadas alcanzado → pestaña "Complementos".
            return app.GetRibbonPanels().FirstOrDefault(p => p.Name == panelName)
                   ?? app.CreateRibbonPanel(panelName);
        }
    }

    /// <summary>Icono simple (capas) dibujado en código: no requiere recursos.</summary>
    internal static BitmapSource Icon(int size)
    {
        var dv = new System.Windows.Media.DrawingVisual();
        using (var dc = dv.RenderOpen())
        {
            double s = size / 24.0;
            var pen = new System.Windows.Media.Pen(new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x2F, 0x81, 0xF7)), 2);
            var g = System.Windows.Media.Geometry.Parse("M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5");
            // Geometry.Parse devuelve una geometría congelada (solo lectura): se escala el lienzo, no la geometría.
            dc.PushTransform(new System.Windows.Media.ScaleTransform(s, s));
            dc.DrawGeometry(null, pen, g);
            dc.Pop();
        }
        var bmp = new RenderTargetBitmap(size, size, 96, 96, System.Windows.Media.PixelFormats.Pbgra32);
        bmp.Render(dv);
        return bmp;
    }
}
