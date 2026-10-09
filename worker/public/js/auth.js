// Login con Google (Firebase Auth) + cliente de la API del Worker.
// En localhost se puede entrar sin Firebase con ?dev=correo@x.com (solo si el Worker
// corre con DEV_AUTH=1, es decir, `wrangler dev`).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyALlDZKaooZHCGmo_b1dcPVU83ZEO0MSYo",
  authDomain: "lifecity-bim-hub.firebaseapp.com",
  projectId: "lifecity-bim-hub",
  storageBucket: "lifecity-bim-hub.firebasestorage.app",
  messagingSenderId: "1089992266025",
  appId: "1:1089992266025:web:68276ccbdefae6f050e738",
};

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
function devEmail() {
  if (!isLocal) return null;
  const q = new URLSearchParams(location.search).get("dev");
  try {
    if (q) localStorage.setItem("bimhub.dev", q);
    return q || localStorage.getItem("bimhub.dev");
  } catch { return q; }
}

export const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
let current = null; // { email, name, picture }

/** Resuelve con el usuario cuando hay sesión; si no, muestra la pantalla de login. */
export function requireUser(loginEl) {
  const dev = devEmail();
  if (dev) {
    current = { email: dev, name: dev.split("@")[0], picture: null, dev: true };
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (u) => {
      if (u) {
        current = { email: u.email, name: u.displayName || u.email, picture: u.photoURL };
        if (loginEl) loginEl.hidden = true;
        resolve(current);
      } else if (loginEl) {
        loginEl.hidden = false;
      }
    });
  });
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(auth, provider);
}

export async function logout() {
  try { localStorage.removeItem("bimhub.dev"); } catch {}
  if (auth.currentUser) await signOut(auth);
  location.href = "/";
}

export async function getToken() {
  if (current && current.dev) return "dev:" + current.email;
  if (!auth.currentUser) throw new Error("sin sesión");
  // La sesión se renueva cada hora contra Google; si la red falla un instante, reintentar.
  for (let attempt = 1; ; attempt++) {
    try { return await auth.currentUser.getIdToken(); }
    catch (e) {
      if (e.code !== "auth/network-request-failed") throw e;
      if (attempt >= 4) throw new Error("No se pudo renovar tu sesión con Google. Revisa tu conexión a internet (o un bloqueador de anuncios/VPN) e inténtalo de nuevo.");
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
}

export async function authHeader() {
  return { Authorization: "Bearer " + (await getToken()) };
}

/** fetch a /api con el token; devuelve JSON o lanza Error(mensaje del servidor). */
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), ...(await authHeader()) };
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    opts = { ...opts, body: JSON.stringify(opts.json) };
  }
  let r;
  try { r = await fetch(path, { ...opts, headers }); }
  catch { throw new Error("Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo."); }
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error((body && body.error) || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return body;
}

/** Descarga un archivo protegido y devuelve una URL blob: local. */
export async function blobUrl(path) {
  const r = await fetch(path, { headers: await authHeader() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

export const esc = (s) => String(s == null ? "" : s)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function userChip(el, user) {
  el.innerHTML = (user.picture ? `<img src="${esc(user.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${esc((user.name || "?")[0].toUpperCase())}</span>`)
    + `<span class="uname">${esc(user.name)}</span><button class="btn ghost" data-logout>Salir</button>`;
  el.querySelector("[data-logout]").onclick = logout;
}
