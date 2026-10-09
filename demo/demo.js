// MODO DEMO (GitHub Pages): la misma interfaz del BIM Hub sin el Worker de Cloudflare.
// Intercepta fetch("/api/…") y responde como el Worker, con un proyecto de ejemplo guardado en
// localStorage. Los textos de venta salen del mismo módulo que usa el Worker (ventas.js).
// Lo inyecta demo/build.mjs; no se usa en producción.
import { CIERRE, ETAPAS, normEtapa, textoAvance, textoModelo, textoPlanos } from "./ventas.js";

const KEY = "bimhub.demo.v1", UKEY = "bimhub.demo.user";
const USERS = {
  "promotor@demo.lifecity.co": { name: "Promotor (demo)", admin: false },
  "admin@demo.lifecity.co": { name: "Administrador (demo)", admin: true },
};
const SHARE = "torre-mirador", SLUG = "torre-mirador";
const NOMBRE = "Torre Mirador";
const sql = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const hace = (dias, horas = 0) => sql(new Date(Date.now() - dias * 864e5 - horas * 36e5));

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const demoUser = ls.get(UKEY) in USERS ? ls.get(UKEY) : "promotor@demo.lifecity.co";
window.__DEMO_USER = demoUser;

function seed() {
  const s = { v: 1, nid: 0, aid: 0, avances: [], notifs: [], leidas: {} };
  const notif = (n, created_at) => { s.notifs.push({ id: ++s.nid, project_slug: SLUG, cantidad: 1, pct: null, etapa: null, ref: null, ...n, created_at }); return s.nid; };
  const avance = (pct, etapa, comentario, dias) => {
    const id = ++s.aid, created_at = hace(dias);
    s.avances.push({ id, pct, etapa, comentario, created_by: "admin@demo.lifecity.co", created_at });
    notif({ ...textoAvance(NOMBRE, pct, etapa, comentario), pct, etapa, ref: String(id) }, created_at);
  };
  avance(8, "Cimentación", "Terminó la excavación y el pilotaje", 64);
  avance(35, "Estructura", "Se fundió la placa del piso 5", 30);
  notif(textoModelo(NOMBRE, "Torre Mirador · Arquitectura y estructura"), hace(12));
  notif({ ...textoPlanos(NOMBRE, 1) }, hace(12, -1));
  avance(62, "Mampostería", "Mampostería hasta el piso 9 y ventanería hasta el piso 7", 2);
  // El promotor tiene sin leer los dos últimos avisos; el admin, ninguno.
  s.leidas = { "promotor@demo.lifecity.co": s.nid - 2, "admin@demo.lifecity.co": s.nid };
  return s;
}
let S = ls.get(KEY);
if (!S || S.v !== 1) { S = seed(); ls.set(KEY, S); }
const guardar = () => ls.set(KEY, S);

const MODELS = [{ id: "torre-mirador", name: "Torre Mirador · Arquitectura y estructura", file_key: "torre-mirador/modelos/torre-mirador.ifc",
  meta_key: null, schedules_key: null, size: 316256, updated_at: hace(12) }];
const PLANOS = [{ grupo: "Torre Mirador · Arquitectura y estructura", number: "A-101", name: "Planta tipo", file_key: "torre-mirador/planos/a-101.pdf", updated_at: hace(12) }];

// ── Respuestas ───────────────────────────────────────────────────
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const err = (status, error) => json({ error }, status);
const SOLO_LECTURA = "En la demo no se puede cambiar esto. Prueba publicar un avance de obra o un mensaje comercial.";
const ultimoAvance = () => S.avances.length ? S.avances[S.avances.length - 1] : null;
const conNueva = (email) => (n) => ({ ...n, nueva: n.id > (S.leidas[email] || 0) });
const recientes = () => [...S.notifs].sort((a, b) => b.id - a.id);

function crearNotif(n) {
  S.notifs.push({ id: ++S.nid, project_slug: SLUG, cantidad: 1, pct: null, etapa: null, ref: null, ...n, created_at: sql(new Date()) });
  guardar();
  return S.nid;
}

