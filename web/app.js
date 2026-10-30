// @ts-check
// La página: dibuja el mapa de barrios, los pinta según los cortes del día elegido y arma el panel lateral.
// La lógica de "qué barrio tiene qué corte" está en estado.js (con tests); acá solo se muestra.

import {
  cortesDelDia, diasDisponibles, estadoPorBarrio, etiquetaDia, fechaLarga, historialDelBarrio, momentoEnCordoba,
} from './estado.js';

/** @typedef {import('./estado.js').Corte} Corte */
/** @typedef {import('./estado.js').EstadoBarrio} EstadoBarrio */
/** @typedef {{ id: string, nombre: string | null, tipo: 'poligono' | 'punto', fuente: string }} Barrio */
/** @typedef {GeoJSON.Feature<GeoJSON.Geometry, Barrio>} FeatureBarrio */

const CORDOBA = /** @type {L.LatLngTuple} */ ([-31.4167, -64.1833]);
const RECLAMO_EPEC = 'https://www.epec.com.ar/tramites/reclamo-tecnico';

const panel = /** @type {HTMLElement} */ (document.getElementById('panel'));
const selectorDia = /** @type {HTMLSelectElement} */ (document.getElementById('dia'));
const buscador = /** @type {HTMLInputElement} */ (document.getElementById('buscar'));

/**
 * Crea un elemento del DOM. Todo el texto entra como texto (nunca como HTML), así nada que venga
 * de las notas puede inyectar código en la página.
 * @param {string} etiqueta
 * @param {Record<string, string | ((e: Event) => void)>} [atributos]
 * @param {...(Node | string | null | false)} hijos
 */
function h(etiqueta, atributos = {}, ...hijos) {
  const el = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) {
    if (typeof valor === 'function') el.addEventListener(clave.replace(/^on/, ''), valor);
    else el.setAttribute(clave, valor);
  }
  for (const hijo of hijos) if (hijo) el.append(hijo);
  return el;
}

/** @param {string} url */
async function pedir(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

/** Para buscar sin importar tildes ni mayúsculas. @param {string} texto */
function simplificar(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** @param {Corte} corte */
const horario = (corte) => `${corte.desde} a ${corte.hasta}`;

// ---------------------------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------------------------

/** @type {[GeoJSON.FeatureCollection<GeoJSON.Geometry, Barrio>, Corte[]]} */
let datos;
try {
  datos = await Promise.all([pedir('data/barrios.geojson'), pedir('data/mantenimientos.json')]);
} catch (error) {
  panel.replaceChildren(h('p', { class: 'error' }, 'No se pudieron cargar los datos. Probá recargar la página.'));
  throw error;
}
const [mapaBarrios, cortes] = datos;
const primerRegistro = cortes.map((c) => c.fecha).sort()[0];

let ahora = momentoEnCordoba();
let diaElegido = ahora.fecha;
/** @type {Map<string, EstadoBarrio>} */
let estados = new Map();
/** @type {string | null} */
let barrioElegido = null;

// ---------------------------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------------------------

const mapa = L.map('mapa', { preferCanvas: true }).setView(CORDOBA, window.innerWidth > 760 ? 12 : 11);
// Mapa de fondo de OpenStreetMap: gratis, sin clave, pidiendo solo la atribución. Lo apagamos un poco con CSS
// (clase "fondo-suave") para que resalten los colores de los barrios.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
  className: 'fondo-suave',
}).addTo(mapa);

/** @param {string | null} nombre */
function estilo(nombre) {
  const estado = nombre ? estados.get(nombre) : undefined;
  const elegido = nombre !== null && nombre === barrioElegido;
  if (!estado) {
    return { color: elegido ? '#1d4ed8' : '#94a3b8', weight: elegido ? 3 : 0.6, fillColor: '#cbd5e1', fillOpacity: elegido ? 0.25 : 0.08 };
  }
  return {
    color: elegido ? '#1d4ed8' : estado.enCurso ? '#b45309' : '#a16207',
    weight: elegido ? 3 : estado.enCurso ? 2.5 : 1,
    fillColor: estado.total ? '#f59e0b' : '#facc15',
    fillOpacity: estado.enCurso ? 0.8 : 0.55,
  };
}

/** @type {Map<string, L.Path[]>} capas de cada barrio, para pintarlas o enfocarlas por nombre */
const capasPorNombre = new Map();

