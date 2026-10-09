// Prueba local del flujo del plugin contra `wrangler dev`:
//   node test/seed.mjs [baseUrl]
// 1) con sesión dev de admin crea un token del plugin, 2) con ese token crea el proyecto,
// sube un IFC por partes (multipart R2) y un PDF, y los registra.
import { readFile } from "node:fs/promises";

const BASE = process.argv[2] || "http://localhost:8787";
const ADMIN = "Bearer dev:baronajuandavid@gmail.com";
const PART = 5 * 1024 * 1024; // mínimo de R2 para partes intermedias

async function call(path, auth, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { Authorization: auth, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} → ${r.status} ${JSON.stringify(body)}`);
  return body;
}
const post = (path, auth, obj, method = "POST") =>
  call(path, auth, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const { token } = await post("/api/admin/tokens", ADMIN, { name: "seed" });
const T = "Bearer " + token;
console.log("token plugin:", token.slice(0, 10) + "…");

const p = await post("/api/admin/projects", T, { name: "Proyecto Prueba Local" });
console.log("proyecto:", p.slug, "link: /p/" + p.share_id);

// IFC por partes
const ifc = await readFile(new URL("./fl-gn4.ifc", import.meta.url));
const key = `${p.slug}/modelos/fl-gn4.ifc`;
const { uploadId } = await post(`/api/admin/projects/${p.slug}/upload/start`, T, { key, contentType: "application/octet-stream" });
const parts = [];
for (let i = 0, n = 1; i < ifc.length; i += PART, n++) {
  const chunk = ifc.subarray(i, i + PART);
  parts.push(await call(`/api/admin/projects/${p.slug}/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${n}`,
    T, { method: "PUT", body: chunk }));
}
const done = await post(`/api/admin/projects/${p.slug}/upload/complete`, T, { key, uploadId, parts });
console.log("IFC subido:", done.size, "bytes en", parts.length, "partes");
await post(`/api/admin/projects/${p.slug}/models`, T, { id: "arquitectura", name: "Arquitectura (FL-GN4)", file_key: key, size: done.size });

// Segundo "modelo" (mismo IFC) para probar prender/apagar
await post(`/api/admin/projects/${p.slug}/models`, T, { id: "copia", name: "Copia de prueba", file_key: key, size: done.size });

// Plano PDF (subida directa)
const pdf = await readFile(new URL("./plano.pdf", import.meta.url));
const pkey = `${p.slug}/planos/a-101-planta.pdf`;
await call(`/api/admin/projects/${p.slug}/upload?key=${encodeURIComponent(pkey)}`, T, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: pdf });
await post(`/api/admin/projects/${p.slug}/planos`, T, { number: "A-101", name: "Planta general", file_key: pkey });
await post(`/api/admin/projects/${p.slug}/planos`, T, { number: "A-102", name: "Planta segundo piso", file_key: pkey });

// Seguridad: un visitante (no admin) no puede registrar modelos ni usar claves de otro proyecto
const V = "Bearer dev:profesional@ejemplo.com";
for (const [path, obj] of [[`/api/admin/projects/${p.slug}/models`, { id: "x", file_key: key }], ["/api/admin/tokens", { name: "x" }]]) {
  try { await post(path, V, obj); console.log("✖ FALLO: visitante pudo", path); } catch (e) { console.log("✔ visitante bloqueado:", e.message.split(" → ")[1].slice(0, 30)); }
}
try { await call(`/api/p/${p.share_id}/file?key=${encodeURIComponent("otro/../x")}`, V); console.log("✖ FALLO traversal"); } catch { console.log("✔ traversal bloqueado"); }
try { await call(`/api/p/${p.share_id}`, "Bearer basura"); console.log("✖ FALLO token basura"); } catch { console.log("✔ token inválido rechazado"); }

console.log(`\nAbrir: ${BASE}/p/${p.share_id}?dev=profesional@ejemplo.com`);
