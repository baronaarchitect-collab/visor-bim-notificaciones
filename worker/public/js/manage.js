// Gestión de un proyecto desde la web: subir modelos y planos, y (admins) usuarios y acceso.
import { api, esc } from "/js/auth.js";

export const slugify = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "archivo";

const fsize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round((n || 0) / 1024)) + " KB";
const fdate = (s) => s ? new Date(s.replace(" ", "T") + "Z").toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "—";

// Sube un archivo al proyecto: directo si es pequeño, por partes de 40 MB si es grande.
const PART = 40 * 1024 * 1024;
export async function uploadFile(slug, key, file, contentType, onProgress = () => {}) {
  const base = `/api/admin/projects/${slug}`;
  const k = encodeURIComponent(key);
  if (file.size <= PART) {
    await api(`${base}/upload?key=${k}`, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
    onProgress(1);
    return;
  }
  const { uploadId } = await api(`${base}/upload/start`, { method: "POST", json: { key, contentType } });
  const parts = [];
  try {
    for (let off = 0, n = 1; off < file.size; off += PART, n++) {
      let part;
      for (let attempt = 1; ; attempt++) {
        try {
          part = await api(`${base}/upload/part?key=${k}&uploadId=${encodeURIComponent(uploadId)}&part=${n}`,
            { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(off, off + PART) });
          break;
        } catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 2000 * attempt)); }
      }
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      onProgress(Math.min(1, (off + PART) / file.size));
    }
    await api(`${base}/upload/complete`, { method: "POST", json: { key, uploadId, parts } });
  } catch (e) {
    try { await api(`${base}/upload/abort`, { method: "POST", json: { key, uploadId } }); } catch {}
    throw e;
  }
}

/**
 * Abre el diálogo de gestión.
 * @param ctx { dlg, body, toast, onChange }  elementos de la página y aviso de cambios
 */
