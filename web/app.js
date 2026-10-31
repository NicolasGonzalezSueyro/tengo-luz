// @ts-check
// La página: dibuja el mapa de barrios, los pinta según los cortes del día elegido y arma el panel.
// La lógica de "qué barrio tiene qué corte" está en estado.js (con tests); acá solo se muestra.

import {
  barrioEnPunto, cortesDelDia, diasDisponibles, estadoPorBarrio, estaEnCurso, etiquetaCorta, etiquetaDia, fechaLarga,
  hace, historialDelBarrio, lugaresDelCorte, momentoEnCordoba, posicionCoincidencia, sugerencias, textoParaCompartir,
} from './estado.js';
import { linkGoogleCalendar } from './calendario.js';
import { h } from './dom.js';
import { completarIconos, icono } from './iconos.js';
import { DESDE, linkWhatsApp, PROBLEMAS, textoDelReclamo } from './reclamo.js';

/** @typedef {import('./estado.js').Corte} Corte */
/** @typedef {import('./reclamo.js').DatosReclamo} DatosReclamo */
/** @typedef {import('./estado.js').EstadoBarrio} EstadoBarrio */
/** @typedef {{ id: string, nombre: string | null, tipo: 'poligono' | 'punto', fuente: string }} Barrio */
/** @typedef {GeoJSON.Feature<GeoJSON.Geometry, Barrio>} FeatureBarrio */
/** @typedef {{ nombre: string, descripcion: string, tipo?: 'ruta' | 'localidad' }} Zona */
/** @typedef {import('./dom.js').Hijo} Hijo */

const CORDOBA = /** @type {L.LatLngTuple} */ ([-31.4167, -64.1833]);
const RECLAMO_EPEC = 'https://www.epec.com.ar/tramites/reclamo-tecnico';
const WHATSAPP_EPEC = '5493512004343';
const ES_CELULAR = window.matchMedia('(max-width: 860px)');

// Colores de los barrios en el mapa, según el tema. El resto de los colores está en estilos.css.
const PALETAS = {
  claro: {
    borde: '#8e8aa8', relleno: '#a5a1c2', rellenoOp: 0.07, luz: '#facc15', bordeLuz: '#b45309', bordeTotal: '#7c2d12',
    enCurso: '#f97316', bordeEnCurso: '#c2410c', sinLuz: '#dc2626', bordeSinLuz: '#7f1d1d', zona: '#92400e', elegido: '#6d28d9',
  },
  oscuro: {
    borde: '#3a4468', relleno: '#334066', rellenoOp: 0.14, luz: '#fde047', bordeLuz: '#facc15', bordeTotal: '#fef08a',
    enCurso: '#fb923c', bordeEnCurso: '#fdba74', sinLuz: '#ef4444', bordeSinLuz: '#fecaca', zona: '#d6a46b', elegido: '#c4b5fd',
  },
};

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const panel = $('panel');
const contenido = $('panel-contenido');
const asa = $('asa');
const dias = $('dias');
const buscador = /** @type {HTMLInputElement} */ ($('buscar'));
const botonTema = $('tema');
const botonUbicacion = $('ubicacion');
const avisoFlotante = $('aviso-flotante');

completarIconos();

/** @param {string} url */
async function pedir(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

/** @param {Corte} corte */
const horario = (corte) => `${corte.desde} a ${corte.hasta}`;

let temporizadorAviso = 0;
/** Muestra un mensaje corto arriba del mapa durante unos segundos. @param {string} texto */
function avisar(texto) {
  avisoFlotante.textContent = texto;
  avisoFlotante.classList.add('visible');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = window.setTimeout(() => avisoFlotante.classList.remove('visible'), 5000);
}

// ---------------------------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------------------------

/** @type {[GeoJSON.FeatureCollection<GeoJSON.Geometry, Barrio>, Corte[], GeoJSON.FeatureCollection<GeoJSON.Polygon, Zona>]} */
let datos;
try {
  datos = await Promise.all([pedir('data/barrios.geojson'), pedir('data/mantenimientos.json'), pedir('data/zonas.geojson')]);
} catch (error) {
  contenido.replaceChildren(h('p', { class: 'error' }, 'No se pudieron cargar los datos. Probá recargar la página.'));
  throw error;
}
const [mapaBarrios, cortes, mapaZonas] = datos;
const zonasPorNombre = new Map(mapaZonas.features.map((f) => [f.properties.nombre, f]));
const poligonosBarrios = mapaBarrios.features.filter((f) => f.properties.tipo === 'poligono');
// Las localidades de Gran Córdoba (Villa Allende, Carlos Paz…): sirven también para ubicar el GPS fuera de capital.
const limitesLocalidades = mapaZonas.features.filter((f) => f.properties.tipo === 'localidad');
const primerRegistro = cortes.map((c) => c.fecha).sort()[0];
// Todo lo que se puede elegir en el mapa. Los reportes con otros nombres se ignoran.
const lugaresDelMapa = new Set([...mapaBarrios.features.flatMap((f) => f.properties.nombre ?? []), ...zonasPorNombre.keys()]);

let ahora = momentoEnCordoba();
let diaElegido = ahora.fecha;
/** @type {Map<string, EstadoBarrio>} */
let estados = new Map();
/** @type {string | null} */
let barrioElegido = null;
/** Reportes de vecinos de las últimas 3 horas, por barrio (vienen de /api/reportes). @type {Record<string, { cantidad: number, ultimo: number }>} */
let reportes = {};
/** Si el panel muestra un formulario o una explicación, no se redibuja cada minuto (se perdería lo escrito). */
let panelFijo = false;
/** Barrios que reportaste desde esta pestaña, para no mostrarte el botón de nuevo. */
const reportadosPorMi = new Set();

/** Cuántos vecinos dicen que no tienen luz. Son reportes de "ahora", así que solo cuentan mirando el día de hoy. @param {string | null} nombre */
function vecinosSinLuz(nombre) {
  if (!nombre || diaElegido !== ahora.fecha || !lugaresDelMapa.has(nombre)) return 0;
  return reportes[nombre]?.cantidad ?? 0;
}

/** Los barrios con reportes, de más a menos. */
const barriosReportados = () => Object.keys(reportes).filter((n) => vecinosSinLuz(n) > 0).sort((a, b) => vecinosSinLuz(b) - vecinosSinLuz(a));

// ---------------------------------------------------------------------------------------------
// Tema claro / oscuro
// ---------------------------------------------------------------------------------------------

const prefiereOscuro = window.matchMedia('(prefers-color-scheme: dark)');

/** @returns {'claro' | 'oscuro'} */
function temaActual() {
  const elegido = document.documentElement.dataset.tema;
  if (elegido === 'claro' || elegido === 'oscuro') return elegido;
  return prefiereOscuro.matches ? 'oscuro' : 'claro';
}

function aplicarTema() {
  const oscuro = temaActual() === 'oscuro';
  botonTema.replaceChildren(icono(oscuro ? 'sol' : 'luna'));
  botonTema.setAttribute('aria-label', oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  $('texto-tema').textContent = oscuro ? 'Modo claro' : 'Modo oscuro';
  pintarMapa();
}

function cambiarTema() {
  const nuevo = temaActual() === 'oscuro' ? 'claro' : 'oscuro';
  document.documentElement.dataset.tema = nuevo;
  try {
    localStorage.setItem('tema', nuevo);
  } catch {
    // Sin almacenamiento (modo privado): el tema dura hasta recargar, no pasa nada.
  }
  aplicarTema();
}
botonTema.addEventListener('click', cambiarTema);
prefiereOscuro.addEventListener('change', aplicarTema);

// ---------------------------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------------------------

const mapa = L.map('mapa', { zoomControl: false }).setView(CORDOBA, ES_CELULAR.matches ? 11 : 12);
L.control.zoom({ position: 'topright' }).addTo(mapa);
// Mapa de fondo de OpenStreetMap: gratis, sin clave, pidiendo solo la atribución. Con CSS lo apagamos
// (tema claro) o lo invertimos (tema oscuro) para que resalten los barrios.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
  className: 'fondo-mapa',
}).addTo(mapa);

