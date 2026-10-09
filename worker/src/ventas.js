// Textos de las notificaciones: cada avance de obra se convierte en un argumento para vender
// la PÁGINA DE VENTAS del proyecto, que responde automáticamente a los interesados.
//
// Idea central: quien responde primero vende. Contestar en el primer minuto aumenta hasta 391 %
// la probabilidad de convertir a un interesado en comprador, y la página lo hace sola, 24/7.

export const ETAPAS = ["Preventa", "Cimentación", "Estructura", "Mampostería", "Acabados", "Entrega"];

// Etapa sugerida para un porcentaje (si quien publica no elige una).
export function etapaPorPct(pct) {
  if (pct < 5) return "Preventa";
  if (pct < 20) return "Cimentación";
  if (pct < 50) return "Estructura";
  if (pct < 75) return "Mampostería";
  if (pct < 97) return "Acabados";
  return "Entrega";
}

export function normEtapa(e, pct) {
  const s = String(e || "").trim().toLowerCase();
  const hit = ETAPAS.find((x) => x.toLowerCase() === s || x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") === s);
  return hit || etapaPorPct(pct);
}

// Cierre para mensajes sueltos (la ventana de venta ya muestra el +391 % aparte).
export const CIERRE = "La página de ventas responde en segundos, de día y de noche: responder en el primer minuto aumenta hasta 391 % la probabilidad de venta, y el comprador suele quedarse con quien le contesta primero.";

// Por etapa: el momento comercial y quién está buscando en ese momento.
const MOMENTO = {
  Preventa: {
    gancho: "Arranca la preventa",
    texto: "Los primeros compradores e inversionistas buscan precio de lanzamiento. Son los que más preguntan y los que más rápido se van con otro proyecto si nadie les contesta.",
  },
  Cimentación: {
    gancho: "Ya hay obra en el lote",
    texto: "Con maquinaria en sitio sube la confianza: llegan consultas de quienes esperaban ver la obra empezar para separar su apartamento.",
  },
  Estructura: {
    gancho: "La estructura ya se ve desde la calle",
    texto: "Es el pico de consultas: el proyecto se vuelve real y los inversionistas buscan comprar antes de que suba el precio por avance de obra.",
  },
  Mampostería: {
    gancho: "Los apartamentos ya tienen forma",
    texto: "Los compradores pueden imaginar su espacio y piden visitas, planos y formas de pago. Cada consulta sin respuesta es una unidad que se vende en otro proyecto.",
  },
  Acabados: {
    gancho: "Recta final: acabados",
    texto: "Llegan compradores para vivir que necesitan respuesta inmediata sobre disponibilidad, crédito y fecha de entrega. Quedan menos unidades y cada una cuenta.",
  },
  Entrega: {
    gancho: "Proyecto listo para entregar",
    texto: "El inventario que queda tiene costo de sostenimiento cada día. Responder al instante a cada interesado es la forma más rápida de cerrar las últimas unidades.",
  },
};

const pctTxt = (n) => (Math.round(Number(n) * 10) / 10).toLocaleString("es-CO") + " %";

/** Notificación para un avance de obra. */
export function textoAvance(proyecto, pct, etapa, comentario) {
  const m = MOMENTO[etapa] || MOMENTO[etapaPorPct(pct)];
  return {
    tipo: "avance",
    titulo: `${proyecto}: avance ${pctTxt(pct)} · ${etapa}`,
    cuerpo: (comentario ? comentario.trim().replace(/([^.!?…])$/, "$1.") + " " : "") + `${m.gancho}.`,
    pitch: m.texto,
  };
}

/** Notificación cuando se publica un modelo 3D. */
export function textoModelo(proyecto, modelo) {
  return {
    tipo: "modelo",
    titulo: `${proyecto}: nuevo modelo 3D`,
    cuerpo: `Se publicó "${modelo}". Ya puedes recorrerlo en el visor.`,
    pitch: `Un modelo 3D actualizado es el mejor material para vender: la página de ventas lo muestra a cada interesado apenas pregunta, sin esperar a un asesor.`,
  };
}

/** Notificación cuando se publican planos (se agrupan los de los últimos 30 minutos). */
export function textoPlanos(proyecto, n) {
  return {
    tipo: "planos",
    titulo: `${proyecto}: ${n} plano${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"}`,
    cuerpo: `Se ${n === 1 ? "publicó 1 plano" : `publicaron ${n} planos`} del proyecto.`,
    pitch: `Los compradores piden planos antes de separar. La página de ventas los entrega al instante con la información de cada unidad.`,
  };
}
