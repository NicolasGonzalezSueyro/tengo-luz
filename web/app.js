// @ts-check
// La página: dibuja el mapa de barrios, los pinta según los cortes del día elegido y arma el panel.
// La lógica de "qué barrio tiene qué corte" está en estado.js (con tests); acá solo se muestra.

import {
  barrioEnPunto, cortesDelDia, diasDisponibles, estadoPorBarrio, estaEnCurso, etiquetaCorta, etiquetaDia, fechaLarga,
  historialDelBarrio, lugaresDelCorte, momentoEnCordoba,
} from './estado.js';
import { completarIconos, icono } from './iconos.js';

/** @typedef {import('./estado.js').Corte} Corte */
/** @typedef {import('./estado.js').EstadoBarrio} EstadoBarrio */
/** @typedef {{ id: string, nombre: string | null, tipo: 'poligono' | 'punto', fuente: string }} Barrio */
/** @typedef {GeoJSON.Feature<GeoJSON.Geometry, Barrio>} FeatureBarrio */
/** @typedef {{ nombre: string, descripcion: string }} Zona */
/** @typedef {Node | string | null | false | undefined} Hijo */

const CORDOBA = /** @type {L.LatLngTuple} */ ([-31.4167, -64.1833]);
const RECLAMO_EPEC = 'https://www.epec.com.ar/tramites/reclamo-tecnico';
const ES_CELULAR = window.matchMedia('(max-width: 860px)');

// Colores de los barrios en el mapa, según el tema. El resto de los colores está en estilos.css.
const PALETAS = {
  claro: {
    borde: '#8e8aa8', relleno: '#a5a1c2', rellenoOp: 0.07, luz: '#facc15', bordeLuz: '#b45309', bordeTotal: '#7c2d12',
    enCurso: '#f97316', bordeEnCurso: '#c2410c', zona: '#92400e', elegido: '#6d28d9',
  },
  oscuro: {
    borde: '#3a4468', relleno: '#334066', rellenoOp: 0.14, luz: '#fde047', bordeLuz: '#facc15', bordeTotal: '#fef08a',
    enCurso: '#fb923c', bordeEnCurso: '#fdba74', zona: '#d6a46b', elegido: '#c4b5fd',
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

/**
 * Crea un elemento del DOM. Todo el texto entra como texto (nunca como HTML), así nada que venga
 * de las notas puede inyectar código en la página.
 * @param {string} etiqueta
 * @param {Record<string, string | ((e: Event) => void)>} [atributos]
 * @param {...Hijo} hijos
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
const simplificar = (texto) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

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
const primerRegistro = cortes.map((c) => c.fecha).sort()[0];

let ahora = momentoEnCordoba();
let diaElegido = ahora.fecha;
/** @type {Map<string, EstadoBarrio>} */
let estados = new Map();
/** @type {string | null} */
let barrioElegido = null;

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

/** @param {string | null} nombre */
function estilo(nombre) {
  const p = PALETAS[temaActual()];
  const estado = nombre ? estados.get(nombre) : undefined;
  const elegido = nombre !== null && nombre === barrioElegido;
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
  for (const nombre of estados.keys()) {
    const zona = zonasPorNombre.get(nombre);
    if (zona) {
      const capa = L.geoJSON(zona, { style: () => estiloZona(nombre) })
        .bindTooltip(`${nombre} (zona aproximada)`, { sticky: true })
        .on('click', () => elegirBarrio(nombre))
        .addTo(capaZonas);
      capa.eachLayer((c) => clasesDeBarrio(/** @type {L.Path} */ (c), nombre));
      capasPorNombre.set(nombre, [capa]);
      continue;
    }
    const coordenadas = puntos.get(nombre);
    if (!coordenadas) continue;
    const circulo = L.circleMarker([coordenadas[1], coordenadas[0]], { radius: 11, ...estilo(nombre) })
      .bindTooltip(nombre)
      .on('click', () => elegirBarrio(nombre))
      .addTo(capaPuntos);
    clasesDeBarrio(circulo, nombre);
    capasPorNombre.set(nombre, [circulo]);
  }
  marcadorYo?.bringToFront();
}

const leyenda = new L.Control({ position: ES_CELULAR.matches ? 'topleft' : 'bottomleft' });
leyenda.onAdd = () =>
  h('div', { class: 'leyenda' },
    h('strong', {}, 'Referencias'),
    h('div', {}, h('i', { style: 'background:#facc15' }), 'Corte programado'),
    h('div', {}, h('i', { style: 'background:#facc15;outline:2px solid #7c2d12;outline-offset:-2px' }), 'Programado total'),
    h('div', {}, h('i', { style: 'background:#f97316;box-shadow:0 0 8px #f97316' }), 'En curso ahora'),
    h('div', {}, h('i', { style: 'background:#facc1555;outline:2px dashed #92400e;outline-offset:-2px' }), 'Zona aproximada'),
    h('div', {}, h('i', { style: 'background:#a5a1c255;outline:1px solid #8e8aa8;outline-offset:-1px' }), 'Sin cortes anunciados'),
  );
leyenda.addTo(mapa);

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

/** Reemplaza el contenido del panel, salteando las partes opcionales vacías, y agrega el pie. @param {...Hijo} partes */
function mostrar(...partes) {
  contenido.replaceChildren(...partes.filter((p) => p !== false && p !== null && p !== undefined), pie());
  contenido.scrollTop = 0;
}

/** @param {Corte} corte @param {number} indice @param {{ conBarrios?: boolean }} [opciones] */
function tarjetaCorte(corte, indice, { conBarrios = true } = {}) {
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
        ...(corte.zonas ?? []).map((z) => h('button', { class: 'barrio-link zona', type: 'button', onclick: () => elegirBarrio(z) }, icono('ruta'), z))),
    h('p', { class: 'zona' }, corte.zona),
    lugaresDelCorte(corte).length === 0 &&
      h('p', { class: 'sin-mapa' }, icono('info'), 'No se pudo marcar en el mapa: la zona está descripta por calles.'),
    h('a', { class: 'fuente', href: corte.fuente, target: '_blank', rel: 'noopener' }, 'Ver anuncio original', icono('enlace')),
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
  const [claseEstado, textoEstado] = estado?.enCurso
    ? ['en-curso', 'Corte en curso ahora']
    : estado
      ? ['programado', `Corte programado · ${etiquetaCorta(diaElegido, ahora.fecha).toLowerCase()}`]
      : ['sin-cortes', `Sin cortes · ${etiquetaCorta(diaElegido, ahora.fecha).toLowerCase()}`];
  const zona = zonasPorNombre.get(nombre);
  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(null) }, icono('volver'), 'Todos los cortes'),
    h('h2', {}, icono(zona ? 'ruta' : 'pin'), nombre),
    h('span', { class: `estado ${claseEstado}` }, estado ? icono('rayo') : icono('ok'), textoEstado),
    zona && h('div', { class: 'aviso' }, icono('info'),
      h('p', {}, `${zona.properties.descripcion} EPEC describe este corte por la ruta, no por barrios: el contorno marrón es una referencia aproximada.`)),
    delDia.length > 0 && h('ul', { class: 'cortes' }, ...delDia.map((c, i) => tarjetaCorte(c, i, { conBarrios: false }))),
    h('h3', {}, icono('historial'), 'Historial'),
    h('dl', { class: 'historial' },
      h('div', {}, icono('proximo'), h('span', {}, h('dt', {}, 'Próximo corte'), h('dd', {}, describir(proximo)))),
      h('div', {}, icono('historial'), h('span', {}, h('dt', {}, 'Último corte'), h('dd', {}, describir(ultimo)))),
    ),
    h('div', { class: 'aviso' }, icono('info'), h('p', {}, `Registramos cortes desde el ${fechaLarga(primerRegistro)}.`)),
    avisoReclamo(),
  );
}