/**
 * Leaflet interpreta como HTML el texto de los carteles (tooltips). Los nombres vienen de OpenStreetMap,
 * que cualquiera puede editar, así que los pasamos como texto: un nombre con código no se ejecuta.
 * @param {string} texto
 */
const comoTexto = (texto) => h('span', {}, texto);

/** El ícono de un lugar: un pin para los barrios, una ruta o un edificio para las zonas aproximadas. @param {string} nombre */
function iconoDeLugar(nombre) {
  const tipo = zonasPorNombre.get(nombre)?.properties.tipo;
  return icono(!zonasPorNombre.has(nombre) ? 'pin' : tipo === 'localidad' ? 'ciudad' : 'ruta');
}

/** @param {string | null} nombre */
function estilo(nombre) {
  const p = PALETAS[temaActual()];
  const estado = nombre ? estados.get(nombre) : undefined;
  const elegido = nombre !== null && nombre === barrioElegido;
  // Rojo: los vecinos dicen que no tienen luz y no hay un corte anunciado en curso que lo explique.
  if (vecinosSinLuz(nombre) > 0 && !estado?.enCurso) {
    return { color: elegido ? p.elegido : p.bordeSinLuz, weight: elegido ? 3.5 : 2, fillColor: p.sinLuz, fillOpacity: 0.6 };
  }
  if (!estado) {
    return { color: elegido ? p.elegido : p.borde, weight: elegido ? 3.5 : 0.7, fillColor: p.relleno, fillOpacity: elegido ? 0.25 : p.rellenoOp };
  }
  return {
    color: elegido ? p.elegido : estado.enCurso ? p.bordeEnCurso : estado.total ? p.bordeTotal : p.bordeLuz,
    weight: elegido ? 3.5 : estado.total ? 2.5 : 1.3,
    fillColor: estado.enCurso ? p.enCurso : p.luz,
    fillOpacity: 0.6,
  };
}

/** Las zonas aproximadas: contorno marrón punteado, relleno según el estado del corte. @param {string} nombre */
function estiloZona(nombre) {
  const p = PALETAS[temaActual()];
  return { ...estilo(nombre), color: nombre === barrioElegido ? p.elegido : p.zona, weight: 2.5, dashArray: '7 6', fillOpacity: 0.35 };
}

/** @type {Map<string, L.Layer[]>} capas de cada barrio o zona, para enfocarlas por nombre */
const capasPorNombre = new Map();