const capaPoligonos = L.geoJSON(
  /** @type {GeoJSON.FeatureCollection<GeoJSON.Geometry, Barrio>} */ ({
    type: 'FeatureCollection',
    features: mapaBarrios.features.filter((f) => f.properties.tipo === 'poligono'),
  }),
  {
    style: (f) => estilo(f?.properties.nombre ?? null),
    onEachFeature: (f, capa) => {
      const nombre = /** @type {Barrio} */ (f.properties).nombre;
      if (!nombre) return;
      capasPorNombre.set(nombre, [...(capasPorNombre.get(nombre) ?? []), /** @type {L.Path} */ (capa)]);
      capa.bindTooltip(nombre, { sticky: true });
      capa.on('click', () => elegirBarrio(nombre));
    },
  },
).addTo(mapa);

// Los barrios que solo tenemos como punto se muestran únicamente si tienen un corte ese día.
const puntos = new Map(
  mapaBarrios.features
    .filter((f) => f.properties.tipo === 'punto' && f.properties.nombre)
    .map((f) => [/** @type {string} */ (f.properties.nombre), /** @type {GeoJSON.Point} */ (f.geometry).coordinates]),
);
const capaPuntos = L.layerGroup().addTo(mapa);

function pintarMapa() {
  capaPoligonos.setStyle((f) => estilo(f?.properties.nombre ?? null));
  capaPuntos.clearLayers();
  for (const nombre of estados.keys()) {
    const coordenadas = puntos.get(nombre);
    if (!coordenadas) continue;
    const circulo = L.circleMarker([coordenadas[1], coordenadas[0]], { radius: 10, ...estilo(nombre) })
      .bindTooltip(nombre)
      .on('click', () => elegirBarrio(nombre))
      .addTo(capaPuntos);
    capasPorNombre.set(nombre, [circulo]);
  }
}

const leyenda = new L.Control({ position: 'bottomleft' });
leyenda.onAdd = () =>
  h('div', { class: 'leyenda' },
    h('div', {}, h('span', { style: 'background:#facc15' }), 'Corte programado'),
    h('div', {}, h('span', { style: 'background:#f59e0b' }), 'Corte total'),
    h('div', {}, h('span', { style: 'background:#facc15;border:2px solid #b45309' }), 'En curso ahora'),
    h('div', {}, h('span', { style: 'background:#eef2f6' }), 'Sin cortes anunciados'),
  );
leyenda.addTo(mapa);

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

/** Reemplaza el contenido del panel, salteando las partes opcionales que no corresponden (false/null). @param {...(Node | string | null | false)} partes */
function mostrar(...partes) {
  panel.replaceChildren(...partes.filter((p) => p !== false && p !== null));
}

/** @param {Corte} corte @param {{ conBarrios?: boolean }} [opciones] */
function tarjetaCorte(corte, { conBarrios = true } = {}) {
  const enCurso = corte.fecha === ahora.fecha && corte.desde <= ahora.hora && ahora.hora < corte.hasta;
  const clases = ['corte', corte.afectacion === 'total' && 'total', enCurso && 'en-curso'].filter(Boolean).join(' ');
  return h('li', { class: clases },
    h('div', { class: 'horario' },
      horario(corte),
      enCurso && h('span', { class: 'etiqueta en-curso' }, 'En curso'),
      corte.afectacion && h('span', { class: `etiqueta ${corte.afectacion}` }, corte.afectacion === 'total' ? 'Total' : 'Parcial'),
    ),
    conBarrios && corte.barrios.length > 0 &&
      h('div', { class: 'barrios' },
        ...corte.barrios.map((b) => h('button', { class: 'barrio-link', type: 'button', onclick: () => elegirBarrio(b) }, b))),
    h('p', { class: 'zona' }, corte.zona),
    corte.barrios.length === 0 && h('p', { class: 'sin-mapa' }, 'No se pudo marcar en el mapa: la zona está descripta por calles.'),
    h('a', { class: 'fuente', href: corte.fuente, target: '_blank', rel: 'noopener' }, 'Ver anuncio original'),
  );
}