function mostrarComoFunciona() {
  mostrar(
    h('button', { class: 'volver', type: 'button', onclick: () => elegirBarrio(null) }, icono('volver'), 'Todos los cortes'),
    h('h2', {}, icono('ayuda'), '¿Cómo funciona?'),
    h('ol', { class: 'pasos' },
      h('li', {}, 'EPEC anuncia los cortes programados (mantenimientos, poda, obras) y los medios los publican, en general el día anterior.'),
      h('li', {}, 'Cada hora, un programa lee esos anuncios, se queda con los de Córdoba capital y reconoce qué barrios nombran.'),
      h('li', {}, 'Cada barrio se ubica en el mapa oficial de la Municipalidad. Si el anuncio habla de una ruta en vez de barrios, se marca una zona aproximada.'),
      h('li', {}, 'El mapa se pinta según el día que elijas, y "en curso" se calcula con la hora actual de Córdoba.'),
    ),
    h('div', { class: 'aviso' }, icono('info'),
      h('p', {}, 'Muestra solo cortes anunciados. Si te quedaste sin luz sin aviso, puede ser una falla: reclamá a EPEC.')),
  );
}

function avisoReclamo() {
  return h('div', { class: 'aviso' },
    icono('alerta'),
    h('p', {},
      '¿No tenés luz y no figura acá? Puede ser un corte no programado. Reclamá a EPEC desde ',
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
    ACCIONES_MENU[boton.getAttribute('data-accion') ?? '']?.();
    menu.close();
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
  panel.style.setProperty('--arrastre', `${arrastre}px`);
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
  if (barrioElegido) mostrarBarrio(barrioElegido);
  else mostrarResumen();
}

// ---------- Buscador ----------
const nombres = [...new Set(mapaBarrios.features.flatMap((f) => f.properties.nombre ?? []))].sort((a, b) => a.localeCompare(b, 'es'));
$('lista-barrios').replaceChildren(...nombres.map((n) => h('option', { value: n })));

/** @param {Event} evento */
function buscar(evento) {
  evento.preventDefault();
  const buscado = simplificar(buscador.value);
  if (!buscado) return;
  const encontrado = nombres.find((n) => simplificar(n) === buscado) ?? nombres.find((n) => simplificar(n).includes(buscado));
  if (encontrado) {
    buscador.value = encontrado;
    buscador.blur(); // en el celu cierra el teclado
    elegirBarrio(encontrado);
  } else {
    avisar(`No encontré "${buscador.value}". Probá con otro nombre.`);
  }
}
$('form-buscar').addEventListener('submit', buscar);
buscador.addEventListener('change', buscar);

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
      const barrio = barrioEnPunto(poligonosBarrios, [coords.longitude, coords.latitude]);
      if (barrio) {
        avisar(`Estás en ${barrio}`);
        elegirBarrio(barrio);
      } else {
        mapa.flyTo(punto, 14);
        avisar('Tu ubicación queda fuera de los barrios de Córdoba capital.');
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

aplicarTema();
actualizar();
// Cada minuto, para que "En curso" se prenda y se apague a tiempo.
setInterval(actualizar, 60_000);
