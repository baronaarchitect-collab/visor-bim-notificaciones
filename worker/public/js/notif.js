// Notificaciones del BIM Hub: campana con avisos de avance de obra, tarjeta emergente,
// push del navegador (Firebase Cloud Messaging) y la ventana que vende la PÁGINA DE VENTAS
// con respuesta automática. Los interesados quedan como lead en el CRM de Life City.
import { app, api, esc } from "/js/auth.js";

const CRM_LEAD_JS = "https://proyectos-lifecity.github.io/crm/lead.js";
const LS_SOLICITUD = "bimhub.ventas.solicitud";
const POLL_MS = 60 * 1000;
const ICONO = { avance: "📈", modelo: "🧊", planos: "📐", venta: "💬" };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const hace = (s) => {
  const t = new Date(String(s).replace(" ", "T") + "Z").getTime();
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d < 30 ? `hace ${d} d` : new Date(t).toLocaleDateString("es-CO", { dateStyle: "medium" });
};
const pctTxt = (n) => (Math.round(Number(n) * 10) / 10).toLocaleString("es-CO") + " %";

let config = null;
async function getConfig() {
  if (!config) config = await api("/api/config").catch(() => ({ push: { enabled: false }, ventas: {} }));
  return config;
}

// ── Barra de avance ─────────────────────────────────────────────
export function barraAvance(pct, etapa) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="avbar" title="Avance de obra"><div class="avbar-fill" style="width:${v}%"></div></div>
    <div class="avbar-txt"><strong>${pctTxt(v)}</strong>${etapa ? ` · ${esc(etapa)}` : ""}</div>`;
}

// ── Ventana de venta: la página de ventas con respuesta automática ──
let dlg;
export async function abrirVenta(n, ctx = {}) {
  const cfg = await getConfig();
  const proyecto = ctx.proyecto || n.proyecto || "";
  const user = ctx.user || {};
  const previa = store.get(LS_SOLICITUD);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "vmodal";
    document.body.appendChild(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  const wa = cfg.ventas && cfg.ventas.whatsapp
    ? `https://wa.me/${cfg.ventas.whatsapp}?text=${encodeURIComponent(`Hola, vi el avance de ${proyecto || "mi proyecto"} en el BIM Hub y quiero la página de ventas con respuesta automática.`)}`
    : null;

  dlg.innerHTML = `
    <button class="vm-x" data-close aria-label="Cerrar">✕</button>
    <div class="vm-head">
      <div class="vm-kicker">${ICONO[n.tipo] || "🔔"} ${esc(n.titulo || "Avance del proyecto")}</div>
      ${n.pct != null ? barraAvance(n.pct, n.etapa) : ""}
      <h2>Vende ${proyecto ? esc(proyecto) : "tu proyecto"} mientras avanza la obra</h2>
      <p class="vm-pitch">${esc(n.pitch || "Quien responde primero, vende. La página de ventas contesta a cada interesado en segundos, de día y de noche.")}</p>
    </div>
    <div class="vm-stat"><b>+391 %</b><span>más probabilidad de venta cuando respondes en el primer minuto. La página de ventas lo hace sola, 24/7.</span></div>
    <ul class="vm-list">
      <li><b>Responde automáticamente</b> a cada persona que pregunta por un apartamento o una inversión.</li>
      <li><b>Eres el primero en contestar</b>, antes que los otros proyectos que ese comprador está mirando.</li>
      <li><b>Cada avance de obra se vuelve un argumento</b> para cerrar: el comprador ve que el proyecto avanza.</li>
    </ul>
    ${previa ? `<div class="vm-ok">Ya pediste tu página de ventas el ${new Date(previa.fecha).toLocaleDateString("es-CO", { dateStyle: "long" })}. El equipo de Life City te contactará. Si quieres, déjanos otro dato abajo.</div>` : ""}
    <form class="vm-form" novalidate>
      <div class="vm-row">
        <label>Nombre<input type="text" name="contacto" required maxlength="120" value="${esc(user.name || "")}" autocomplete="name"></label>
        <label>Celular / WhatsApp<input type="tel" name="celular" required maxlength="30" autocomplete="tel" placeholder="300 123 4567"></label>
      </div>
      <label>Correo<input type="email" name="correo" required maxlength="160" value="${esc(user.email || "")}" autocomplete="email"></label>
      <label>¿Cuántas unidades te quedan por vender? <span class="tiny">(opcional)</span><input type="text" name="unidades" maxlength="60" placeholder="Ej. 24 apartamentos"></label>
      <div class="vm-msg" aria-live="polite"></div>
      <div class="vm-acts">
        <button type="submit" class="btn primary vm-cta">Quiero mi página de ventas</button>
        ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">Hablar por WhatsApp</a>` : ""}
        ${cfg.ventas && cfg.ventas.demoUrl ? `<a class="btn ghost" href="${esc(cfg.ventas.demoUrl)}" target="_blank" rel="noopener">Ver un ejemplo ↗</a>` : ""}
      </div>
    </form>`;
  dlg.querySelector("[data-close]").onclick = () => dlg.close();

  const form = dlg.querySelector("form"), msg = dlg.querySelector(".vm-msg");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (!d.contacto.trim() || !d.celular.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.correo.trim())) {
      msg.textContent = "Escribe tu nombre, celular y un correo válido."; msg.className = "vm-msg err"; return;
    }
    const btn = form.querySelector(".vm-cta"); btn.disabled = true; msg.className = "vm-msg"; msg.textContent = "Enviando…";
    let enviado = true;
    try {
      const { guardarLeadBim } = await import(CRM_LEAD_JS);
      // Firestore encola la escritura si no hay red: no dejamos el botón en "Enviando…" para siempre.
      const limite = new Promise((_, rej) => setTimeout(() => rej(new Error("el CRM no respondió")), 12000));
      await Promise.race([limite, guardarLeadBim({
        contacto: d.contacto.trim(), celular: d.celular.trim(), correo: d.correo.trim(),
        proyecto, tipo: "Página de ventas auto-respuesta",
        mensaje: [`Pidió la página de ventas desde la notificación: ${n.titulo || ""}`,
                  n.pct != null ? `Avance ${pctTxt(n.pct)} (${n.etapa || ""})` : "",
                  d.unidades ? `Unidades por vender: ${d.unidades}` : ""].filter(Boolean).join(" · "),
        origen: `Visor BIM · notificación ${n.tipo || "avance"}`,
      })]);
    } catch (err) {
      // Si el CRM no responde, no dejamos al usuario atrapado: se ofrece WhatsApp y se registra el error.
      enviado = false;
      console.warn("CRM:", err);
    }
    store.set(LS_SOLICITUD, { fecha: Date.now(), proyecto, enviado });
    btn.disabled = false;
    if (enviado) {
      form.innerHTML = `<div class="vm-ok big">¡Listo, ${esc(d.contacto.trim().split(" ")[0])}! Te contactamos muy pronto para activar la página de ventas de ${esc(proyecto || "tu proyecto")}.</div>`;
    } else {
      msg.className = "vm-msg err";
      msg.innerHTML = `No pudimos enviar tu solicitud. ${wa ? `<a href="${esc(wa)}" target="_blank" rel="noopener">Escríbenos por WhatsApp</a> o i` : "I"}ntenta de nuevo en un momento.`;
    }
  };
  if (!dlg.open) dlg.showModal();
}

// ── Tarjeta emergente (la notificación más reciente sin leer) ──
let cardEl;
function mostrarTarjeta(n, ctx) {
  const visto = "bimhub.card." + n.id;
  if (store.get(visto)) return;
  store.set(visto, 1);
  if (cardEl) cardEl.remove();
  cardEl = document.createElement("div");
  cardEl.className = "ncard";
  cardEl.innerHTML = `<button class="vm-x" aria-label="Cerrar">✕</button>
    <div class="ncard-t">${ICONO[n.tipo] || "🔔"} ${esc(n.titulo)}</div>
    ${n.pct != null ? barraAvance(n.pct, n.etapa) : ""}
    <div class="ncard-b">${esc(n.cuerpo)}</div>
    <div class="ncard-p">Quien responde primero vende: <b>+391 %</b> de probabilidad de venta con la página de ventas que contesta sola.</div>
    <div class="ncard-a"><button class="btn primary sm" data-go>Ver cómo vender más</button><button class="btn sm ghost" data-no>Ahora no</button></div>`;
  document.body.appendChild(cardEl);
  requestAnimationFrame(() => cardEl.classList.add("on"));
  const cerrar = () => { cardEl.classList.remove("on"); setTimeout(() => cardEl && cardEl.remove(), 300); };
  cardEl.querySelector(".vm-x").onclick = cerrar;
  cardEl.querySelector("[data-no]").onclick = cerrar;
  cardEl.querySelector("[data-go]").onclick = () => { cerrar(); abrirVenta(n, ctx); };
}

// ── Push del navegador ──────────────────────────────────────────
async function pushSoportado() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return false;
  const cfg = await getConfig();
  return !!(cfg.push && cfg.push.enabled && cfg.push.vapidKey);
}

export async function activarPush() {
  const cfg = await getConfig();
  const { getMessaging, getToken, isSupported } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
  if (!(await isSupported())) throw new Error("Este navegador no admite notificaciones push.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("No diste permiso de notificaciones. Puedes activarlo en el candado de la barra de direcciones.");
  const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const token = await getToken(getMessaging(app), { vapidKey: cfg.push.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error("No se pudo registrar este navegador.");
  await api("/api/push/token", { method: "POST", json: { token } });
  store.set("bimhub.push", { token, fecha: Date.now() });
  return token;
}

// Avisos que llegan con la pestaña abierta (el SDK no los muestra solo).
async function escucharPrimerPlano(onLlega) {
  if (Notification.permission !== "granted" || !store.get("bimhub.push")) return;
  try {
    const { getMessaging, onMessage, isSupported } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
    if (await isSupported()) onMessage(getMessaging(app), () => onLlega());
  } catch {}
}

// ── Campana ─────────────────────────────────────────────────────
/**
 * Monta la campana de notificaciones.
 * @param host  elemento donde va el botón
 * @param ctx   { share?, proyecto?, user }  con share = notificaciones de ese proyecto; sin share = de todos mis proyectos
 */
export async function montarCampana(host, ctx = {}) {
  const base = ctx.share ? `/api/p/${ctx.share}/notificaciones` : "/api/notificaciones";
  const btn = document.createElement("button");
  btn.className = "btn bell";
  btn.title = "Notificaciones";
  btn.setAttribute("aria-label", "Notificaciones");
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><span class="bell-n" hidden></span>`;
  host.prepend(btn);

  const panel = document.createElement("div");
  panel.className = "npanel";
  panel.hidden = true;
  document.body.appendChild(panel);

  let items = [];
  const nuevas = () => items.filter((n) => n.nueva).length;
  const pintarBadge = () => {
    const b = btn.querySelector(".bell-n"), k = nuevas();
    b.hidden = !k; b.textContent = k > 9 ? "9+" : k;
    btn.classList.toggle("ring", k > 0);
  };

  async function pintarPanel() {
    const puedePush = await pushSoportado();
    const pushOn = puedePush && Notification.permission === "granted" && store.get("bimhub.push");
    panel.innerHTML = `<div class="np-h"><b>Notificaciones</b>${ctx.proyecto ? `<span class="tiny">${esc(ctx.proyecto)}</span>` : ""}</div>
      <div class="np-list">${items.length ? items.map((n) => `
        <div class="np-it${n.nueva ? " nueva" : ""}" data-id="${n.id}">
          <div class="np-ic">${ICONO[n.tipo] || "🔔"}</div>
          <div class="np-tx">
            <div class="np-t">${esc(n.titulo)}</div>
            <div class="np-b">${esc(n.cuerpo)}</div>
            ${n.pct != null ? barraAvance(n.pct, n.etapa) : ""}
            <div class="np-f"><span class="tiny">${hace(n.created_at)}</span><span class="np-cta">Vender más con la página de ventas →</span></div>
          </div>
        </div>`).join("") : `<div class="np-empty">Aún no hay avisos. Cuando el proyecto avance, te avisamos aquí.</div>`}</div>
      ${puedePush ? `<div class="np-push">${pushOn
        ? `<span class="tiny">✓ Avisos activos en este navegador</span>`
        : `<button class="btn sm primary" data-push>Recibir avisos aunque cierre el visor</button><div class="tiny np-push-msg"></div>`}</div>` : ""}`;

    panel.querySelectorAll(".np-it").forEach((el) => el.onclick = () => {
      const n = items.find((x) => String(x.id) === el.dataset.id);
      if (!n) return;
      // En la página principal, abrir el visor del proyecto; en el visor, la ventana de venta.
      if (!ctx.share && n.share_id) { location.href = `/p/${n.share_id}?notif=${n.id}`; return; }
      cerrarPanel(); abrirVenta(n, ctx);
    });
    const pb = panel.querySelector("[data-push]");
    if (pb) pb.onclick = async () => {
      pb.disabled = true;
      const m = panel.querySelector(".np-push-msg");
      try { await activarPush(); m.textContent = ""; pintarPanel(); }
      catch (e) { m.textContent = e.message; pb.disabled = false; }
    };
  }

  function colocarPanel() {
    const r = btn.getBoundingClientRect();
    panel.style.top = Math.round(r.bottom + 8) + "px";
    panel.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
  }
  async function abrirPanel() {
    colocarPanel(); panel.hidden = false; await pintarPanel();
    if (nuevas()) {
      api(base + "/leidas", { method: "POST", json: {} }).catch(() => {});
      setTimeout(() => { items.forEach((n) => (n.nueva = false)); pintarBadge(); }, 1500);
    }
  }
  function cerrarPanel() { panel.hidden = true; }
  btn.onclick = (e) => { e.stopPropagation(); panel.hidden ? abrirPanel() : cerrarPanel(); };
  document.addEventListener("click", (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) cerrarPanel(); });
  window.addEventListener("resize", () => { if (!panel.hidden) colocarPanel(); });

  async function cargar() {
    try {
      const r = await api(base);
      const antes = new Set(items.map((n) => n.id));
      items = r.notificaciones || [];
      pintarBadge();
      if (!panel.hidden) pintarPanel();
      // Tarjeta emergente con la más reciente sin leer (en el visor, cuando aparece una nueva).
      const top = items.find((n) => n.nueva);
      if (ctx.share && top && !antes.has(top.id)) mostrarTarjeta(top, ctx);
    } catch {}
  }

  // Llegó desde un push o un link: /p/<share>?notif=<id> abre esa notificación (sin tarjeta encima).
  const q = ctx.share ? new URLSearchParams(location.search).get("notif") : null;
  if (q) store.set("bimhub.card." + q, 1);

  await cargar();
  setInterval(() => { if (!document.hidden) cargar(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) cargar(); });
  escucharPrimerPlano(cargar);

  if (q) {
    const n = items.find((x) => String(x.id) === q);
    if (n) abrirVenta(n, ctx);
    history.replaceState(null, "", location.pathname);
  }
  return { recargar: cargar };
}
