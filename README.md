# BIM Hub Visor · Life City · con notificaciones

> Evolución del repo **96 · BIM HUB VISOR**: mismo Worker (`bim-hub-visor`), misma base D1 y mismo Firebase
> (`lifecity-bim-hub`). Agrega **avances de obra y notificaciones** que venden la **página de ventas con respuesta
> automática** del proyecto. Desplegar desde aquí reemplaza la versión del repo 96 (es compatible: solo agrega tablas).

**Demo en vivo (GitHub Pages):** https://baronaarchitect-collab.github.io/visor-bim-notificaciones/
La demo usa la misma interfaz con una API simulada en el navegador (`demo/demo.js`) y una torre de ejemplo de 12 pisos
en obra (`demo/generar_ifc.py`). Se arma con `node demo/build.mjs` y se publica sola en cada push a `main`
(`.github/workflows/pages.yml`). Sin login de Google ni push; el formulario de la página de ventas sí crea el lead en el
CRM con origen *Demo visor BIM*.

Evolución del plugin **VisorPublisher** (repo 45 / 29 v2): Revit publica el modelo 3D (IFC + cantidades)
y los planos (PDF) a Cloudflare, y los profesionales los ven en un visor web **entrando con Google**.

| Qué | Dónde |
|---|---|
| Plugin de Revit 2025 / 2026 (`BimHubPublisher`) | `plugin/` |
| Worker de Cloudflare (API + página) | `worker/src/index.js` |
| Página: login, proyectos, administración | `worker/public/index.html` |
| Visor 3D + planos + fichas técnicas | `worker/public/visor.html` |
| Base de datos D1 | `worker/schema.sql` |

## Cómo funciona

```
Revit ──(token hub_…)──▶ Worker bim-hub-visor ──▶ R2 privado  bim-hub-privado
                              │                  D1          bim_hub_visor
Profesional ──(Google/Firebase)──▶ /p/<código> ──▶ visor 3D (el Worker sirve los archivos solo con sesión)
```

- **Acceso por proyecto** (lo elige el admin en *Gestionar*): *cualquiera con el link* (`/p/<código aleatorio>`)
  o *solo los usuarios agregados*. El admin puede generar un link nuevo y ver quién entró.
- **Roles**: **Administrador** (correos en `ADMIN_EMAILS`): crea y borra proyectos, sube y borra modelos y planos,
  agrega/quita usuarios, crea tokens del plugin. **Editor** (por proyecto): sube modelos y planos a ese proyecto.
  **Visor** (por proyecto): ve todo y adjunta fichas técnicas.
- **Subir desde la web**: *Gestionar* → IFC y PDF (por partes de 40 MB). Los IFC subidos así no traen cantidades.
- **Visor**: abre directo en el **3D**. Panel *Capas*: prender/apagar cada **modelo** y cada **plano**
  (los planos se abren como ventanas flotantes sobre el 3D: mover, redimensionar, maximizar).
  Panel *Cantidades*: el dashboard de categorías/niveles de antes. Panel *Fichas*: todas las fichas del proyecto.
- **Fichas técnicas**: clic en un elemento → *Adjuntar ficha técnica* (PDF, imagen, Office, DWG, ZIP; máx. 50 MB).
  Se ligan al elemento por su **ElementId** (IfcElement.Tag) y **GlobalId**, así que sobreviven a re-publicar el modelo.
  El botón **📎 Con ficha** resalta en naranja los elementos que tienen fichas. Solo quien subió la ficha o un admin la borra.
- **Agregar otro administrador**: añade el correo a `ADMIN_EMAILS` en `worker/wrangler.toml` y ejecuta `deploy.ps1`.
- **Archivos**: el bucket es privado; los IFC grandes suben por partes de 64 MB (multipart R2), sin llaves de R2 en los equipos.

- **Otras apps (5D Budgeting)**: `CORS_ORIGINS` en `worker/wrangler.toml` lista los dominios que pueden *leer*
  proyectos y modelos (solo `GET`, con el mismo login de Google). 5D Budgeting crea un presupuesto a partir de un
  modelo publicado aquí. Esos dominios también deben estar en Firebase → Authentication → *Authorized domains*.

## Puesta en marcha (una vez)

1. **Firebase** (proyecto `lifecity-bim-hub`, ya creado):
   - Consola → Authentication → *Get started* → Sign-in method → **Google** → habilitar.
   - Authentication → Settings → **Authorized domains** → agregar `bim-hub-visor.lifecity.workers.dev`
     (y tu dominio propio si conectas uno).
2. **Cloudflare**: `powershell -ExecutionPolicy Bypass -File worker/deploy.ps1`
   (pide `wrangler login` la primera vez; crea D1 + bucket, aplica el esquema y publica).
3. Entra a la URL del Worker con tu Google → **Administración → Crear token** → pégalo en el plugin.

## Plugin de Revit

