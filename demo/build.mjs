// Arma la demo estática para GitHub Pages en _site/ a partir de worker/public (una sola fuente).
//   node demo/build.mjs
// · Copia la página, los textos de venta (worker/src/ventas.js) y los archivos de ejemplo.
// · Inyecta demo.js (API simulada en el navegador) y vuelve relativas las rutas absolutas,
//   porque Pages sirve el sitio en /<repo>/ y no en la raíz.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "_site");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, "worker/public"), OUT, { recursive: true });
cpSync(join(ROOT, "worker/src/ventas.js"), join(OUT, "js/ventas.js"));
cpSync(join(ROOT, "demo/demo.js"), join(OUT, "js/demo.js"));
cpSync(join(ROOT, "demo/files"), join(OUT, "demo/files"), { recursive: true });
rmSync(join(OUT, "firebase-messaging-sw.js"), { force: true }); // sin push en la demo
writeFileSync(join(OUT, ".nojekyll"), "");

// Reemplazos exactos: si el código cambia y un patrón ya no aparece, el build falla en vez de publicar algo roto.
function patch(file, pairs) {
  const p = join(OUT, file);
  let s = readFileSync(p, "utf8");
  for (const [from, to, min = 1] of pairs) {
    const n = s.split(from).length - 1;
    if (n < min) throw new Error(`${file}: no se encontró ${JSON.stringify(from)} (${n}/${min})`);
    s = s.split(from).join(to);
  }
  writeFileSync(p, s);
}

const html = [
  ['href="/css/', 'href="./css/'],
  ['from "/js/', 'from "./js/'],
  ['href="/"', 'href="./"', 0],
];
patch("index.html", [...html,
  ['href="/p/${', 'href="./visor.html?p=${', 3],
  ['location.origin + "/p/" + share', 'new URL("visor.html?p=" + share, location.href).href'],
  ["<title>BIM Hub · Life City</title>", "<title>BIM Hub · Demo de notificaciones</title>"],
  ["<main>", `<main>
    <section class="box" style="border-color:var(--warn)">
      <h2 style="margin-bottom:6px">Demo: avisos de avance de obra que venden la página de ventas</h2>
      <ol class="hint" style="padding-left:18px;line-height:1.75;font-size:13px">
        <li>Abre el visor de <b>Torre Mirador</b>: aparece el aviso del último avance y la campana guarda los anteriores.</li>
        <li>Haz clic en <b>Ver cómo vender más</b>: así se ofrece la página de ventas que responde automáticamente (+391 %).</li>
        <li>Abajo a la izquierda cambia a <b>Administrador</b>, entra a <b>Gestionar</b> y publica un avance, por ejemplo 85 %.</li>
        <li>Vuelve a <b>Promotor</b> y abre el visor: el aviso nuevo llega con el argumento de venta de su etapa.</li>
      </ol>
      <p class="hint" style="margin-top:6px">Los datos de la demo viven solo en tu navegador. El formulario de la página de ventas sí envía tu solicitud al equipo de Life City.</p>
    </section>`],
]);
patch("visor.html", [...html, ["<title>Visor 3D · BIM Hub</title>", "<title>Visor 3D · Demo BIM Hub</title>"]]);
patch("js/auth.js", [
  ['import { initializeApp }', 'import "./demo.js";\nimport { initializeApp }'],
  ["const dev = devEmail();", "const dev = window.__DEMO_USER || devEmail();"],
  ['location.href = "/";', 'location.href = "./";'],
]);
patch("js/notif.js", [
  ['from "/js/auth.js"', 'from "./auth.js"'],
  ["`/p/${n.share_id}?notif=${n.id}`", "`./visor.html?p=${n.share_id}&notif=${n.id}`"],
  ["origen: `Visor BIM · notificación", "origen: `Demo visor BIM · notificación"],
]);
patch("js/manage.js", [
  ['from "/js/auth.js"', 'from "./auth.js"'],
  ["Push del navegador sin configurar: los avisos salen en la campana del visor. Ver README → Notificaciones.",
   "En la demo no hay push del navegador: los avisos salen en la campana del visor. En producción también llegan como notificación push."],
  ["${esc(location.origin)}/p/${esc(p.share_id)}", "${esc(new URL(\"visor.html?p=\" + p.share_id, location.href).href)}"],
]);
console.log("Demo lista en", OUT);