const capaPoligonos = L.geoJSON(
  /** @type {GeoJSON.FeatureCollection<GeoJSON.Geometry, Barrio>} */ ({ type: 'FeatureCollection', features: poligonosBarrios }),
  {
    style: (f) => estilo(f?.properties.nombre ?? null),
    onEachFeature: (f, capa) => {
      const nombre = /** @type {Barrio} */ (f.properties).nombre;
      if (!nombre) return;
      capasPorNombre.set(nombre, [...(capasPorNombre.get(nombre) ?? []), /** @type {L.Path} */ (capa)]);
      capa.bindTooltip(comoTexto(nombre), { sticky: true });
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
// Las zonas aproximadas (rutas rurales) también se dibujan solo el día que tienen un corte.
const capaZonas = L.layerGroup().addTo(mapa);

/** @type {L.CircleMarker | null} */
let marcadorYo = null;

/** Las clases CSS de cada barrio: para que brillen los que tienen corte y laten los que están en curso. */
function clasesDeBarrio(/** @type {L.Path} */ capa, /** @type {string | null} */ nombre) {
  const estado = nombre ? estados.get(nombre) : undefined;
  const elemento = capa.getElement();
  elemento?.classList.toggle('barrio-con-corte', Boolean(estado));
  elemento?.classList.toggle('barrio-en-curso', Boolean(estado?.enCurso));
  elemento?.classList.toggle('barrio-sin-luz', vecinosSinLuz(nombre) > 0 && !estado?.enCurso);
}

function pintarMapa() {
  capaPoligonos.eachLayer((capa) => {
    const path = /** @type {L.Path & { feature?: FeatureBarrio }} */ (capa);
    const nombre = path.feature?.properties.nombre ?? null;
    path.setStyle(estilo(nombre));
    clasesDeBarrio(path, nombre);
    if (nombre && nombre === barrioElegido) path.bringToFront();
  });

  capaZonas.clearLayers();
  capaPuntos.clearLayers();
  for (const nombre of new Set([...estados.keys(), ...barriosReportados()])) {
    const zona = zonasPorNombre.get(nombre);
    if (zona) {
      const capa = L.geoJSON(zona, { style: () => estiloZona(nombre) })
        .bindTooltip(comoTexto(`${nombre} (zona aproximada)`), { sticky: true })
        .on('click', () => elegirBarrio(nombre))
        .addTo(capaZonas);
      capa.eachLayer((c) => clasesDeBarrio(/** @type {L.Path} */ (c), nombre));
      capasPorNombre.set(nombre, [capa]);
      continue;
    }
    const coordenadas = puntos.get(nombre);
    if (!coordenadas) continue;
    const circulo = L.circleMarker([coordenadas[1], coordenadas[0]], { radius: 11, ...estilo(nombre) })
      .bindTooltip(comoTexto(nombre))
      .on('click', () => elegirBarrio(nombre))
      .addTo(capaPuntos);
    clasesDeBarrio(circulo, nombre);
    capasPorNombre.set(nombre, [circulo]);
  }
  marcadorYo?.bringToFront();
}

const leyenda = new L.Control({ position: ES_CELULAR.matches ? 'topleft' : 'bottomleft' });
// En el celu arranca cerrada para no tapar el mapa: se abre tocando "Referencias".
leyenda.onAdd = () => {
  const caja = h('details', ES_CELULAR.matches ? { class: 'leyenda' } : { class: 'leyenda', open: '' },
    h('summary', {}, 'Referencias'),
    h('div', {}, h('i', { style: 'background:#facc15' }), 'Corte programado'),
    h('div', {}, h('i', { style: 'background:#facc15;outline:2px solid #7c2d12;outline-offset:-2px' }), 'Programado total'),
    h('div', {}, h('i', { style: 'background:#f97316;box-shadow:0 0 8px #f97316' }), 'En curso ahora'),
    h('div', {}, h('i', { style: 'background:#dc2626;box-shadow:0 0 8px #dc2626' }), 'Sin luz sin aviso (vecinos)'),
    h('div', {}, h('i', { style: 'background:#facc1555;outline:2px dashed #92400e;outline-offset:-2px' }), 'Zona aproximada'),
    h('div', {}, h('i', { style: 'background:#a5a1c255;outline:1px solid #8e8aa8;outline-offset:-1px' }), 'Sin cortes anunciados'),
  );
  L.DomEvent.disableClickPropagation(caja); // que tocar la leyenda no cuente como tocar el mapa
  return caja;
};
leyenda.addTo(mapa);

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

/** Reemplaza el contenido del panel, salteando las partes opcionales vacías, y agrega el pie. @param {...Hijo} partes */
function mostrar(...partes) {
  panelFijo = false;
  contenido.replaceChildren(...partes.filter((p) => p !== false && p !== null && p !== undefined), pie());
  contenido.scrollTop = 0;
}

/**
 * "Agendar": Google Calendar (Android y web) o el archivo .ics (iPhone, Android, Outlook). Solo para cortes que no pasaron.
 * @param {Corte} corte @param {string | null} lugar el barrio de la ficha, o null en la lista general
 */
function agendar(corte, lugar) {
  if (corte.fecha < ahora.fecha || (corte.fecha === ahora.fecha && corte.hasta <= ahora.hora)) return null;
  const datos = new URLSearchParams({ fecha: corte.fecha, desde: corte.desde, hasta: corte.hasta, ...(lugar ? { lugar } : {}) });
  return h('details', { class: 'agendar' },
    h('summary', {}, icono('calendario'), 'Agendar'),
    h('div', { class: 'agendar-opciones' },
      h('a', { class: 'boton boton-secundario', href: linkGoogleCalendar(corte, lugar, location.origin), target: '_blank', rel: 'noopener' }, 'Google Calendar'),
      h('a', { class: 'boton boton-secundario', href: `api/calendario?${datos}` }, 'iPhone, Android u Outlook'),
    ),
  );
}

/** @param {Corte} corte @param {number} indice @param {{ conBarrios?: boolean, lugar?: string | null }} [opciones] */
function tarjetaCorte(corte, indice, { conBarrios = true, lugar = null } = {}) {
  const enCurso = estaEnCurso(corte, ahora);
  const clases = ['corte', corte.afectacion === 'total' && 'total', enCurso && 'en-curso'].filter(Boolean).join(' ');
  return h('li', { class: clases, style: `--i:${indice}` },
    h('div', { class: 'horario' },
      icono('reloj'),
      horario(corte),
      enCurso && h('span', { class: 'etiqueta en-curso' }, h('span', { class: 'punto-vivo' }), 'En curso'),
      corte.afectacion && h('span', { class: `etiqueta ${corte.afectacion}` }, corte.afectacion === 'total' ? 'Total' : 'Parcial'),
    ),
    conBarrios && lugaresDelCorte(corte).length > 0 &&
      h('div', { class: 'barrios' },
        ...corte.barrios.map((b) => h('button', { class: 'barrio-link', type: 'button', onclick: () => elegirBarrio(b) }, icono('pin'), b)),
        ...(corte.zonas ?? []).map((z) => h('button', { class: 'barrio-link zona', type: 'button', onclick: () => elegirBarrio(z) }, iconoDeLugar(z), z))),
    h('p', { class: 'zona' }, corte.zona),
    lugaresDelCorte(corte).length === 0 &&
      h('p', { class: 'sin-mapa' }, icono('info'), 'No se pudo marcar en el mapa: la zona está descripta por calles.'),
    h('div', { class: 'pie-corte' },
      h('a', { class: 'fuente', href: corte.fuente, target: '_blank', rel: 'noopener' }, 'Ver anuncio original', icono('enlace')),
      agendar(corte, lugar),
    ),
  );
}

/** @param {Corte[]} delDia */
function tarjetaDelDia(delDia) {
  const enCurso = delDia.filter((c) => estaEnCurso(c, ahora)).length;
  return h('section', { class: 'hero' },
    h('div', { class: 'hero-numero' }, String(delDia.length)),
    h('div', {},
      h('div', { class: 'hero-titulo' }, delDia.length === 1 ? 'corte programado' : 'cortes programados'),
      h('div', { class: 'hero-fecha' }, icono('calendario'), etiquetaDia(diaElegido, ahora.fecha)),
      enCurso > 0 && h('div', { class: 'hero-en-curso' }, h('span', { class: 'punto-vivo' }), `${enCurso} en curso ahora`),
    ),
  );
}

function mostrarResumen() {
  const delDia = cortesDelDia(cortes, diaElegido);
  mostrar(
    tarjetaDelDia(delDia),
    seccionVecinos(),
    delDia.length === 0 && diaElegido > ahora.fecha &&
      h('div', { class: 'aviso' }, icono('info'), h('p', {}, 'Los cortes se suelen anunciar el día anterior: volvé a mirar más tarde.')),
    delDia.length > 0 && h('ul', { class: 'cortes' }, ...delDia.map((c, i) => tarjetaCorte(c, i))),
    avisoReclamo(),
  );
}

/** @param {string} nombre */
function mostrarBarrio(nombre) {
  const estado = estados.get(nombre);
  const delDia = estado?.cortes ?? [];
  const { ultimo, proximo } = historialDelBarrio(cortes, nombre, ahora);
  /** @param {Corte | null} c */
  const describir = (c) => (c ? `${fechaLarga(c.fecha)}, de ${horario(c)}` : 'Sin registros');
  const vecinos = vecinosSinLuz(nombre);
  const [claseEstado, textoEstado] = estado?.enCurso
    ? ['en-curso', 'Corte en curso ahora']
    : vecinos > 0
      ? ['sin-luz', 'Sin luz sin aviso']
      : estado
        ? ['programado', `Corte programado · ${etiquetaCorta(diaElegido, ahora.fecha).toLowerCase()}`]
        : ['sin-cortes', `Sin cortes · ${etiquetaCorta(diaElegido, ahora.fecha).toLowerCase()}`];
  const zona = zonasPorNombre.get(nombre);
  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(null) }, icono('volver'), 'Todos los cortes'),
    h('h2', {}, iconoDeLugar(nombre), nombre),
    h('div', { class: 'ficha-estado' },
      h('span', { class: `estado ${claseEstado}` }, icono(vecinos > 0 && !estado?.enCurso ? 'alerta' : estado ? 'rayo' : 'ok'), textoEstado),
      h('button', { class: 'boton boton-secundario boton-compartir', type: 'button', onclick: () => compartir(nombre) }, icono('compartir'), 'Compartir'),
    ),
    vecinos > 0 && h('p', { class: 'vecinos-cuenta' }, icono('vecinos'),
      `${vecinos} ${vecinos === 1 ? 'vecino reportó' : 'vecinos reportaron'} que no ${vecinos === 1 ? 'tiene' : 'tienen'} luz · último ${hace(reportes[nombre].ultimo)}`),
    zona && h('div', { class: 'aviso' }, icono('info'),
      h('p', {}, zona.properties.descripcion)),
    delDia.length > 0 && h('ul', { class: 'cortes' }, ...delDia.map((c, i) => tarjetaCorte(c, i, { conBarrios: false, lugar: nombre }))),
    cajaSinLuz(nombre),
    h('h3', {}, icono('historial'), 'Historial'),
    h('dl', { class: 'historial' },
      h('div', {}, icono('proximo'), h('span', {}, h('dt', {}, 'Próximo corte'), h('dd', {}, describir(proximo)))),
      h('div', {}, icono('historial'), h('span', {}, h('dt', {}, 'Último corte'), h('dd', {}, describir(ultimo)))),
    ),
    h('div', { class: 'aviso' }, icono('info'), h('p', {}, `Registramos cortes desde el ${fechaLarga(primerRegistro)}.`)),
  );
}

