"""Genera el IFC de la demo: torre residencial de 12 pisos EN CONSTRUCCIÓN.

Pisos 1-7: terminados (estructura, mampostería, ventanería). Pisos 8-9: estructura + mampostería.
Pisos 10-11: solo estructura. Piso 12: columnas. Así el modelo cuenta el avance de obra (~62 %).

    python demo/generar_ifc.py   ->  demo/files/torre-mirador/modelos/torre-mirador.ifc
"""
import os
import numpy as np
import ifcopenshell
import ifcopenshell.api as api

OUT = os.path.join(os.path.dirname(__file__), "files", "torre-mirador", "modelos", "torre-mirador.ifc")
PISOS, H = 12, 3.0
LX, LY = 24.0, 16.0
GX, GY = [0, 8, 16, 24], [0, 8, 16]

f = api.run("project.create_file", version="IFC4")
project = api.run("root.create_entity", f, ifc_class="IfcProject", name="Torre Mirador (demo)")
api.run("unit.assign_unit", f)
model = api.run("context.add_context", f, context_type="Model")
body = api.run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model)
site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Lote")
bld = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Torre Mirador")
api.run("aggregate.assign_object", f, relating_object=project, products=[site])
api.run("aggregate.assign_object", f, relating_object=site, products=[bld])


def estilo(nombre, r, g, b, t=0.0):
    s = api.run("style.add_style", f, name=nombre)
    api.run("style.add_surface_style", f, style=s, ifc_class="IfcSurfaceStyleShading",
            attributes={"SurfaceColour": {"Name": None, "Red": r, "Green": g, "Blue": b}, "Transparency": t})
    return s


EST = {
    "concreto": estilo("Concreto", .72, .72, .70),
    "columna": estilo("Concreto columna", .55, .56, .58),
    "ladrillo": estilo("Mampostería", .78, .45, .32),
    "fachada": estilo("Fachada", .93, .91, .86),
    "vidrio": estilo("Vidrio", .35, .62, .85, .45),
    "nucleo": estilo("Núcleo", .62, .63, .66),
}
tag = [100000]


def caja(clase, nombre, piso, x, y, z, lx, ly, lz, est, tipo=None):
    e = api.run("root.create_entity", f, ifc_class=clase, name=nombre)
    tag[0] += 1
    e.Tag = str(tag[0])
    if tipo:
        e.ObjectType = tipo
    rep = api.run("geometry.add_wall_representation", f, context=body, length=lx, height=lz, thickness=ly)
    api.run("geometry.assign_representation", f, product=e, representation=rep)
    m = np.eye(4)
    m[:3, 3] = [x, y, z]
    api.run("geometry.edit_object_placement", f, product=e, matrix=m, is_si=True)
    api.run("style.assign_representation_styles", f, shape_representation=rep, styles=[EST[est]])
    api.run("spatial.assign_container", f, relating_structure=piso, products=[e])
    return e


for n in range(1, PISOS + 1):
    z = (n - 1) * H
    piso = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name=f"Piso {n:02d}")
    piso.Elevation = z
    api.run("aggregate.assign_object", f, relating_object=bld, products=[piso])

    # Columnas (todas las plantas)
    for i, x in enumerate(GX):
        for j, y in enumerate(GY):
            caja("IfcColumn", f"Columna C{i+1}{chr(65+j)}", piso, x - .25, y - .25, z, .5, .5, H - .25, "columna", "Columna 50x50")
    if n == PISOS:
        continue
    # Placa de entrepiso y núcleo de ascensores/escaleras (pisos 1-11)
    caja("IfcSlab", f"Placa piso {n+1:02d}", piso, -.3, -.3, z + H - .25, LX + .6, LY + .6, .25, "concreto", "Placa maciza e=25")
    caja("IfcWall", "Muro núcleo", piso, 10, 6, z, 4, 4, H - .25, "nucleo", "Muro concreto e=20")
    if n > 9:
        continue
    # Mampostería de fachada entre columnas (pisos 1-9); ventanas solo en pisos terminados (1-7)
    terminado = n <= 7
    for k in range(len(GX) - 1):
        x0 = GX[k] + .25
        for y0, cara in ((-.1, "sur"), (LY - .1, "norte")):
            caja("IfcWall", f"Muro fachada {cara}", piso, x0, y0, z, 7.5, .2, .9, "fachada" if terminado else "ladrillo", "Mampostería e=20")
            if terminado:
                caja("IfcWindow", f"Ventana {cara}", piso, x0 + .2, y0 + .05, z + .9, 7.1, .1, 1.8, "vidrio", "Ventana piso-techo")
                caja("IfcWall", f"Dintel {cara}", piso, x0, y0, z + 2.7, 7.5, .2, .05, "fachada")
            else:
                caja("IfcWall", f"Muro fachada {cara} (sin ventana)", piso, x0, y0, z + .9, 7.5, .2, 1.85, "ladrillo", "Mampostería e=20")
    for k in range(len(GY) - 1):
        y0 = GY[k] + .25
        for x0, cara in ((-.1, "occidente"), (LX - .1, "oriente")):
            caja("IfcWall", f"Muro fachada {cara}", piso, x0, y0, z, .2, 7.5, H - .25, "fachada" if terminado else "ladrillo", "Mampostería e=20")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
f.write(OUT)
print(OUT, os.path.getsize(OUT), "bytes,", len(f.by_type("IfcElement")), "elementos")