```powershell
cd plugin/BimHubPublisher
dotnet build -c Release -p:RevitYear=2025   # .NET 8
dotnet build -c Release -p:RevitYear=2026   # .NET 10
```
Se copia solo a `%AppData%\Autodesk\Revit\Addins\<año>\`. Botón **Publicar BIM Hub** en la pestaña
*Life City BIM* (o *Complementos*). URL del hub + token → *Conectar* → proyecto nuevo o existente →
modelo/IFC extra/planos → *Publicar*. El token se guarda cifrado (DPAPI) en `%AppData%\BimHubPublisher`.

## Desarrollo local

```bash
cd worker
npx wrangler d1 execute bim_hub_visor --local --file=schema.sql
# bases creadas antes del 2026-09-29: aplicar también migrations/002_restricted.sql
npx wrangler dev --port 8787          # .dev.vars trae DEV_AUTH=1
node test/seed.mjs                     # simula el plugin: token, IFC por partes, PDF, chequeos de seguridad
```
En local se entra sin Google con `?dev=correo@x.com` (solo funciona con `DEV_AUTH=1`, nunca en producción).

## Planos por modelo y propiedades (2026-09-29)
- Cada plano pertenece a un **grupo** (por defecto, el modelo que lo contiene: el plugin manda el nombre del modelo;
  en la web se elige al subir). Pestaña **Planos** en la barra superior del visor: grupos plegables, nombre editable (admin/editor).
- Al seleccionar un elemento: **Nombre de tipo, Longitud, Área, Volumen**. Origen en orden: datos de Revit (meta.json),
  propiedades/cantidades del IFC, y si no, medido de la geometría (marcado con ≈).
- Cambios de esquema en producción: `worker/migrations/*.sql` (deploy.ps1 solo corre schema.sql).

## Notificaciones de avance que venden la página de ventas (2026-10-08)

Cada vez que el proyecto avanza, los usuarios reciben un aviso. Cada aviso conecta ese avance con la venta de la
**página de ventas que responde automáticamente**: responder en el primer minuto aumenta hasta **391 %** la
probabilidad de venta, y el comprador de apartamento o el inversionista suele quedarse con quien contesta primero.

| Qué genera el aviso | Cómo |
|---|---|
| **Avance de obra** (% + etapa) | *Gestionar* → *Avance de obra* (admin o editor), o `POST /api/admin/projects/<slug>/avances` con el token del plugin (sirve para **Avance Obra AI**, repo 78) |
| **Modelo 3D publicado** | Automático al publicar desde Revit o la web (si el mismo modelo se re-publica en menos de 30 min, no se repite) |
| **Planos publicados** | Automático; los planos de 30 minutos se agrupan en un solo aviso ("12 planos nuevos") |
| **Mensaje comercial libre** | *Gestionar* → *Mensaje comercial a los usuarios* (solo admin) |

**Etapas** (si no se elige, salen del %): Preventa < 5 · Cimentación < 20 · Estructura < 50 · Mampostería < 75 ·
Acabados < 97 · Entrega. Cada etapa tiene su propio argumento comercial en `worker/src/ventas.js` (ahí se editan los textos).

**Qué ve el usuario**
- **Campana** en el visor (avisos del proyecto) y en *Mis proyectos* (avisos de todos sus proyectos), con contador de nuevos.
- **Barra de avance** junto al nombre del proyecto y en cada tarjeta de proyecto.
- **Tarjeta emergente** con el aviso más reciente sin leer: *Ver cómo vender más*.
- **Ventana de la página de ventas**: el argumento de la etapa, el +391 %, y un formulario (nombre, celular, correo,
  unidades por vender) que crea el lead en el **CRM de Life City** (`leadsBim`, tipo *Página de ventas auto-respuesta*,
  origen *Visor BIM · notificación …*). Si se configuran, también muestra *Hablar por WhatsApp* y *Ver un ejemplo*.
- **Push del navegador** (llega aunque el visor esté cerrado): en la campana → *Recibir avisos aunque cierre el visor*.
  Al hacer clic en el push se abre el visor directo en la ventana de venta de ese aviso.

**Quién recibe**: administradores, usuarios agregados al proyecto y, si el proyecto es *cualquiera con el link*,
quienes ya entraron alguna vez. En proyectos restringidos, nadie más.

**Activar el push (una vez)**: sin estos dos pasos todo funciona, solo que los avisos llegan en la campana y no como push.
1. Firebase (`lifecity-bim-hub`) → Configuración del proyecto → **Cloud Messaging** → *Certificados push web* →
   *Generar par de claves*. Copia la clave pública en `FCM_VAPID_KEY` de `worker/wrangler.toml`.
2. Firebase → Configuración del proyecto → **Cuentas de servicio** → *Generar nueva clave privada* (JSON). Guárdala como secreto:
   ```powershell
   cd worker; Get-Content rutalrchivo.json -Raw | npx wrangler secret put FCM_SERVICE_ACCOUNT
   ```
   Borra el archivo JSON del equipo después. Luego `deploy.ps1`.
3. Opcional en `wrangler.toml`: `VENTAS_WHATSAPP` (ej. `573001234567`) y `VENTAS_DEMO_URL` (una página de ventas de ejemplo).

**Base de datos**: `deploy.ps1` aplica `schema.sql`, que ya trae las tablas nuevas (`avances`, `notificaciones`,
`notif_leidas`, `push_tokens`). Para aplicarlas a mano: `migrations/004_notificaciones.sql`.

**API nueva**
| Ruta | Quién | Qué |
|---|---|---|
| `GET /api/notificaciones` · `POST /api/notificaciones/leidas` | usuario | Avisos de todos sus proyectos |
| `GET /api/p/<share>/notificaciones?after=<id>` · `POST …/leidas` | usuario del proyecto | Avisos del proyecto |
| `GET /api/p/<share>/avances` | usuario del proyecto | Historial de avances |
| `POST /api/admin/projects/<slug>/avances` `{ pct, etapa?, comentario?, push? }` | admin, editor, plugin | Publica avance y avisa |
| `DELETE /api/admin/projects/<slug>/avances/<id>` | admin | Borra el avance y su aviso |
| `GET/POST /api/admin/projects/<slug>/notificaciones` · `DELETE …/<id>` | admin | Lista, mensaje libre, quitar |
| `GET /api/config` · `POST/DELETE /api/push/token` | usuario | Config de push y registro del navegador |

`POST …/models` y `POST …/planos` aceptan `notify: false` para publicar sin avisar.
