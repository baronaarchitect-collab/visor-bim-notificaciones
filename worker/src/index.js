// BIM Hub Visor — Cloudflare Worker
//
// · Login: token de Firebase Auth (Google). Se verifica aquí con las llaves públicas de Google,
//   sin secretos. Cualquier cuenta con el link del proyecto (/p/<share_id>) entra.
// · Admins: correos en ADMIN_EMAILS (crean proyectos, tokens del plugin, borran contenido).
// · Plugin de Revit: token "hub_…" creado por un admin (se guarda solo su hash).
// · Archivos: bucket R2 PRIVADO (binding FILES). Todo se sirve a través del Worker con auth.
//   Subidas grandes (IFC de cientos de MB) por multipart de R2, en partes de ≤ 90 MB.
// · Notificaciones: cada avance de obra, modelo o plano publicado genera un aviso para los usuarios
//   del proyecto (campana del visor + push del navegador con Firebase Cloud Messaging). Cada aviso
//   lleva el argumento de venta de la página de ventas con respuesta automática (ver ventas.js).

import { CIERRE, ETAPAS, normEtapa, textoAvance, textoModelo, textoPlanos } from "./ventas.js";
import { pushEnabled, pushProyecto } from "./push.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
const err = (status, msg) => json({ error: msg }, status);

const MAX_DOC_BYTES = 50 * 1024 * 1024;     // fichas técnicas: 50 MB
const MAX_SMALL_BYTES = 90 * 1024 * 1024;   // subida directa del plugin (PDF, JSON)

// ── utilidades ───────────────────────────────────────────────────
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

function randomId(len = 10) {
  const abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

function slugify(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "proyecto";
}

const groupName = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 80) || "General";

function safeFileName(s) {
  const clean = (s || "archivo").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-120);
  return clean || "archivo";
}

// Clave R2 dentro del proyecto: sin traversal, sin raíz absoluta, sin backslashes.
function keyOk(key, slug) {
  if (!key || typeof key !== "string" || key.length > 400) return false;
  if (!key.startsWith(slug + "/")) return false;
  if (key.includes("\\") || key.split("/").some((seg) => seg === ".." || seg === "")) return false;
  return /^[\w./\-]+$/.test(key);
}

// ── Verificación del ID token de Firebase ────────────────────────
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache = { keys: null, exp: 0 };

async function getJwks() {
  if (jwksCache.keys && jwksCache.exp > Date.now()) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error("no se pudieron leer las llaves de Firebase");
  const body = await r.json();
  const maxAge = Number((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = { keys: body.keys || [], exp: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

async function verifyFirebaseToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== "RS256") return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub || payload.exp <= now || payload.iat > now + 60) return null;

  const jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  return payload;
}

// ── Usuario actual ───────────────────────────────────────────────
// → { email, name, admin, via: "firebase" | "token" | "dev" } o null
async function currentUser(req, env) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const admins = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

  // Token del plugin de Revit
  if (token.startsWith("hub_")) {
    const row = await env.DB.prepare("SELECT id, name, created_by FROM publish_tokens WHERE hash=?")
      .bind(await sha256(token)).first();
    if (!row) return null;
    await env.DB.prepare("UPDATE publish_tokens SET last_used=datetime('now') WHERE id=?").bind(row.id).run();
    return { email: row.created_by || "plugin", name: "Plugin: " + row.name, admin: true, verified: true, via: "token" };
  }

  // Solo para `wrangler dev` (DEV_AUTH=1 en .dev.vars): "dev:correo@x.com"
  if (env.DEV_AUTH === "1" && token.startsWith("dev:")) {
    const email = token.slice(4).toLowerCase();
    return { email, name: email.split("@")[0], admin: admins.includes(email), verified: true, via: "dev" };
  }

  let p;
  try { p = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID); } catch { p = null; }
  if (!p || !p.email) return null;
  const email = String(p.email).toLowerCase();
  // Los admins deben tener el correo verificado (Google siempre lo verifica).
  const admin = admins.includes(email) && p.email_verified === true;
  return { email, name: p.name || email.split("@")[0], picture: p.picture || null, admin, verified: p.email_verified === true, via: "firebase" };
}

// ── Consultas ────────────────────────────────────────────────────
const projectByShare = (env, share) =>
  env.DB.prepare("SELECT * FROM projects WHERE share_id=?").bind(share).first();
const projectBySlug = (env, slug) =>
  env.DB.prepare("SELECT * FROM projects WHERE slug=?").bind(slug).first();