async function api(method, url, body, email) {
  const user = { email, ...(USERS[email] || USERS["promotor@demo.lifecity.co"]) };
  const path = url.pathname.replace(/\/+$/, "");
  let m;

  if (path === "/api/config") return json({ push: { enabled: false, vapidKey: null }, ventas: { demoUrl: null, whatsapp: null } });
  if (path === "/api/me") {
    const a = ultimoAvance();
    const p = { slug: SLUG, name: NOMBRE, share_id: SHARE, created_at: hace(70), av_pct: a && a.pct, av_etapa: a && a.etapa };
    return json({ email, name: user.name, admin: user.admin, projects: [user.admin
      ? { ...p, models: MODELS.length, planos: PLANOS.length, visitors: 2, members: 1, restricted: 0, docs: 0 }
      : { ...p, role: "visor", last_seen: hace(2) }] });
  }
  if (path === "/api/notificaciones" && method === "GET") {
    const list = recientes().slice(0, 40).map(conNueva(email)).map((n) => ({ ...n, proyecto: NOMBRE, share_id: SHARE }));
    return json({ notificaciones: list, nuevas: list.filter((n) => n.nueva).length });
  }
  if (path === "/api/notificaciones/leidas" && method === "POST") { S.leidas[email] = S.nid; guardar(); return json({ ok: true }); }
  if (path === "/api/admin/tokens" && method === "GET") return json({ tokens: [] });

  if ((m = path.match(/^\/api\/p\/([\w-]+)(\/.*)?$/))) {
    if (m[1] !== SHARE) return err(404, "proyecto no encontrado");
    const sub = m[2] || "";
    if (sub === "" && method === "GET") return json({
      slug: SLUG, name: NOMBRE, share_id: SHARE, allow_docs: false, admin: user.admin, can_edit: user.admin, restricted: false,
      me: { email, name: user.name }, models: MODELS, planos: PLANOS, docs_count: 0, avance: ultimoAvance(), etapas: ETAPAS,
    });
    if (sub === "/notificaciones" && method === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      return json({ notificaciones: recientes().filter((n) => n.id > after).slice(0, 30).map(conNueva(email)), last_read: S.leidas[email] || 0 });
    }
    if (sub === "/notificaciones/leidas" && method === "POST") {
      const hasta = Number(body && body.hasta) > 0 ? Math.min(Number(body.hasta), S.nid) : S.nid;
      S.leidas[email] = Math.max(S.leidas[email] || 0, hasta); guardar();
      return json({ ok: true, last_read: S.leidas[email] });
    }
    if (sub === "/avances" && method === "GET") return json({ avances: [...S.avances].reverse() });
    if (sub === "/docs" && method === "GET") return json({ docs: [] });
    if (sub === "/file" && method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!/^torre-mirador\/[\w./-]+$/.test(key) || key.includes("..")) return err(400, "clave inválida");
      return realFetch(new URL("demo/files/" + key, document.baseURI));
    }
    return err(403, SOLO_LECTURA);
  }

  if ((m = path.match(/^\/api\/admin\/projects\/([\w-]+)(\/.*)?$/))) {
    if (!user.admin) return err(403, "solo administradores");
    if (m[1] !== SLUG) return err(404, "proyecto no encontrado");
    const sub = m[2] || "";
    if (sub === "/members" && method === "GET")
      return json({ members: [{ email: "promotor@demo.lifecity.co", role: "visor", added_by: "admin@demo.lifecity.co", added_at: hace(70), last_seen: hace(2) }], restricted: false });
    if (sub === "/visits" && method === "GET")
      return json({ visits: Object.keys(USERS).map((e) => ({ email: e, name: USERS[e].name, first_seen: hace(60), last_seen: hace(0, 1) })) });
    if (sub === "/notificaciones" && method === "GET") return json({ notificaciones: recientes(), push: false, suscritos: 0 });
    if (sub === "/notificaciones" && method === "POST") {
      const titulo = String(body.titulo || "").trim(), cuerpo = String(body.cuerpo || "").trim();
      if (!titulo || !cuerpo) return err(400, "faltan título y mensaje");
      return json({ ok: true, id: crearNotif({ tipo: "venta", titulo: titulo.slice(0, 200), cuerpo: cuerpo.slice(0, 600), pitch: CIERRE }) });
    }
    if ((m = sub.match(/^\/notificaciones\/(\d+)$/)) && method === "DELETE") {
      S.notifs = S.notifs.filter((n) => n.id !== Number(m[1])); guardar(); return json({ ok: true });
    }
    if (sub === "/avances" && method === "POST") {
      const pct = Number(body.pct);
      if (body.pct === "" || body.pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100) return err(400, "el avance debe ser un número entre 0 y 100");
      const etapa = normEtapa(body.etapa, pct);
      const comentario = String(body.comentario || "").trim().slice(0, 400) || null;
      const id = ++S.aid;
      S.avances.push({ id, pct, etapa, comentario, created_by: email, created_at: sql(new Date()) });
      const nid = crearNotif({ ...textoAvance(NOMBRE, pct, etapa, comentario), pct, etapa, ref: String(id) });
      return json({ ok: true, id, etapa, notificacion: nid, push: false });
    }
    if ((m = sub.match(/^\/avances\/(\d+)$/)) && method === "DELETE") {
      S.avances = S.avances.filter((a) => a.id !== Number(m[1]));
      S.notifs = S.notifs.filter((n) => !(n.tipo === "avance" && n.ref === m[1]));
      guardar(); return json({ ok: true });
    }
    return err(403, SOLO_LECTURA);
  }
  if (path.startsWith("/api/admin/")) return err(403, SOLO_LECTURA);
  return err(404, "ruta no encontrada");
}

