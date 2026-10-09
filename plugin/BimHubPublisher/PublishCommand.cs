using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using System.Windows.Interop;

namespace BimHubPublisher;

[Transaction(TransactionMode.Manual)]
[Regeneration(RegenerationOption.Manual)]
public class PublishCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        UIApplication uiApp = commandData.Application;
        Document? doc = uiApp.ActiveUIDocument?.Document;
        if (doc == null)
        {
            message = "No hay un documento activo.";
            return Result.Failed;
        }
        if (doc.IsFamilyDocument)
        {
            TaskDialog.Show("BIM Hub", "Abre un proyecto (.rvt), no una familia.");
            return Result.Cancelled;
        }

        var window = new PublishWindow(doc);
        // La ventana es modal y sus manejadores corren en el contexto de la API,
        // por lo que las exportaciones desde el diálogo son válidas.
        new WindowInteropHelper(window) { Owner = uiApp.MainWindowHandle };
        window.ShowDialog();
        return Result.Succeeded;
    }
}