// Rol del usuario en el proyecto: "admin" | "editor" | "visor" | null (no es miembro)
async function projectRole(env, slug, user) {
  if (user.admin) return "admin";
  if (!user.verified) return null;
  const r = await env.DB.prepare("SELECT role FROM members WHERE project_slug=? AND email=?").bind(slug, user.email).first();
  return r ? r.role : null;
}

async function projectPayload(env, p, user, role) {
  const [models, planos, docs, avance] = await Promise.all([
    env.DB.prepare("SELECT model_id id, name, file_key, meta_key, schedules_key, size, updated_at FROM models WHERE project_slug=? ORDER BY name").bind(p.slug).all(),
    env.DB.prepare("SELECT grupo, number, name, file_key, updated_at FROM planos WHERE project_slug=? ORDER BY grupo, number").bind(p.slug).all(),
    env.DB.prepare("SELECT COUNT(*) n FROM element_docs WHERE project_slug=?").bind(p.slug).first(),
    env.DB.prepare("SELECT id, pct, etapa, comentario, created_at FROM avances WHERE project_slug=? ORDER BY id DESC LIMIT 1").bind(p.slug).first(),
  ]);
  return {
    slug: p.slug, name: p.name, share_id: p.share_id,
    allow_docs: !!p.allow_docs || user.admin,
    admin: user.admin,
    can_edit: role === "admin" || role === "editor",
    restricted: !!p.restricted,
    me: { email: user.email, name: user.name },
    models: models.results || [],
    planos: planos.results || [],
    docs_count: docs ? docs.n : 0,
    avance: avance || null,
    etapas: ETAPAS,
  };
}

async function createProject(env, name, by) {
  let slug = slugify(name);
  const existing = await projectBySlug(env, slug);
  if (existing) {
    if (existing.name.toLowerCase() === name.toLowerCase()) return existing;
    slug = slug + "-" + randomId(4).toLowerCase();
  }
  const share = randomId(10);
  await env.DB.prepare("INSERT INTO projects (slug, name, share_id, created_by) VALUES (?,?,?,?)")
    .bind(slug, name, share, by).run();
  return projectBySlug(env, slug);
}

async function streamObject(env, key, filename) {
  const obj = await env.FILES.get(key);
  if (!obj) return err(404, "archivo no encontrado");
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("Content-Length", String(obj.size));
  h.set("ETag", obj.httpEtag);
  h.set("Cache-Control", "private, max-age=300");
  if (filename) h.set("Content-Disposition", `inline; filename="${safeFileName(filename)}"`);
  return new Response(obj.body, { headers: h });
}

// ── Notificaciones ───────────────────────────────────────────────
const NOTIF_COLS = "id, project_slug, tipo, titulo, cuerpo, pitch, pct, etapa, cantidad, created_at";

/**
 * Guarda una notificación del proyecto y (si se pide) la manda por push a los navegadores suscritos.
 * El push corre en segundo plano (ctx.waitUntil) para no demorar la respuesta al plugin o a la web.
 */