/** El link que abre la página directo en un barrio. @param {string} nombre */
const linkDelBarrio = (nombre) => `${location.origin}${location.pathname}?barrio=${encodeURIComponent(nombre)}`;

/**
 * Comparte el estado del barrio el día elegido. En el celu abre el menú de compartir del sistema
 * (WhatsApp, Telegram, etc.); donde no existe, abre WhatsApp con el mensaje armado.
 * @param {string} nombre
 */
async function compartir(nombre) {
  const texto = textoParaCompartir(nombre, estados.get(nombre)?.cortes ?? [], diaElegido, ahora.fecha, vecinosSinLuz(nombre));
  const url = linkDelBarrio(nombre);
  if (navigator.share) {
    try {
      await navigator.share({ title: `¿Tengo luz? · ${nombre}`, text: texto, url });
    } catch {
      // La persona cerró el menú sin compartir: no pasa nada.
    }
    return;
  }
  window.open(linkWhatsApp('', `${texto}\n\nMirá el mapa: ${url}`), '_blank', 'noopener');
}

/** Lo que aparece en la ficha de cada barrio: el botón "No tengo luz" y cómo reclamar. @param {string} nombre */
function cajaSinLuz(nombre) {
  const yaReporte = reportadosPorMi.has(nombre);
  return h('section', { class: 'caja-sin-luz' },
    h('h3', {}, icono('alerta'), '¿No tenés luz?'),
    yaReporte
      ? h('p', {}, '¡Gracias por avisar! Ahora hacé el reclamo a EPEC: es lo que pone en marcha la reparación.')
      : h('p', {}, 'Avisales a tus vecinos: el barrio se pinta de rojo en el mapa. Es anónimo y dura 3 horas. No es un reclamo a EPEC.'),
    !yaReporte && h('button', { class: 'boton boton-peligro', type: 'button', onclick: (e) => reportar(nombre, e) }, icono('rayo'), 'No tengo luz'),
    h('div', { class: 'reclamo' },
      h('button', { class: 'boton boton-secundario', type: 'button', onclick: () => mostrarReclamo(nombre) }, icono('mensaje'), 'Armar el reclamo a EPEC'),
      h('a', { class: 'boton boton-secundario', href: 'tel:08007770000' }, icono('telefono'), '0800 777 0000'),
    ),
  );
}

// ---------- Formulario de reclamo ----------
// Los datos no salen del navegador: con ellos se arma el texto, y la persona lo manda desde su WhatsApp.
// Solo si marca "Recordar mis datos" se guardan, y únicamente en este navegador (localStorage).

const DATOS_GUARDADOS = 'datos-reclamo';
const CAMPOS_RECORDADOS = /** @type {const} */ (['contrato', 'direccion', 'nombre', 'telefono']);

/** @returns {Partial<Record<typeof CAMPOS_RECORDADOS[number], string>>} */
function leerDatosGuardados() {
  try {
    return JSON.parse(localStorage.getItem(DATOS_GUARDADOS) ?? '{}');
  } catch {
    return {};
  }
}

/** @param {Partial<DatosReclamo> | null} datos null = borrar lo guardado */
function guardarDatos(datos) {
  try {
    if (datos) localStorage.setItem(DATOS_GUARDADOS, JSON.stringify(Object.fromEntries(CAMPOS_RECORDADOS.map((c) => [c, datos[c] ?? '']))));
    else localStorage.removeItem(DATOS_GUARDADOS);
  } catch {
    // Sin almacenamiento (modo privado): no se recuerda, no pasa nada.
  }
}

