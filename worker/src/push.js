// Push del navegador con Firebase Cloud Messaging (API HTTP v1).
//
// Requiere el secreto FCM_SERVICE_ACCOUNT (JSON de la cuenta de servicio del proyecto Firebase
// lifecity-bim-hub). Sin él, las notificaciones siguen funcionando dentro del visor y el push se omite.
//   npx wrangler secret put FCM_SERVICE_ACCOUNT   (pegar el JSON completo en una línea)

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(enc.encode(s));

let tokenCache = { token: null, exp: 0, email: null };

function serviceAccount(env) {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
    return sa.client_email && sa.private_key ? sa : null;
  } catch { return null; }
}

export const pushEnabled = (env) => !!serviceAccount(env);

async function importPem(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// Token OAuth de Google para la cuenta de servicio (se reutiliza ~55 min).
async function accessToken(sa) {
  if (tokenCache.token && tokenCache.email === sa.client_email && tokenCache.exp > Date.now()) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importPem(sa.private_key), enc.encode(head + "." + claim));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + claim + "." + b64url(sig),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error("OAuth FCM: " + (body.error_description || body.error || r.status));
  tokenCache = { token: body.access_token, exp: Date.now() + 55 * 60 * 1000, email: sa.client_email };
  return tokenCache.token;
}

/**
 * Envía la notificación a todos los navegadores de los usuarios del proyecto.
 * @param msg { titulo, cuerpo, link }  link = URL absoluta https del visor
 * @returns { enviados, fallidos, borrados } o { omitido }
 */
export async function pushProyecto(env, project, msg) {
  const sa = serviceAccount(env);
  if (!sa) return { omitido: "sin FCM_SERVICE_ACCOUNT" };

  const admins = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  // Destinatarios = admins + usuarios agregados + (si el proyecto es abierto) quienes ya entraron.
  const { results } = await env.DB.prepare(`SELECT token FROM push_tokens WHERE email IN (
      SELECT email FROM members WHERE project_slug=?1
      UNION SELECT email FROM visits WHERE project_slug=?1 AND ?2=0
      UNION SELECT value FROM json_each(?3))`)
    .bind(project.slug, project.restricted ? 1 : 0, JSON.stringify(admins)).all();
  const tokens = (results || []).map((r) => r.token);
  if (!tokens.length) return { enviados: 0, fallidos: 0, borrados: 0 };

  const auth = "Bearer " + (await accessToken(sa));
  const projectId = sa.project_id || env.FIREBASE_PROJECT_ID;
  const out = { enviados: 0, fallidos: 0, borrados: 0 };
  const muertos = [];

  // En tandas de 20 para no abrir cientos de conexiones a la vez.
  for (let i = 0; i < tokens.length; i += 20) {
    await Promise.all(tokens.slice(i, i + 20).map(async (token) => {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            data: { titulo: msg.titulo, cuerpo: msg.cuerpo, link: msg.link },
            webpush: {
              headers: { Urgency: "normal", TTL: String(3 * 24 * 3600) },
              notification: { title: msg.titulo, body: msg.cuerpo, icon: "/icon-192.png", badge: "/icon-192.png", tag: "bimhub-" + project.slug },
              fcm_options: { link: msg.link },
            },
          },
        }),
      });
      if (r.ok) { out.enviados++; return; }
      out.fallidos++;
      const body = await r.json().catch(() => ({}));
      const code = JSON.stringify(body);
      // Token vencido o el usuario quitó el permiso: se borra.
      if (r.status === 404 || code.includes("UNREGISTERED")) muertos.push(token);
    }));
  }
  for (const t of muertos) await env.DB.prepare("DELETE FROM push_tokens WHERE token=?").bind(t).run();
  out.borrados = muertos.length;
  return out;
}