async function crearNotif(env, ctx, origin, p, n, { push = true, pushCuerpo } = {}) {
  const r = await env.DB.prepare(`INSERT INTO notificaciones (project_slug, tipo, titulo, cuerpo, pitch, pct, etapa, ref)
      VALUES (?,?,?,?,?,?,?,?)`)
    .bind(p.slug, n.tipo, n.titulo.slice(0, 200), n.cuerpo.slice(0, 600), (n.pitch || "").slice(0, 900) || null,
          n.pct ?? null, n.etapa ?? null, n.ref ? String(n.ref).slice(0, 200) : null).run();
  const id = r.meta.last_row_id;
  if (push && pushEnabled(env)) {
    const tarea = pushProyecto(env, p, { titulo: n.titulo, cuerpo: pushCuerpo || n.cuerpo, link: `${origin}/p/${p.share_id}?notif=${id}` })
      .then((res) => console.log("push", p.slug, JSON.stringify(res)))
      .catch((e) => console.log("push error:", e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(tarea); else await tarea;
  }
  return id;
}

// Proyectos que ve el usuario (?1 = su correo verificado): admin = todos; si no, los que tiene
// asignados o los abiertos a los que ya entró (la misma regla de /api/me).
const misProyectosSql = (user) => user.admin
  ? "SELECT slug FROM projects WHERE ?1 = ?1"
  : `SELECT p.slug FROM projects p WHERE EXISTS (SELECT 1 FROM members m WHERE m.project_slug=p.slug AND m.email=?1)
      OR (p.restricted=0 AND EXISTS (SELECT 1 FROM visits v WHERE v.project_slug=p.slug AND v.email=?1))`;

// ── Rutas ────────────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Link del proyecto → la página del visor (el propio visor pide login).
    if (/^\/p\/[\w-]+$/.test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/visor", req.url), req));
    }
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);

    // Otras apps de Life City (p. ej. 5D Budgeting) leen proyectos y modelos desde su propio dominio.
    // Solo LECTURA (GET) y solo desde los orígenes de CORS_ORIGINS; el login sigue siendo obligatorio.
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });

    let res;
    try {
      res = await api(req, env, url, path, ctx);
    } catch (e) {
      res = err(500, String((e && e.message) || e));
    }
    if (!cors || req.method !== "GET") return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Expose-Headers": "Content-Length",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function api(req, env, url, path, ctx) {
  const M = req.method;
  let m;

  if (path === "/api/health") return json({ ok: true });

  const user = await currentUser(req, env);
  if (!user) return err(401, "inicia sesión");

  // ── Usuario ──────────────────────────────────────────────────
  if (path === "/api/me" && M === "GET") {
    const q = user.admin
      ? env.DB.prepare(`SELECT p.slug, p.name, p.share_id, p.created_at,
          (SELECT pct FROM avances a WHERE a.project_slug=p.slug ORDER BY a.id DESC LIMIT 1) av_pct,
          (SELECT etapa FROM avances a WHERE a.project_slug=p.slug ORDER BY a.id DESC LIMIT 1) av_etapa,
          (SELECT COUNT(*) FROM models x WHERE x.project_slug=p.slug) models,
          (SELECT COUNT(*) FROM planos x WHERE x.project_slug=p.slug) planos,
          (SELECT COUNT(*) FROM visits x WHERE x.project_slug=p.slug) visitors,
          (SELECT COUNT(*) FROM members x WHERE x.project_slug=p.slug) members, p.restricted,
          (SELECT COUNT(*) FROM element_docs x WHERE x.project_slug=p.slug) docs
          FROM projects p ORDER BY p.name`)
      : env.DB.prepare(`SELECT p.slug, p.name, p.share_id, m.role, v.last_seen,
          (SELECT pct FROM avances a WHERE a.project_slug=p.slug ORDER BY a.id DESC LIMIT 1) av_pct,
          (SELECT etapa FROM avances a WHERE a.project_slug=p.slug ORDER BY a.id DESC LIMIT 1) av_etapa FROM projects p
          LEFT JOIN members m ON m.project_slug=p.slug AND m.email=?1
          LEFT JOIN visits v ON v.project_slug=p.slug AND v.email=?1
          WHERE m.email IS NOT NULL OR (v.email IS NOT NULL AND p.restricted=0)
          ORDER BY p.name`).bind(user.verified ? user.email : "");
    const { results } = await q.all();
    return json({ email: user.email, name: user.name, admin: user.admin, projects: results || [] });
  }

  // ── Notificaciones de todos mis proyectos (campana de la página principal) ──
  if (path === "/api/notificaciones" && M === "GET") {
    const { results } = await env.DB.prepare(`SELECT n.id, n.tipo, n.titulo, n.cuerpo, n.pitch, n.pct, n.etapa, n.cantidad, n.created_at,
        p.name proyecto, p.share_id, (n.id > COALESCE(l.last_id, 0)) nueva
        FROM notificaciones n JOIN projects p ON p.slug=n.project_slug
        LEFT JOIN notif_leidas l ON l.project_slug=n.project_slug AND l.email=?2
        WHERE n.project_slug IN (${misProyectosSql(user)}) ORDER BY n.id DESC LIMIT 40`)
      .bind(user.verified ? user.email : "", user.email).all();
    const list = (results || []).map((n) => ({ ...n, nueva: !!n.nueva }));
    return json({ notificaciones: list, nuevas: list.filter((n) => n.nueva).length });
  }
  if (path === "/api/notificaciones/leidas" && M === "POST") {
    await env.DB.prepare(`INSERT INTO notif_leidas (email, project_slug, last_id)
        SELECT ?2, project_slug, MAX(id) FROM notificaciones WHERE project_slug IN (${misProyectosSql(user)}) GROUP BY project_slug
        ON CONFLICT(email, project_slug) DO UPDATE SET last_id=MAX(last_id, excluded.last_id)`)
      .bind(user.verified ? user.email : "", user.email).run();
    return json({ ok: true });
  }

  // ── Push del navegador (Firebase Cloud Messaging) ─────────────
  // Configuración pública para la página: push y datos de la página de ventas.
  if (path === "/api/config" && M === "GET") {
    return json({
      push: { enabled: pushEnabled(env) && !!env.FCM_VAPID_KEY, vapidKey: env.FCM_VAPID_KEY || null },
      ventas: { demoUrl: env.VENTAS_DEMO_URL || null, whatsapp: (env.VENTAS_WHATSAPP || "").replace(/\D/g, "") || null },
    });
  }
  if (path === "/api/push/token" && (M === "POST" || M === "DELETE")) {
    if (user.via === "token") return err(403, "solo desde el navegador");
    const { token } = await req.json().catch(() => ({}));
    if (!token || typeof token !== "string" || token.length > 4096) return err(400, "token inválido");
    if (M === "DELETE") {
      await env.DB.prepare("DELETE FROM push_tokens WHERE token=? AND email=?").bind(token, user.email).run();
      return json({ ok: true });
    }
    if (!user.verified) return err(403, "correo no verificado");
    await env.DB.prepare(`INSERT INTO push_tokens (token, email, user_agent) VALUES (?,?,?)
        ON CONFLICT(token) DO UPDATE SET email=excluded.email, last_seen=datetime('now')`)
      .bind(token, user.email, (req.headers.get("User-Agent") || "").slice(0, 300)).run();
    return json({ ok: true });
  }

  // ── Proyecto por link (/api/p/<share>/…) ─────────────────────
  if ((m = path.match(/^\/api\/p\/([\w-]+)(\/.*)?$/))) {
    const p = await projectByShare(env, m[1]);
    if (!p) return err(404, "proyecto no encontrado");
    const sub = m[2] || "";

    // Proyecto restringido: solo administradores y usuarios agregados al proyecto.
    const role = await projectRole(env, p.slug, user);
    if (p.restricted && !role) return err(403, "sin acceso");

    if (sub === "" && M === "GET") {
      if (user.via !== "token") {
        await env.DB.prepare(`INSERT INTO visits (project_slug, email, name) VALUES (?,?,?)
          ON CONFLICT(project_slug, email) DO UPDATE SET last_seen=datetime('now'), name=excluded.name`)
          .bind(p.slug, user.email, user.name).run();
      }
      return json(await projectPayload(env, p, user, role));
    }

    // Notificaciones del proyecto (campana del visor). ?after=<id> para traer solo las nuevas.
    if (sub === "/notificaciones" && M === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      const [list, leida] = await Promise.all([
        env.DB.prepare(`SELECT ${NOTIF_COLS} FROM notificaciones WHERE project_slug=? AND id>? ORDER BY id DESC LIMIT 30`).bind(p.slug, after).all(),
        env.DB.prepare("SELECT last_id FROM notif_leidas WHERE email=? AND project_slug=?").bind(user.email, p.slug).first(),
      ]);
      const last = leida ? leida.last_id : 0;
      const items = (list.results || []).map((n) => ({ ...n, nueva: n.id > last }));
      return json({ notificaciones: items, last_read: last });
    }
    if (sub === "/notificaciones/leidas" && M === "POST") {
      const b = await req.json().catch(() => ({}));
      const max = await env.DB.prepare("SELECT MAX(id) m FROM notificaciones WHERE project_slug=?").bind(p.slug).first();
      const tope = (max && max.m) || 0;
      const hasta = Number(b.hasta) > 0 ? Math.min(Number(b.hasta), tope) : tope;
      await env.DB.prepare(`INSERT INTO notif_leidas (email, project_slug, last_id) VALUES (?,?,?)
          ON CONFLICT(email, project_slug) DO UPDATE SET last_id=MAX(last_id, excluded.last_id)`).bind(user.email, p.slug, hasta).run();
      return json({ ok: true, last_read: hasta });
    }
    if (sub === "/avances" && M === "GET") {
      const { results } = await env.DB.prepare("SELECT id, pct, etapa, comentario, created_by, created_at FROM avances WHERE project_slug=? ORDER BY id DESC LIMIT 100").bind(p.slug).all();
      return json({ avances: results || [] });
    }

    // Descarga de un archivo del proyecto (IFC, JSON de cantidades, PDF de plano)
    if (sub === "/file" && M === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!keyOk(key, p.slug)) return err(400, "clave inválida");
      return streamObject(env, key);
    }

    // Fichas técnicas del proyecto
    if (sub === "/docs" && M === "GET") {
      const { results } = await env.DB.prepare(`SELECT id, model_id, element_tag, global_id, element_name, title,
          file_name, content_type, size, uploaded_by, uploaded_at FROM element_docs
          WHERE project_slug=? ORDER BY uploaded_at DESC`).bind(p.slug).all();
      return json({ docs: results || [] });
    }

    // Adjuntar ficha: PUT con el archivo en el cuerpo y los datos del elemento en la query.
    if (sub === "/docs" && M === "PUT") {
      if (!p.allow_docs && !user.admin) return err(403, "este proyecto no permite adjuntar fichas");
      const q = url.searchParams;
      const modelId = q.get("model") || "";
      const tag = q.get("tag") || null, gid = q.get("gid") || null;
      if (!modelId || (!tag && !gid)) return err(400, "falta el elemento (model + tag/gid)");
      const exists = await env.DB.prepare("SELECT 1 FROM models WHERE project_slug=? AND model_id=?").bind(p.slug, modelId).first();
      if (!exists) return err(400, "modelo no existe");
      const size = Number(req.headers.get("Content-Length") || 0);
      if (!size) return err(411, "falta Content-Length");
      if (size > MAX_DOC_BYTES) return err(413, "la ficha supera 50 MB");

      const fileName = safeFileName(q.get("filename") || "ficha.pdf");
      const contentType = req.headers.get("Content-Type") || "application/octet-stream";
      const key = `${p.slug}/fichas/${Date.now().toString(36)}-${randomId(6)}-${fileName}`;
      await env.FILES.put(key, req.body, { httpMetadata: { contentType } });
      const r = await env.DB.prepare(`INSERT INTO element_docs
          (project_slug, model_id, element_tag, global_id, element_name, title, file_key, file_name, content_type, size, uploaded_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(p.slug, modelId, tag, gid, (q.get("name") || "").slice(0, 200), (q.get("title") || fileName).slice(0, 200),
              key, fileName, contentType, size, user.email).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }

    if ((m = sub.match(/^\/docs\/(\d+)(\/file)?$/))) {
      const doc = await env.DB.prepare("SELECT * FROM element_docs WHERE id=? AND project_slug=?").bind(Number(m[1]), p.slug).first();
      if (!doc) return err(404, "ficha no encontrada");
      if (m[2] && M === "GET") return streamObject(env, doc.file_key, doc.file_name);
      if (!m[2] && M === "DELETE") {
        if (!user.admin && doc.uploaded_by !== user.email) return err(403, "solo quien la subió o un admin puede borrarla");
        await env.FILES.delete(doc.file_key);
        await env.DB.prepare("DELETE FROM element_docs WHERE id=?").bind(doc.id).run();
        return json({ ok: true });
      }
    }
    return err(404, "ruta no encontrada");
  }

  // ── Todo lo de abajo es solo para admins / plugin ─────────────
  if (!user.admin) {
    const pm = path.match(/^\/api\/admin\/projects\/([\w-]+)(\/.*)?$/);
    const sub = pm ? (pm[2] || "") : "";
    const esSubida = pm && (/^\/upload(\/(start|part|complete|abort))?$/.test(sub)
      || ((sub === "/models" || sub === "/planos" || sub === "/planos-group" || sub === "/avances") && M === "POST"));
    if (!esSubida || (await projectRole(env, pm[1], user)) !== "editor") return err(403, "solo administradores");
  }

  if (path === "/api/admin/projects" && M === "POST") {
    const { name } = await req.json();
    if (!name || !String(name).trim()) return err(400, "falta el nombre");
    return json(await createProject(env, String(name).trim(), user.email));
  }

  if ((m = path.match(/^\/api\/admin\/projects\/([\w-]+)(\/.*)?$/))) {
    const p = await projectBySlug(env, m[1]);
    if (!p) return err(404, "proyecto no encontrado");
    const sub = m[2] || "";

    if (sub === "" && M === "PATCH") {
      const b = await req.json();
      if (b.name) await env.DB.prepare("UPDATE projects SET name=? WHERE slug=?").bind(String(b.name), p.slug).run();
      if (b.allow_docs !== undefined) await env.DB.prepare("UPDATE projects SET allow_docs=? WHERE slug=?").bind(b.allow_docs ? 1 : 0, p.slug).run();
      if (b.restricted !== undefined) await env.DB.prepare("UPDATE projects SET restricted=? WHERE slug=?").bind(b.restricted ? 1 : 0, p.slug).run();
      if (b.regenerate_link) await env.DB.prepare("UPDATE projects SET share_id=? WHERE slug=?").bind(randomId(10), p.slug).run();
      return json(await projectBySlug(env, p.slug));
    }
    if (sub === "" && M === "DELETE") {
      let cursor;
      do {
        const list = await env.FILES.list({ prefix: p.slug + "/", cursor });
        if (list.objects.length) await env.FILES.delete(list.objects.map((o) => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      for (const t of ["models", "planos", "visits", "element_docs", "members", "avances", "notificaciones", "notif_leidas"])
        await env.DB.prepare(`DELETE FROM ${t} WHERE project_slug=?`).bind(p.slug).run();
      await env.DB.prepare("DELETE FROM projects WHERE slug=?").bind(p.slug).run();
      return json({ ok: true });
    }
    // Usuarios del proyecto
    if (sub === "/members" && M === "GET") {
      const { results } = await env.DB.prepare(`SELECT m.email, m.role, m.added_by, m.added_at, v.last_seen FROM members m
          LEFT JOIN visits v ON v.project_slug=m.project_slug AND v.email=m.email
          WHERE m.project_slug=? ORDER BY m.email`).bind(p.slug).all();
      return json({ members: results || [], restricted: !!p.restricted });
    }
    if (sub === "/members" && M === "POST") {
      const b = await req.json();
      const role = b.role === "editor" ? "editor" : "visor";
      const emails = [...new Set((b.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      const bad = emails.filter((e) => e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (!emails.length || bad.length) return err(400, bad.length ? "correo inválido: " + bad.join(", ") : "falta el correo");
      if (emails.length > 100) return err(400, "máximo 100 correos por vez");
      for (const e of emails)
        await env.DB.prepare(`INSERT INTO members (project_slug, email, role, added_by) VALUES (?,?,?,?)
          ON CONFLICT(project_slug, email) DO UPDATE SET role=excluded.role`).bind(p.slug, e, role, user.email).run();
      return json({ ok: true, added: emails.length });
    }
    if (sub === "/members" && M === "DELETE") {
      const email = (url.searchParams.get("email") || "").toLowerCase();
      await env.DB.prepare("DELETE FROM members WHERE project_slug=? AND email=?").bind(p.slug, email).run();
      return json({ ok: true });
    }
    if (sub === "/visits" && M === "GET") {
      const { results } = await env.DB.prepare("SELECT email, name, first_seen, last_seen FROM visits WHERE project_slug=? ORDER BY last_seen DESC").bind(p.slug).all();
      return json({ visits: results || [] });
    }
    // Registrar modelo / plano (tras subir el archivo)
    if (sub === "/models" && M === "POST") {
      const b = await req.json();
      const id = slugify(b.id || b.name);
      for (const k of [b.file_key, b.meta_key, b.schedules_key]) if (k && !keyOk(k, p.slug)) return err(400, "clave inválida: " + k);
      if (!b.file_key) return err(400, "falta file_key");
      await env.DB.prepare(`INSERT OR REPLACE INTO models (project_slug, model_id, name, file_key, meta_key, schedules_key, size, updated_by, updated_at)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
        .bind(p.slug, id, b.name || id, b.file_key, b.meta_key || null, b.schedules_key || null, b.size || null, user.email).run();
      // Aviso a los usuarios (si el mismo modelo se re-publicó hace menos de 30 min, no se repite).
      const reciente = await env.DB.prepare(`SELECT 1 FROM notificaciones WHERE project_slug=? AND tipo='modelo' AND ref=?
          AND created_at > datetime('now','-30 minutes')`).bind(p.slug, id).first();
      if (!reciente && b.notify !== false) await crearNotif(env, ctx, url.origin, p, { ...textoModelo(p.name, b.name || id), ref: id });
      return json({ ok: true, id });
    }
    if ((m = sub.match(/^\/models\/([\w-]+)$/)) && M === "DELETE") {
      const row = await env.DB.prepare("SELECT * FROM models WHERE project_slug=? AND model_id=?").bind(p.slug, m[1]).first();
      if (!row) return err(404, "modelo no encontrado");
      await env.FILES.delete([row.file_key, row.meta_key, row.schedules_key].filter(Boolean));
      await env.DB.prepare("DELETE FROM models WHERE project_slug=? AND model_id=?").bind(p.slug, m[1]).run();
      return json({ ok: true });
    }
    if (sub === "/planos" && M === "POST") {
      const b = await req.json();
      if (!b.number || !keyOk(b.file_key, p.slug)) return err(400, "faltan number/file_key válidos");
      const grupo = groupName(b.grupo);
      await env.DB.prepare(`INSERT OR REPLACE INTO planos (project_slug, grupo, number, name, file_key, updated_by, updated_at)
          VALUES (?,?,?,?,?,?,datetime('now'))`).bind(p.slug, grupo, String(b.number), b.name || String(b.number), b.file_key, user.email).run();
      // Los planos llegan uno por uno: se agrupan en una sola notificación por cada 30 minutos.
      if (b.notify !== false) {
        const abierta = await env.DB.prepare(`SELECT id, cantidad FROM notificaciones WHERE project_slug=? AND tipo='planos'
            AND created_at > datetime('now','-30 minutes') ORDER BY id DESC LIMIT 1`).bind(p.slug).first();
        if (abierta) {
          const t = textoPlanos(p.name, abierta.cantidad + 1);
          await env.DB.prepare("UPDATE notificaciones SET cantidad=cantidad+1, titulo=?, cuerpo=? WHERE id=?").bind(t.titulo, t.cuerpo, abierta.id).run();
        } else {
          await crearNotif(env, ctx, url.origin, p, textoPlanos(p.name, 1), { pushCuerpo: "Hay planos nuevos del proyecto. Ábrelos en el visor." });
        }
      }
      return json({ ok: true, grupo });
    }
    // Renombrar un grupo de planos (por defecto el grupo es el modelo que los contiene)
    if (sub === "/planos-group" && M === "POST") {
      const b = await req.json();
      const from = groupName(b.from), to = groupName(b.to);
      if (from === to) return json({ ok: true, grupo: to });
      try {
        await env.DB.prepare("UPDATE planos SET grupo=? WHERE project_slug=? AND grupo=?").bind(to, p.slug, from).run();
      } catch {
        return err(409, `ya existe el grupo "${to}" con planos del mismo número`);
      }
      return json({ ok: true, grupo: to });
    }
    if ((m = sub.match(/^\/planos\/(.+)$/)) && M === "DELETE") {
      const number = decodeURIComponent(m[1]);
      const grupo = groupName(url.searchParams.get("grupo"));
      const row = await env.DB.prepare("SELECT * FROM planos WHERE project_slug=? AND grupo=? AND number=?").bind(p.slug, grupo, number).first();
      if (!row) return err(404, "plano no encontrado");
      await env.FILES.delete(row.file_key);
      await env.DB.prepare("DELETE FROM planos WHERE project_slug=? AND grupo=? AND number=?").bind(p.slug, grupo, number).run();
      return json({ ok: true });
    }

    // ── Avance de obra → notificación con argumento de venta ────
    // POST { pct: 0-100, etapa?, comentario?, push?: true }  (admin, editor, plugin o Avance Obra AI)
    if (sub === "/avances" && M === "POST") {
      const b = await req.json().catch(() => ({}));
      const pct = Number(b.pct);
      if (b.pct === "" || b.pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100) return err(400, "el avance debe ser un número entre 0 y 100");
      const etapa = normEtapa(b.etapa, pct);
      const comentario = String(b.comentario || "").trim().slice(0, 400) || null;
      const r = await env.DB.prepare("INSERT INTO avances (project_slug, pct, etapa, comentario, created_by) VALUES (?,?,?,?,?)")
        .bind(p.slug, pct, etapa, comentario, user.email).run();
      const avanceId = r.meta.last_row_id;
      const notifId = await crearNotif(env, ctx, url.origin, p,
        { ...textoAvance(p.name, pct, etapa, comentario), pct, etapa, ref: String(avanceId) }, { push: b.push !== false });
      return json({ ok: true, id: avanceId, etapa, notificacion: notifId, push: pushEnabled(env) && b.push !== false });
    }
    if ((m = sub.match(/^\/avances\/(\d+)$/)) && M === "DELETE") {
      await env.DB.prepare("DELETE FROM avances WHERE id=? AND project_slug=?").bind(Number(m[1]), p.slug).run();
      await env.DB.prepare("DELETE FROM notificaciones WHERE project_slug=? AND tipo='avance' AND ref=?").bind(p.slug, m[1]).run();
      return json({ ok: true });
    }
    // Notificaciones: listado para el admin y mensaje comercial libre (tipo 'venta').
    if (sub === "/notificaciones" && M === "GET") {
      const { results } = await env.DB.prepare(`SELECT ${NOTIF_COLS} FROM notificaciones WHERE project_slug=? ORDER BY id DESC LIMIT 100`).bind(p.slug).all();
      const subs = await env.DB.prepare(`SELECT COUNT(DISTINCT email) n FROM push_tokens WHERE email IN (
          SELECT email FROM members WHERE project_slug=?1 UNION SELECT email FROM visits WHERE project_slug=?1 AND ?2=0)`)
        .bind(p.slug, p.restricted ? 1 : 0).first();
      return json({ notificaciones: results || [], push: pushEnabled(env) && !!env.FCM_VAPID_KEY, suscritos: subs ? subs.n : 0 });
    }
    if (sub === "/notificaciones" && M === "POST") {
      const b = await req.json().catch(() => ({}));
      const titulo = String(b.titulo || "").trim(), cuerpo = String(b.cuerpo || "").trim();
      if (!titulo || !cuerpo) return err(400, "faltan título y mensaje");
      const id = await crearNotif(env, ctx, url.origin, p, {
        tipo: "venta", titulo, cuerpo,
        pitch: String(b.pitch || "").trim().slice(0, 900) || CIERRE,
      }, { push: b.push !== false });
      return json({ ok: true, id });
    }
    if ((m = sub.match(/^\/notificaciones\/(\d+)$/)) && M === "DELETE") {
      await env.DB.prepare("DELETE FROM notificaciones WHERE id=? AND project_slug=?").bind(Number(m[1]), p.slug).run();
      return json({ ok: true });
    }

    // ── Subidas del plugin ─────────────────────────────────────
    // Directa (≤ 90 MB): PUT /upload?key=<slug>/…   cuerpo = archivo
    if (sub === "/upload" && M === "PUT") {
      const key = url.searchParams.get("key") || "";
      if (!keyOk(key, p.slug)) return err(400, "clave inválida");
      const size = Number(req.headers.get("Content-Length") || 0);
      if (size > MAX_SMALL_BYTES) return err(413, "usa la subida por partes");
      await env.FILES.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" } });
      return json({ ok: true, key });
    }
    // Por partes (IFC grandes): start → part (n veces) → complete
    if (sub === "/upload/start" && M === "POST") {
      const { key, contentType } = await req.json();
      if (!keyOk(key, p.slug)) return err(400, "clave inválida");
      const mp = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: contentType || "application/octet-stream" } });
      return json({ key, uploadId: mp.uploadId });
    }
    if (sub === "/upload/part" && M === "PUT") {
      const key = url.searchParams.get("key") || "", uploadId = url.searchParams.get("uploadId") || "";
      const partNumber = Number(url.searchParams.get("part"));
      if (!keyOk(key, p.slug) || !uploadId || !(partNumber >= 1)) return err(400, "parámetros inválidos");
      const part = await env.FILES.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, req.body);
      return json(part); // { partNumber, etag }
    }
    if (sub === "/upload/complete" && M === "POST") {
      const { key, uploadId, parts } = await req.json();
      if (!keyOk(key, p.slug)) return err(400, "clave inválida");
      const obj = await env.FILES.resumeMultipartUpload(key, uploadId).complete(parts);
      return json({ ok: true, key, size: obj.size });
    }
    if (sub === "/upload/abort" && M === "POST") {
      const { key, uploadId } = await req.json();
      if (!keyOk(key, p.slug)) return err(400, "clave inválida");
      await env.FILES.resumeMultipartUpload(key, uploadId).abort();
      return json({ ok: true });
    }
    return err(404, "ruta no encontrada");
  }

  // ── Tokens del plugin (solo desde la web, no con otro token) ──
  if (path === "/api/admin/tokens") {
    if (user.via === "token") return err(403, "gestiona los tokens desde la web");
    if (M === "GET") {
      const { results } = await env.DB.prepare("SELECT id, name, created_by, created_at, last_used FROM publish_tokens ORDER BY id DESC").all();
      return json({ tokens: results || [] });
    }
    if (M === "POST") {
      const { name } = await req.json();
      const token = "hub_" + randomId(40);
      await env.DB.prepare("INSERT INTO publish_tokens (name, hash, created_by) VALUES (?,?,?)")
        .bind(String(name || "Plugin Revit").slice(0, 80), await sha256(token), user.email).run();
      return json({ token }); // se muestra UNA sola vez
    }
  }
  if ((m = path.match(/^\/api\/admin\/tokens\/(\d+)$/)) && M === "DELETE") {
    if (user.via === "token") return err(403, "gestiona los tokens desde la web");
    await env.DB.prepare("DELETE FROM publish_tokens WHERE id=?").bind(Number(m[1])).run();
    return json({ ok: true });
  }

  return err(404, "ruta no encontrada");
}