/**
 * Un campo del formulario con su etiqueta y, si hace falta, una ayuda abajo.
 * @param {string} etiqueta @param {HTMLElement} control @param {string} [ayuda]
 */
const campo = (etiqueta, control, ayuda) => h('label', { class: 'campo' }, etiqueta, control, ayuda && h('small', {}, ayuda));

/** @param {string | null} barrio el barrio elegido, si hay uno */
function mostrarReclamo(barrio) {
  const guardado = leerDatosGuardados();
  /** @param {string} name @param {Record<string, string>} [extra] */
  const entrada = (name, extra = {}) => h('input', { name, value: guardado[/** @type {typeof CAMPOS_RECORDADOS[number]} */ (name)] ?? '', ...extra });

  const urgencia = h('div', { class: 'urgencia', hidden: '' },
    icono('alerta'),
    h('p', {}, h('strong', {}, 'Es una urgencia. '), 'No te acerques ni toques nada, y llamá ya al ',
      h('a', { href: 'tel:08007770000' }, '0800 777 0000'), ' (las 24 horas).'),
  );
  const campoBarrio = /** @type {HTMLInputElement} */ (h('input', { id: 'reclamo-barrio', name: 'barrio', value: barrio ?? '', required: '' }));

  const formulario = /** @type {HTMLFormElement} */ (h('form', { class: 'formulario', onsubmit: (e) => { e.preventDefault(); enviarReclamo(formulario, 'whatsapp'); } },
    h('fieldset', { class: 'opciones', onchange: () => { urgencia.hidden = formulario.problema.value !== 'peligro'; } },
      h('legend', {}, '¿Qué pasa?'),
      ...Object.entries(PROBLEMAS).map(([valor, texto], i) =>
        h('label', { class: 'opcion' }, h('input', { type: 'radio', name: 'problema', value: valor, required: '', ...(i === 0 ? { checked: '' } : {}) }), texto)),
    ),
    urgencia,
    campo('¿Desde cuándo?', h('select', { name: 'desde' }, h('option', { value: '' }, 'Prefiero no decir'), ...DESDE.map((d) => h('option', { value: d }, d)))),
    h('label', { class: 'casilla' }, h('input', { type: 'checkbox', name: 'vecinos' }), 'Mis vecinos tampoco tienen luz'),
    campo('Número de contrato', entrada('contrato', { required: '', inputmode: 'numeric', autocomplete: 'off' }), 'Está en tu factura de EPEC.'),
    campo('Dirección', entrada('direccion', { required: '', placeholder: 'Calle y número', autocomplete: 'street-address' })),
    campo('Barrio', campoBarrio),
    campo('Nombre (opcional)', entrada('nombre', { autocomplete: 'name' })),
    campo('Teléfono de contacto (opcional)', entrada('telefono', { type: 'tel', autocomplete: 'tel' })),
    campo('Comentario (opcional)', h('textarea', { name: 'comentario', rows: '2', maxlength: '300', placeholder: 'Ej.: se escuchó una explosión en el transformador' })),
    h('label', { class: 'casilla' },
      h('input', { type: 'checkbox', name: 'recordar', ...(guardado.contrato ? { checked: '' } : {}) }),
      h('span', {}, 'Recordar mis datos en este dispositivo', h('small', {}, 'Contrato, dirección, nombre y teléfono, solo en este navegador.'))),
    h('div', { class: 'acciones-reclamo' },
      h('button', { class: 'boton boton-whatsapp', type: 'submit' }, icono('mensaje'), 'Enviar por WhatsApp'),
      h('button', { class: 'boton boton-secundario', type: 'button', onclick: () => enviarReclamo(formulario, 'copiar') }, icono('copiar'), 'Copiar el texto'),
      h('a', { class: 'boton boton-secundario', href: RECLAMO_EPEC, target: '_blank', rel: 'noopener' }, icono('enlace'), 'Formulario de EPEC'),
    ),
    h('p', { class: 'nota' }, 'Tus datos no se envían a este sitio: solo se usan para armar el mensaje, que mandás vos desde tu WhatsApp a EPEC (351 200-4343).'),
  ));

  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(barrio) }, icono('volver'), barrio ? `Volver a ${barrio}` : 'Todos los cortes'),
    h('h2', {}, icono('mensaje'), 'Reclamo a EPEC'),
    h('p', { class: 'bajada' }, 'Completá tus datos y se arma el mensaje para mandarle a EPEC por WhatsApp.'),
    formulario,
  );
  autocompletar(campoBarrio, () => {});
  panelFijo = true;
  if (ES_CELULAR.matches) abrirPanel(true);
}

/** @param {HTMLFormElement} formulario @param {'whatsapp' | 'copiar'} como */
function enviarReclamo(formulario, como) {
  if (!formulario.reportValidity()) return;
  const valores = Object.fromEntries(new FormData(formulario));
  /** @type {DatosReclamo} */
  const datos = {
    problema: String(valores.problema ?? ''), desde: String(valores.desde ?? ''), vecinos: 'vecinos' in valores,
    contrato: String(valores.contrato ?? ''), direccion: String(valores.direccion ?? ''), barrio: String(valores.barrio ?? ''),
    nombre: String(valores.nombre ?? ''), telefono: String(valores.telefono ?? ''), comentario: String(valores.comentario ?? ''),
  };
  guardarDatos('recordar' in valores ? datos : null);
  const texto = textoDelReclamo(datos);
  if (como === 'copiar') copiar(texto);
  else window.open(linkWhatsApp(WHATSAPP_EPEC, texto), '_blank', 'noopener');
}

/** En la portada: los barrios donde los vecinos reportan que no tienen luz. */
function seccionVecinos() {
  const reportados = barriosReportados();
  if (reportados.length === 0) return null;
  return h('section', { class: 'vecinos' },
    h('h3', {}, h('span', { class: 'punto-vivo rojo' }), 'Vecinos sin luz ahora'),
    h('div', { class: 'barrios' },
      ...reportados.map((b) => h('button', { class: 'barrio-link sin-luz', type: 'button', onclick: () => elegirBarrio(b) },
        icono('alerta'), b, h('span', { class: 'chip-cuenta', title: 'Reportes' }, String(vecinosSinLuz(b)))))),
    h('p', { class: 'nota' }, 'Reportes anónimos de las últimas 3 horas, sin verificar.'),
  );
}