function mostrarResumen() {
  const delDia = cortesDelDia(cortes, diaElegido);
  mostrar(
    h('h2', {}, etiquetaDia(diaElegido, ahora.fecha)),
    h('p', { class: 'resumen' },
      delDia.length === 0
        ? 'No hay cortes programados anunciados para este día.'
        : `${delDia.length} ${delDia.length === 1 ? 'corte programado' : 'cortes programados'} en Córdoba capital.`),
    delDia.length === 0 && diaElegido > ahora.fecha &&
      h('p', { class: 'aviso' }, 'Los cortes se suelen anunciar el día anterior: volvé a mirar más tarde.'),
    delDia.length > 0 && h('ul', { class: 'cortes' }, ...delDia.map((c) => tarjetaCorte(c))),
    avisoReclamo(),
  );
}

/** @param {string} nombre */
function mostrarBarrio(nombre) {
  const delDia = estados.get(nombre)?.cortes ?? [];
  const { ultimo, proximo } = historialDelBarrio(cortes, nombre, ahora);
  /** @param {Corte | null} c */
  const describir = (c) => (c ? `${fechaLarga(c.fecha)}, de ${horario(c)}` : 'Sin registros');
  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(null) }, '← Ver todos los cortes'),
    h('h2', {}, nombre),
    h('p', { class: 'resumen' },
      delDia.length === 0
        ? `Sin cortes anunciados para el ${fechaLarga(diaElegido)}.`
        : `Cortes del ${fechaLarga(diaElegido)}:`),
    delDia.length > 0 && h('ul', { class: 'cortes' }, ...delDia.map((c) => tarjetaCorte(c, { conBarrios: false }))),
    h('h3', {}, 'Historial'),
    h('dl', { class: 'historial' },
      h('dt', {}, 'Próximo corte'), h('dd', {}, describir(proximo)),
      h('dt', {}, 'Último corte'), h('dd', {}, describir(ultimo)),
    ),
    h('p', { class: 'aviso' }, `Registramos cortes desde el ${fechaLarga(primerRegistro)}.`),
    avisoReclamo(),
  );
}

function avisoReclamo() {
  return h('p', { class: 'aviso' },
    '¿No tenés luz y no figura acá? Puede ser un corte no programado. Reclamá a EPEC desde ',
    h('a', { href: RECLAMO_EPEC, target: '_blank', rel: 'noopener' }, 'su formulario'),
    ' o al 0800 777 0000.',
  );
}

// ---------------------------------------------------------------------------------------------
// Interacción
// ---------------------------------------------------------------------------------------------

/** @param {string | null} nombre */
function elegirBarrio(nombre) {
  barrioElegido = nombre;
  pintarMapa();
  if (!nombre) {
    mostrarResumen();
    return;
  }
  const capas = capasPorNombre.get(nombre) ?? [];
  if (capas.length > 0) {
    const limites = L.featureGroup(capas).getBounds();
    mapa.fitBounds(limites, { maxZoom: 15, padding: [24, 24] });
  }
  mostrarBarrio(nombre);
}

function actualizar() {
  ahora = momentoEnCordoba();
  estados = estadoPorBarrio(cortes, diaElegido, ahora);
  pintarMapa();
  if (barrioElegido) mostrarBarrio(barrioElegido);
  else mostrarResumen();
}

selectorDia.replaceChildren(
  ...diasDisponibles(cortes, ahora.fecha).map((dia) => h('option', { value: dia }, etiquetaDia(dia, ahora.fecha))),
);
selectorDia.value = diaElegido;
selectorDia.addEventListener('change', () => {
  diaElegido = selectorDia.value;
  actualizar();
});

const nombres = [...new Set(mapaBarrios.features.flatMap((f) => f.properties.nombre ?? []))].sort((a, b) => a.localeCompare(b, 'es'));
document.getElementById('lista-barrios')?.replaceChildren(...nombres.map((n) => h('option', { value: n })));

/** @param {Event} evento */
function buscar(evento) {
  evento.preventDefault();
  const buscado = simplificar(buscador.value);
  if (!buscado) return;
  const encontrado = nombres.find((n) => simplificar(n) === buscado) ?? nombres.find((n) => simplificar(n).includes(buscado));
  if (encontrado) {
    buscador.value = encontrado;
    elegirBarrio(encontrado);
  } else {
    panel.replaceChildren(h('p', { class: 'error' }, `No encontré "${buscador.value}". Probá con otro nombre.`));
  }
}
document.getElementById('form-buscar')?.addEventListener('submit', buscar);
buscador.addEventListener('change', buscar);

actualizar();
// Cada minuto, para que "En curso" se prenda y se apague a tiempo.
setInterval(actualizar, 60_000);