// ── Intercepción de fetch ────────────────────────────────────────
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
  const method = (init.method || (req && req.method) || "GET").toUpperCase();
  const headers = new Headers(init.headers || (req && req.headers) || {});
  const auth = headers.get("Authorization") || "";
  const email = auth.startsWith("Bearer dev:") ? auth.slice(11) : demoUser;
  let body = null;
  const raw = init.body !== undefined ? init.body : (req && method !== "GET" ? await req.text() : null);
  if (typeof raw === "string") { try { body = JSON.parse(raw); } catch { body = null; } }
  await new Promise((r) => setTimeout(r, 120)); // latencia de red simulada
  return api(method, url, body || {}, email);
};

// ── Barra de la demo: cambiar de usuario y reiniciar ──────────────
function barra() {
  const el = document.createElement("div");
  el.className = "demobar";
  el.innerHTML = `<b>DEMO</b><label>Ver como <select>${Object.entries(USERS).map(([e, u]) =>
    `<option value="${e}"${e === demoUser ? " selected" : ""}>${u.admin ? "Administrador" : "Promotor (cliente)"}</option>`).join("")}</select></label>
    <button type="button" title="Vuelve al estado inicial de la demo">Reiniciar</button>`;
  el.querySelector("select").onchange = (e) => { ls.set(UKEY, e.target.value); location.reload(); };
  el.querySelector("button").onclick = () => {
    try { Object.keys(localStorage).filter((k) => k.startsWith("bimhub.") && k !== UKEY).forEach((k) => localStorage.removeItem(k)); } catch {}
    location.reload();
  };
  document.body.appendChild(el);
  const st = document.createElement("style");
  st.textContent = `.demobar{position:fixed;left:8px;bottom:30px;z-index:105;display:flex;align-items:center;gap:8px;padding:5px 8px 5px 10px;
    background:#2d1f05;border:1px solid var(--warn);border-radius:999px;font-size:12px;color:var(--text);box-shadow:0 6px 18px rgba(0,0,0,.4)}
    .demobar b{color:var(--warn);letter-spacing:.06em}.demobar label{display:flex;align-items:center;gap:6px;color:var(--muted)}
    .demobar select{width:auto;padding:2px 6px;font-size:12px}.demobar button{background:none;border:1px solid var(--border);color:var(--text);
    border-radius:999px;padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit}`;
  document.head.appendChild(st);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", barra); else barra();
