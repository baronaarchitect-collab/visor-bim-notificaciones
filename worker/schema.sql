-- BIM Hub Visor — esquema D1
-- Acceso: cualquier cuenta Google (Firebase) con el link del proyecto (share_id) entra.
-- Admins: correos en la variable ADMIN_EMAILS del Worker.

CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  share_id    TEXT UNIQUE NOT NULL,          -- código aleatorio del link /p/<share_id>
  allow_docs  INTEGER NOT NULL DEFAULT 1,    -- 1 = los visitantes pueden adjuntar fichas técnicas
  restricted  INTEGER NOT NULL DEFAULT 0,    -- 1 = solo entran los usuarios agregados (tabla members)
  created_at  TEXT DEFAULT (datetime('now')),
  created_by  TEXT
);

CREATE TABLE IF NOT EXISTS models (
  project_slug  TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  name          TEXT,
  file_key      TEXT NOT NULL,               -- clave R2: <slug>/modelos/<id>.ifc
  meta_key      TEXT,                        -- <slug>/modelos/<id>.meta.json
  schedules_key TEXT,                        -- <slug>/modelos/<id>.schedules.json
  size          INTEGER,
  updated_at    TEXT DEFAULT (datetime('now')),
  updated_by    TEXT,
  PRIMARY KEY (project_slug, model_id)
);

CREATE TABLE IF NOT EXISTS planos (
  project_slug TEXT NOT NULL,
  grupo        TEXT NOT NULL DEFAULT 'General',  -- por defecto, el modelo que contiene los planos
  number       TEXT NOT NULL,
  name         TEXT,
  file_key     TEXT NOT NULL,                -- <slug>/planos/<archivo>.pdf
  updated_at   TEXT DEFAULT (datetime('now')),
  updated_by   TEXT,
  PRIMARY KEY (project_slug, grupo, number)
);

-- Quién ha entrado a cada proyecto (y cuándo por última vez).
CREATE TABLE IF NOT EXISTS visits (
  project_slug TEXT NOT NULL,
  email        TEXT NOT NULL,
  name         TEXT,
  first_seen   TEXT DEFAULT (datetime('now')),
  last_seen    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_slug, email)
);

-- Fichas técnicas (u otros documentos) adjuntas a un elemento del modelo.
-- element_tag = IfcElement.Tag (= ElementId de Revit); global_id = IFC GlobalId.
CREATE TABLE IF NOT EXISTS element_docs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug  TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  element_tag   TEXT,
  global_id     TEXT,
  element_name  TEXT,
  title         TEXT,
  file_key      TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  content_type  TEXT,
  size          INTEGER,
  uploaded_by   TEXT NOT NULL,
  uploaded_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_project ON element_docs (project_slug, model_id);

-- Tokens para el plugin de Revit (se guarda solo el hash SHA-256).
CREATE TABLE IF NOT EXISTS publish_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  hash        TEXT UNIQUE NOT NULL,
  created_by  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  last_used   TEXT
);

-- Usuarios agregados a un proyecto. role: 'visor' (ver + fichas) | 'editor' (además sube modelos y planos)
CREATE TABLE IF NOT EXISTS members (
  project_slug TEXT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'visor',
  added_by     TEXT,
  added_at     TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_slug, email)
);


-- Avance de obra publicado por un admin/editor, el plugin o la app Avance Obra AI.
CREATE TABLE IF NOT EXISTS avances (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug TEXT NOT NULL,
  pct          REAL NOT NULL,                -- 0 a 100
  etapa        TEXT NOT NULL,                -- Preventa, Cimentación, Estructura, Mampostería, Acabados, Entrega
  comentario   TEXT,
  created_by   TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avances_project ON avances (project_slug, id);

-- Notificación que ven los usuarios del proyecto (campana del visor y push del navegador).
-- tipo: 'avance' | 'modelo' | 'planos' | 'venta'
CREATE TABLE IF NOT EXISTS notificaciones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  titulo       TEXT NOT NULL,
  cuerpo       TEXT NOT NULL,
  pitch        TEXT,                         -- argumento de venta de la página de ventas
  pct          REAL,
  etapa        TEXT,
  ref          TEXT,                         -- id del avance o nombre del modelo
  cantidad     INTEGER NOT NULL DEFAULT 1,   -- planos agrupados en una misma notificación
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_project ON notificaciones (project_slug, id);

-- Hasta qué notificación leyó cada usuario en cada proyecto.
CREATE TABLE IF NOT EXISTS notif_leidas (
  email        TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  last_id      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, project_slug)
);

-- Tokens de Firebase Cloud Messaging (un navegador = un token).
CREATE TABLE IF NOT EXISTS push_tokens (
  token        TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  last_seen    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_email ON push_tokens (email);
