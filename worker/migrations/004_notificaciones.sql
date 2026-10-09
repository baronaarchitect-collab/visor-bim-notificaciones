-- Avances de obra y notificaciones (2026-10-08). Idempotente: se puede correr varias veces.

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