export async function manage(slug, share, admin, ctx) {
  const base = `/api/admin/projects/${slug}`;
  const $ = (id) => ctx.body.querySelector("#" + id);
  let p, mem = null, av = { avances: [] }, nt = null;
  try {
    p = await api(`/api/p/${share}`);
    av = await api(`/api/p/${share}/avances`);
    if (admin) [mem, nt] = await Promise.all([api(`${base}/members`), api(`${base}/notificaciones`)]);
  } catch (e) { alert(e.message); return; }

  const del = (attr, v) => admin ? `<button class="btn sm danger" ${attr}="${esc(v)}">Borrar</button>` : "";
  let html = `<div class="mg"><h3>${esc(p.name)}</h3><div class="tiny">${esc(location.origin)}/p/${esc(p.share_id)}</div>
    <h4>Modelos 3D (${p.models.length})</h4>
    ${p.models.map((m) => `<div class="it"><span title="${esc(m.name)}">${esc(m.name)}</span><span class="tiny">${fsize(m.size)} · ${fdate(m.updated_at)}</span>${del("data-delm", m.id)}</div>`).join("") || `<div class="hint">Sin modelos.</div>`}
    <div class="up"><input type="file" id="mg-ifc" accept=".ifc" multiple><button class="btn primary" id="mg-ifc-btn">Subir modelos IFC</button></div>
    <div class="hint" style="margin-top:4px">El nombre del archivo será el nombre del modelo. Si ya existe uno con ese nombre, se reemplaza. Los modelos subidos desde aquí no traen cantidades (esas salen del plugin de Revit).</div>
    <div class="msg" id="mg-ifc-msg"></div>
    <h4>Planos (${p.planos.length})</h4>
    ${p.planos.map((x) => `<div class="it"><span title="${esc(x.name)}"><b>${esc(x.number)}</b> ${esc(x.name)}</span><span class="badge">${esc(x.grupo)}</span><span class="tiny">${fdate(x.updated_at)}</span>${admin ? `<button class="btn sm danger" data-delp="${esc(x.number)}" data-grupo="${esc(x.grupo)}">Borrar</button>` : ""}</div>`).join("") || `<div class="hint">Sin planos.</div>`}
    <div class="up"><input type="file" id="mg-pdf" accept=".pdf" multiple>
      <input type="text" id="mg-grupo" list="mg-grupos" placeholder="Modelo al que pertenecen" style="flex:1;min-width:170px">
      <datalist id="mg-grupos">${[...new Set([...p.models.map((m) => m.name), ...p.planos.map((x) => x.grupo)])].map((g) => `<option value="${esc(g)}">`).join("")}</datalist>
      <button class="btn primary" id="mg-pdf-btn">Subir planos PDF</button></div>
    <div class="hint" style="margin-top:4px">Nombra los archivos como <b>A-101 Planta general.pdf</b>: lo primero es el número del plano. Elige el modelo al que pertenecen para que queden agrupados en la pestaña Planos.</div>
    <div class="msg" id="mg-pdf-msg"></div>
    <h4>Avance de obra · notifica a los usuarios</h4>
    <div class="hint" style="margin-bottom:6px">Cada avance llega como aviso a quienes ven el proyecto, con el argumento para vender la página de ventas con respuesta automática.</div>
    <div class="up">
      <input type="text" inputmode="decimal" id="mg-pct" placeholder="% avance" style="width:100px;flex:none">
      <select id="mg-etapa"><option value="">Etapa según el %</option>${(p.etapas || []).map((e) => `<option>${esc(e)}</option>`).join("")}</select>
      <input type="text" id="mg-com" maxlength="400" placeholder="Comentario (opcional): se fundió la placa del piso 5" style="flex:1;min-width:200px">
      <button class="btn primary" id="mg-av-btn">Publicar avance</button>
    </div>
    ${nt && nt.push ? `<label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="mg-push" checked> Enviar también como push del navegador (${nt.suscritos} usuario(s) con avisos activos)</label>`
      : admin ? `<div class="hint" style="margin-top:6px">Push del navegador sin configurar: los avisos salen en la campana del visor. Ver README → Notificaciones.</div>` : ""}
    <div class="msg" id="mg-av-msg"></div>
    ${av.avances.map((a) => `<div class="it"><span title="${esc(a.comentario || "")}"><b>${esc(String(a.pct))} %</b> ${esc(a.etapa)}${a.comentario ? ` · ${esc(a.comentario)}` : ""}</span><span class="tiny">${fdate(a.created_at)}</span>${admin ? `<button class="btn sm danger" data-delav="${a.id}">Borrar</button>` : ""}</div>`).join("") || `<div class="hint">Aún no hay avances publicados.</div>`}`;
  if (admin) {
    html += `<h4>Mensaje comercial a los usuarios</h4>
      <div class="up"><input type="text" id="mg-nt-t" maxlength="200" placeholder="Título: Quedan 8 apartamentos con vista al parque" style="flex:1;min-width:200px"></div>
      <div class="up"><input type="text" id="mg-nt-c" maxlength="600" placeholder="Mensaje: Activa la página de ventas y responde primero a cada interesado" style="flex:1;min-width:200px">
        <button class="btn primary" id="mg-nt-btn">Enviar aviso</button></div>
      <div class="msg" id="mg-nt-msg"></div>
      <h4>Avisos enviados (${nt.notificaciones.length})</h4>
      ${nt.notificaciones.slice(0, 15).map((n) => `<div class="it"><span title="${esc(n.cuerpo)}">${esc(n.titulo)}</span><span class="badge">${esc(n.tipo)}</span><span class="tiny">${fdate(n.created_at)}</span><button class="btn sm danger" data-delnt="${n.id}">Quitar</button></div>`).join("") || `<div class="hint">Todavía no hay avisos. Se crean solos al publicar avances, modelos o planos.</div>`}`;
    html += `<h4>Usuarios del proyecto (${mem.members.length})</h4>
      <div class="it"><span>Quién puede entrar</span><select id="mg-access"><option value="0">Cualquiera con el link</option><option value="1">Solo los usuarios agregados</option></select></div>
      ${mem.members.map((u) => `<div class="it"><span title="${esc(u.email)}">${esc(u.email)}</span><span class="tiny">${u.last_seen ? "entró " + fdate(u.last_seen) : "aún no entra"}</span>
        <select data-role="${esc(u.email)}"><option value="visor"${u.role === "visor" ? " selected" : ""}>Visor</option><option value="editor"${u.role === "editor" ? " selected" : ""}>Editor</option></select>
        <button class="btn sm danger" data-delu="${esc(u.email)}">Quitar</button></div>`).join("") || `<div class="hint">Aún no has agregado usuarios.</div>`}
      <div class="up"><input type="text" id="mg-emails" placeholder="correo@empresa.com, otro@gmail.com" style="flex:1;min-width:200px">
        <select id="mg-role"><option value="visor">Visor</option><option value="editor">Editor</option></select>
        <button class="btn primary" id="mg-add">Agregar</button></div>
      <div class="hint" style="margin-top:4px"><b>Visor</b>: ve modelos y planos y adjunta fichas técnicas. <b>Editor</b>: además sube modelos y planos. Deben entrar con la cuenta de Google de ese correo.</div>
      <div class="msg" id="mg-mem-msg"></div>`;
  }
  html += `</div>`;
  ctx.body.innerHTML = html;
  if (!ctx.dlg.open) ctx.dlg.showModal();
  const again = () => { manage(slug, share, admin, ctx); ctx.onChange(); };

  async function uploadAll(inputId, msgId, btnId, each) {
    const files = [...$(inputId).files], msg = $(msgId);
    if (!files.length) { msg.textContent = "Elige uno o más archivos."; return; }
    $(btnId).disabled = true;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i], tag = `(${i + 1}/${files.length}) ${f.name}`;
        msg.textContent = `Subiendo ${tag}… 0%`;
        await each(f, (frac) => (msg.textContent = `Subiendo ${tag}… ${Math.round(frac * 100)}%`));
      }
      ctx.toast(`${files.length} archivo(s) publicados`); again();
    } catch (e) { msg.textContent = "Error: " + e.message; msg.style.color = "var(--danger)"; $(btnId).disabled = false; }
  }
  $("mg-ifc-btn").onclick = () => uploadAll("mg-ifc", "mg-ifc-msg", "mg-ifc-btn", async (f, prog) => {
    const name = f.name.replace(/\.ifc$/i, ""), id = slugify(name), key = `${slug}/modelos/${id}.ifc`;
    await uploadFile(slug, key, f, "application/octet-stream", prog);
    await api(`${base}/models`, { method: "POST", json: { id, name, file_key: key, size: f.size } });
  });
  $("mg-pdf-btn").onclick = () => uploadAll("mg-pdf", "mg-pdf-msg", "mg-pdf-btn", async (f, prog) => {
    const full = f.name.replace(/\.pdf$/i, "").trim(), mm = full.match(/^(\S+)\s+(.+)$/);
    const grupo = $("mg-grupo").value.trim() || (p.models[0] && p.models[0].name) || "General";
    const number = mm ? mm[1] : full, name = mm ? mm[2] : full, key = `${slug}/planos/${slugify(grupo)}/${slugify(full)}.pdf`;
    await uploadFile(slug, key, f, "application/pdf", prog);
    await api(`${base}/planos`, { method: "POST", json: { grupo, number, name, file_key: key } });
  });

  const act = (sel, fn) => ctx.body.querySelectorAll(sel).forEach((b) => b[b.tagName === "SELECT" ? "onchange" : "onclick"] = async () => {
    try { if (await fn(b) !== false) again(); } catch (e) { alert(e.message); }
  });
  act("[data-delm]", (b) => confirm(`¿Borrar el modelo "${b.dataset.delm}"?`) ? api(`${base}/models/${b.dataset.delm}`, { method: "DELETE" }) : false);
  $("mg-av-btn").onclick = async () => {
    const msg = $("mg-av-msg"), raw = $("mg-pct").value.trim().replace(",", ".");
    const pct = Number(raw);
    if (!raw || !Number.isFinite(pct) || pct < 0 || pct > 100) { msg.textContent = "Escribe el avance como un número entre 0 y 100."; msg.style.color = "var(--danger)"; return; }
    $("mg-av-btn").disabled = true;
    try {
      const r = await api(`${base}/avances`, { method: "POST", json: { pct, etapa: $("mg-etapa").value, comentario: $("mg-com").value, push: $("mg-push") ? $("mg-push").checked : true } });
      ctx.toast(`Avance ${pct} % (${r.etapa}) publicado y notificado`); again();
    } catch (e) { msg.textContent = "Error: " + e.message; msg.style.color = "var(--danger)"; $("mg-av-btn").disabled = false; }
  };
  act("[data-delav]", (b) => confirm("¿Borrar este avance y su aviso?") ? api(`${base}/avances/${b.dataset.delav}`, { method: "DELETE" }) : false);
  act("[data-delp]", (b) => confirm(`¿Borrar el plano ${b.dataset.delp}?`) ? api(`${base}/planos/${encodeURIComponent(b.dataset.delp)}?grupo=${encodeURIComponent(b.dataset.grupo)}`, { method: "DELETE" }) : false);
  if (!admin) return;

  $("mg-nt-btn").onclick = async () => {
    const msg = $("mg-nt-msg"), titulo = $("mg-nt-t").value.trim(), cuerpo = $("mg-nt-c").value.trim();
    if (!titulo || !cuerpo) { msg.textContent = "Escribe título y mensaje."; msg.style.color = "var(--danger)"; return; }
    try { await api(`${base}/notificaciones`, { method: "POST", json: { titulo, cuerpo } }); ctx.toast("Aviso enviado"); again(); }
    catch (e) { msg.textContent = "Error: " + e.message; msg.style.color = "var(--danger)"; }
  };
  act("[data-delnt]", (b) => confirm("¿Quitar este aviso? Deja de verse en la campana.") ? api(`${base}/notificaciones/${b.dataset.delnt}`, { method: "DELETE" }) : false);

  $("mg-access").value = mem.restricted ? "1" : "0";
  $("mg-access").onchange = async () => {
    const r = $("mg-access").value === "1";
    if (r && !mem.members.length && !confirm("Aún no has agregado usuarios: solo los administradores podrán entrar. ¿Continuar?")) { $("mg-access").value = "0"; return; }
    try {
      await api(base, { method: "PATCH", json: { restricted: r } });
      ctx.toast(r ? "Ahora solo entran los usuarios agregados" : "Ahora entra cualquiera con el link"); again();
    } catch (e) { alert(e.message); }
  };
  act("[data-delu]", (b) => confirm(`¿Quitar a ${b.dataset.delu} del proyecto?`) ? api(`${base}/members?email=${encodeURIComponent(b.dataset.delu)}`, { method: "DELETE" }) : false);
  act("[data-role]", (b) => api(`${base}/members`, { method: "POST", json: { emails: [b.dataset.role], role: b.value } }));
  $("mg-add").onclick = async () => {
    const emails = $("mg-emails").value.split(/[\s,;]+/).filter(Boolean);
    try { await api(`${base}/members`, { method: "POST", json: { emails, role: $("mg-role").value } }); ctx.toast("Usuario(s) agregados"); again(); }
    catch (e) { $("mg-mem-msg").textContent = "Error: " + e.message; $("mg-mem-msg").style.color = "var(--danger)"; }
  };
}