/** Manda el reporte "No tengo luz". @param {string} nombre @param {Event} evento */
async function reportar(nombre, evento) {
  const boton = /** @type {HTMLButtonElement} */ (evento.currentTarget);
  boton.disabled = true;
  try {
    const res = await fetch('api/reportes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barrio: nombre }),
    });
    const { resultado } = await res.json();
    if (resultado === 'demasiados') {
      avisar('Mandaste muchos reportes seguidos. Probá de nuevo en un rato.');
      boton.disabled = false;
      return;
    }
    if (!res.ok) throw new Error(`La API respondió ${res.status}`);
    reportadosPorMi.add(nombre);
    avisar(resultado === 'repetido' ? 'Ya habías reportado este barrio.' : '¡Gracias! Tu reporte ya está en el mapa.');
    await cargarReportes();
  } catch {
    avisar('No se pudo mandar el reporte. Probá de nuevo.');
    boton.disabled = false;
  }
}

/** @param {string} texto */
function copiar(texto) {
  navigator.clipboard.writeText(texto).then(
    () => avisar('Texto copiado: pegalo en el formulario de EPEC y completá tus datos.'),
    () => avisar('No se pudo copiar el texto.'),
  );
}

function mostrarComoFunciona() {
  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(null) }, icono('volver'), 'Todos los cortes'),
    h('h2', {}, icono('ayuda'), '¿Cómo funciona?'),
    h('ol', { class: 'pasos' },
      h('li', {}, 'EPEC anuncia los cortes programados (mantenimientos, poda, obras) y los medios los publican, en general el día anterior.'),
      h('li', {}, 'Cada hora, un programa lee esos anuncios, se queda con los de Córdoba capital y Gran Córdoba, y reconoce qué barrios o localidades nombran.'),
      h('li', {}, 'Cada barrio se ubica en el mapa oficial de la Municipalidad. Si el anuncio habla de una ruta, o de una localidad sin barrios que se puedan ubicar, se marca una zona aproximada.'),
      h('li', {}, 'El mapa se pinta según el día que elijas, y "en curso" se calcula con la hora actual de Córdoba.'),
    ),
    h('div', { class: 'aviso' }, icono('info'),
      h('p', {}, 'Muestra solo cortes anunciados. Si te quedaste sin luz sin aviso, puede ser una falla: reclamá a EPEC.')),
  );
  panelFijo = true;
}

function avisoReclamo() {
  return h('div', { class: 'aviso' },
    icono('alerta'),
    h('p', {},
      '¿No tenés luz y no figura acá? Puede ser un corte no programado. Buscá tu barrio y tocá ',
      h('strong', {}, 'No tengo luz'),
      ' para avisarles a tus vecinos, y reclamá a EPEC desde ',
      h('a', { href: RECLAMO_EPEC, target: '_blank', rel: 'noopener' }, 'su formulario'),
      ' o al ',
      h('a', { href: 'tel:08007770000' }, '0800 777 0000'),
      '.',
    ),
  );
}

function pie() {
  return h('footer', { class: 'pie' },
    'Sitio no oficial, sin relación con EPEC. Cortes: anuncios publicados por El Doce. ',
    'Barrios: Municipalidad de Córdoba y © colaboradores de OpenStreetMap. ',
    h('a', { href: 'https://github.com/NicolasGonzalezSueyro/tengo-luz', target: '_blank', rel: 'noopener' }, icono('github'), 'Código'),
  );
}

// ---------------------------------------------------------------------------------------------
// Menú lateral (☰)
// ---------------------------------------------------------------------------------------------

const menu = /** @type {HTMLDialogElement} */ ($('menu'));
$('abrir-menu').addEventListener('click', () => menu.showModal());
$('cerrar-menu').addEventListener('click', () => menu.close());
// Tocar afuera del menú (sobre el fondo oscuro) también lo cierra.
menu.addEventListener('click', (e) => {
  if (e.target === menu) menu.close();
});
/** @type {Record<string, () => void>} */
const ACCIONES_MENU = {
  inicio: () => elegirBarrio(null),
  reportar: () => {
    if (barrioElegido) {
      document.querySelector('.caja-sin-luz')?.scrollIntoView({ behavior: 'smooth' });
      if (ES_CELULAR.matches) abrirPanel(true);
      return;
    }
    buscador.focus();
    avisar('Buscá tu barrio (o tocá "Mi ubicación") y después "No tengo luz".');
  },
  reclamar: () => mostrarReclamo(barrioElegido),
  instalar: () => {
    if (pedidoInstalacion) pedidoInstalacion.prompt(); // Android y Chrome: su propia ventanita de "Instalar"
    else mostrarInstalarEnIphone();
  },
  'como-funciona': () => {
    barrioElegido = null;
    pintarMapa();
    mostrarComoFunciona();
    if (ES_CELULAR.matches) abrirPanel(true);
  },
  tema: cambiarTema,
};
for (const boton of menu.querySelectorAll('[data-accion]')) {
  boton.addEventListener('click', () => {
    // Primero se cierra: al cerrarse, el menú devuelve el foco al botón ☰ y le ganaría a la acción.
    menu.close();
    ACCIONES_MENU[boton.getAttribute('data-accion') ?? '']?.();
  });
}

// ---------------------------------------------------------------------------------------------
// Panel deslizable (solo en celular): se arrastra desde la "asa" o se toca para abrir/cerrar.
// ---------------------------------------------------------------------------------------------

/** @param {boolean} abierto */
function abrirPanel(abierto) {
  panel.classList.toggle('abierto', abierto);
  asa.setAttribute('aria-expanded', String(abierto));
}

