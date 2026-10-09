CREATE TABLE planos_new (
  project_slug TEXT NOT NULL,
  grupo        TEXT NOT NULL DEFAULT 'General',
  number       TEXT NOT NULL,
  name         TEXT,
  file_key     TEXT NOT NULL,
  updated_at   TEXT DEFAULT (datetime('now')),
  updated_by   TEXT,
  PRIMARY KEY (project_slug, grupo, number)
);
INSERT INTO planos_new (project_slug, grupo, number, name, file_key, updated_at, updated_by)
  SELECT project_slug, 'General', number, name, file_key, updated_at, updated_by FROM planos;
DROP TABLE planos;
ALTER TABLE planos_new RENAME TO planos;