/** @type {number | null} */
let inicioArrastre = null;
let arrastre = 0;
asa.addEventListener('pointerdown', (e) => {
  inicioArrastre = e.clientY;
  arrastre = 0;
  asa.setPointerCapture(e.pointerId);
  panel.classList.add('arrastrando');
});
asa.addEventListener('pointermove', (e) => {
  if (inicioArrastre === null) return;
  arrastre = e.clientY - inicioArrastre;
  // Lo que se ve queda entre "abierto" y "cerrado": que no se pueda subir de más. Y en píxeles enteros,
  // porque con decimales el iPhone dibuja el texto borroso.
  const recorrido = panel.offsetHeight - parseFloat(getComputedStyle(panel).getPropertyValue('--asoma'));
  const [minimo, maximo] = panel.classList.contains('abierto') ? [0, recorrido] : [-recorrido, 0];
  panel.style.setProperty('--arrastre', `${Math.round(Math.min(Math.max(arrastre, minimo), maximo))}px`);
});
asa.addEventListener('pointerup', () => {
  if (inicioArrastre === null) return;
  inicioArrastre = null;
  panel.classList.remove('arrastrando');
  panel.style.removeProperty('--arrastre');
  // Un toque (casi sin movimiento) alterna; un arrastre decide según la dirección.
  abrirPanel(Math.abs(arrastre) < 8 ? !panel.classList.contains('abierto') : arrastre < 0);
});
// Con teclado (Enter/Espacio) no hay "pointer": el click llega con detail 0.
asa.addEventListener('click', (e) => {
  if (e.detail === 0) abrirPanel(!panel.classList.contains('abierto'));
});

// ---------------------------------------------------------------------------------------------
// Interacción
// ---------------------------------------------------------------------------------------------

/** @param {string | null} nombre */
function elegirBarrio(nombre) {
  barrioElegido = nombre;
  // La dirección de la página queda con el barrio (?barrio=Alberdi): se puede copiar, compartir o guardar.
  history.replaceState(null, '', nombre ? linkDelBarrio(nombre) : location.pathname);
  pintarMapa();
  if (!nombre) {
    mostrarResumen();
    return;
  }
  if (ES_CELULAR.matches) abrirPanel(true);
  const capas = capasPorNombre.get(nombre) ?? [];
  if (capas.length > 0) {
    // En el celu el panel abierto tapa la parte de abajo del mapa: dejamos ese espacio libre al hacer zoom.
    const tapado = ES_CELULAR.matches ? panel.getBoundingClientRect().height : 0;
    mapa.flyToBounds(L.featureGroup(capas).getBounds(), {
      maxZoom: 15, paddingTopLeft: [30, 30], paddingBottomRight: [30, 30 + tapado], duration: 0.8,
    });
  }
  mostrarBarrio(nombre);
}

function dibujarDias() {
  dias.replaceChildren(
    ...diasDisponibles(cortes, ahora.fecha).map((dia) => {
      const cantidad = cortesDelDia(cortes, dia).length;
      return h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(dia === diaElegido),
        title: etiquetaDia(dia, ahora.fecha),
        onclick: () => {
          diaElegido = dia;
          actualizar();
        },
      },
      etiquetaCorta(dia, ahora.fecha),
      cantidad > 0 && h('span', { class: 'chip-cuenta' }, String(cantidad)));
    }),
  );
}

function actualizar() {
  ahora = momentoEnCordoba();
  estados = estadoPorBarrio(cortes, diaElegido, ahora);
  dibujarDias();
  pintarMapa();
  if (panelFijo) return;
  if (barrioElegido) mostrarBarrio(barrioElegido);
  else mostrarResumen();
}

// ---------- Buscador con autocompletado ----------
const nombres = [...lugaresDelMapa].sort((a, b) => a.localeCompare(b, 'es'));

/** El nombre con la parte escrita resaltada. @param {string} nombre @param {string} buscado */
function resaltar(nombre, buscado) {
  const posicion = posicionCoincidencia(nombre, buscado);
  if (!posicion) return [nombre];
  const [desde, hasta] = posicion;
  return [nombre.slice(0, desde), h('mark', {}, nombre.slice(desde, hasta)), nombre.slice(hasta)];
}

/** Una opción de la lista, con una etiqueta si el barrio tiene algo ese día. @param {string} nombre @param {string} buscado @param {string} id */
function opcionSugerida(nombre, buscado, id) {
  const estado = estados.get(nombre);
  const [clase, texto] = estado?.enCurso ? ['en-curso', 'En curso']
    : vecinosSinLuz(nombre) > 0 ? ['sin-luz', 'Sin luz']
      : estado ? ['programado', 'Corte'] : ['', ''];
  return h('li', { id, class: 'sugerencia', role: 'option', 'aria-selected': 'false', 'data-nombre': nombre },
    iconoDeLugar(nombre),
    h('span', { class: 'sugerencia-nombre' }, ...resaltar(nombre, buscado)),
    texto && h('span', { class: `etiqueta ${clase}` }, texto),
  );
}

/**
 * Convierte un campo de texto en un buscador de barrios: mientras se escribe aparece una lista de opciones
 * (con flechas, Enter y Escape desde el teclado). Sigue el patrón "combobox" para que los lectores de pantalla
 * anuncien las opciones.
 * @param {HTMLInputElement} campo @param {(nombre: string) => void} alElegir
 */
function autocompletar(campo, alElegir) {
  const lista = h('ul', { id: `${campo.id}-sugerencias`, class: 'sugerencias', role: 'listbox', hidden: '' });
  // Si el campo está dentro de una etiqueta (formulario), la lista va afuera: tocarla no tiene que "tocar" el campo.
  (campo.closest('label') ?? campo).after(lista);
  Object.entries({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': lista.id, autocomplete: 'off' })
    .forEach(([clave, valor]) => campo.setAttribute(clave, valor));

  /** @type {string[]} */
  let opciones = [];
  let activa = -1;

  const cerrar = () => {
    lista.hidden = true;
    campo.setAttribute('aria-expanded', 'false');
    campo.removeAttribute('aria-activedescendant');
    activa = -1;
  };
  /** @param {number} indice */
  const marcar = (indice) => {
    activa = indice;
    [...lista.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === indice)));
    campo.setAttribute('aria-activedescendant', `${lista.id}-${indice}`);
    lista.children[indice]?.scrollIntoView({ block: 'nearest' });
  };
  /** @param {string} nombre */
  const elegir = (nombre) => {
    campo.value = nombre;
    cerrar();
    alElegir(nombre);
  };
  const mostrarOpciones = () => {
    if (!campo.value.trim()) return cerrar();
    opciones = sugerencias(nombres, campo.value);
    lista.replaceChildren(...(opciones.length > 0
      ? opciones.map((n, i) => opcionSugerida(n, campo.value, `${lista.id}-${i}`))
      : [h('li', { class: 'sin-resultados' }, 'No hay barrios con ese nombre')]));
    activa = -1;
    lista.hidden = false;
    campo.setAttribute('aria-expanded', 'true');
  };

  campo.addEventListener('input', mostrarOpciones);
  campo.addEventListener('focus', mostrarOpciones);
  campo.addEventListener('blur', cerrar);
  // Sin esto, tocar una opción le saca el foco al campo y la lista se cierra antes de registrar el toque.
  lista.addEventListener('mousedown', (e) => e.preventDefault());
  lista.addEventListener('click', (e) => {
    const nombre = /** @type {HTMLElement} */ (e.target).closest('[data-nombre]')?.getAttribute('data-nombre');
    if (nombre) elegir(nombre);
  });
  campo.addEventListener('keydown', (e) => {
    if (lista.hidden || opciones.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const paso = e.key === 'ArrowDown' ? 1 : -1;
      marcar((activa + paso + opciones.length) % opciones.length);
    } else if (e.key === 'Enter' && activa >= 0) {
      e.preventDefault();
      elegir(opciones[activa]);
    } else if (e.key === 'Escape') {
      cerrar();
    }
  });
}

/** @param {string} nombre */
function irAlBarrio(nombre) {
  buscador.blur(); // en el celu cierra el teclado
  elegirBarrio(nombre);
}
autocompletar(buscador, irAlBarrio);

// Enter sin elegir una opción: va a la mejor coincidencia.
$('form-buscar').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!buscador.value.trim()) return;
  const [mejor] = sugerencias(nombres, buscador.value, 1);
  if (!mejor) {
    avisar(`No encontré "${buscador.value}". Probá con otro nombre.`);
    return;
  }
  buscador.value = mejor;
  irAlBarrio(mejor);
});

// ---------- Mi ubicación ----------
// La ubicación se usa solo en el navegador para encontrar el barrio: no se guarda ni se envía a ningún lado.
botonUbicacion.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    avisar('Tu navegador no permite usar la ubicación.');
    return;
  }
  botonUbicacion.setAttribute('aria-busy', 'true');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      botonUbicacion.removeAttribute('aria-busy');
      const punto = /** @type {L.LatLngTuple} */ ([coords.latitude, coords.longitude]);
      marcadorYo?.remove();
      marcadorYo = L.circleMarker(punto, {
        radius: 8, color: '#6d28d9', weight: 3, fillColor: '#ffffff', fillOpacity: 1, className: 'yo',
      }).bindTooltip('Vos estás acá').addTo(mapa);
      const lugar = /** @type {[number, number]} */ ([coords.longitude, coords.latitude]);
      const barrio = barrioEnPunto(poligonosBarrios, lugar) ?? barrioEnPunto(limitesLocalidades, lugar);
      if (barrio) {
        avisar(`Estás en ${barrio}`);
        elegirBarrio(barrio);
      } else {
        mapa.flyTo(punto, 14);
        avisar('Tu ubicación queda fuera de Córdoba capital y de las localidades de Gran Córdoba.');
      }
    },
    (error) => {
      botonUbicacion.removeAttribute('aria-busy');
      avisar(error.code === error.PERMISSION_DENIED
        ? 'Para usar tu ubicación, dale permiso al navegador.'
        : 'No pudimos obtener tu ubicación. Probá de nuevo.');
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
});

// ---------- App instalable y sin conexión ----------
// sw.js guarda una copia de la página y de los datos para que abra aunque no haya internet.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((error) => console.warn('No se pudo activar el modo sin conexión', error));
}

const botonInstalar = $('instalar');
/** El pedido de instalación que da Chrome/Android. Se guarda para mostrarlo cuando la persona toque "Instalar". @type {(Event & { prompt(): Promise<void> }) | null} */
let pedidoInstalacion = null;
const yaInstalada = window.matchMedia('(display-mode: standalone)').matches || 'standalone' in navigator && Boolean(navigator.standalone);
// En iPhone no hay botón automático: se instala desde "Compartir", así que mostramos cómo.
const esIphone = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
botonInstalar.hidden = yaInstalada || !esIphone;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // en vez del cartel automático de Chrome, usamos nuestro botón del menú
  pedidoInstalacion = /** @type {Event & { prompt(): Promise<void> }} */ (e);
  botonInstalar.hidden = false;
});
window.addEventListener('appinstalled', () => {
  pedidoInstalacion = null;
  botonInstalar.hidden = true;
  avisar('¡Listo! Ya podés abrir ¿Tengo luz? desde la pantalla de inicio.');
});

function mostrarInstalarEnIphone() {
  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(null) }, icono('volver'), 'Todos los cortes'),
    h('h2', {}, icono('descargar'), 'Instalar la app'),
    h('p', { class: 'bajada' }, 'En iPhone se instala desde Safari, en tres toques:'),
    h('ol', { class: 'pasos' },
      h('li', {}, 'Tocá el botón ', h('strong', {}, 'Compartir '), icono('compartir'), ' (abajo en el medio, o arriba en iPad).'),
      h('li', {}, 'Bajá y elegí ', h('strong', {}, 'Agregar a inicio'), '.'),
      h('li', {}, 'Tocá ', h('strong', {}, 'Agregar'), '. Va a aparecer el foco en tu pantalla de inicio.'),
    ),
    h('div', { class: 'aviso' }, icono('info'), h('p', {}, 'Instalada, abre a pantalla completa y muestra los últimos datos guardados aunque no tengas señal.')),
  );
  panelFijo = true;
  if (ES_CELULAR.matches) abrirPanel(true);
}

const avisoSinConexion = $('sin-conexion');
function revisarConexion() {
  avisoSinConexion.hidden = navigator.onLine;
}
window.addEventListener('offline', revisarConexion);
window.addEventListener('online', () => {
  revisarConexion();
  cargarReportes();
});
revisarConexion();

/** Trae los reportes de vecinos y vuelve a pintar todo. */
async function cargarReportes() {
  try {
    reportes = await pedir('api/reportes');
  } catch {
    // Si la API no responde, el mapa sigue andando igual, solo que sin reportes nuevos.
  }
  actualizar();
}

aplicarTema();
actualizar();
// Si se abrió un link compartido (?barrio=Alberdi), arranca mostrando ese barrio.
const barrioDelLink = new URLSearchParams(location.search).get('barrio');
if (barrioDelLink) {
  const [encontrado] = lugaresDelMapa.has(barrioDelLink) ? [barrioDelLink] : sugerencias(nombres, barrioDelLink, 1);
  if (encontrado) elegirBarrio(encontrado);
}
cargarReportes();
// Cada minuto: trae reportes nuevos y hace que "En curso" se prenda y se apague a tiempo.
setInterval(cargarReportes, 60_000);
