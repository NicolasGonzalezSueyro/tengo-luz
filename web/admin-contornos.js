// @ts-check
// El editor de contornos del panel de admin (/admin-contornos): corregir el contorno de cualquier lugar del mapa,
// borrar uno que está mal, y agregar lugares nuevos (con un buscador que los ubica solo, ver ubicar-lugar.js).
// Cada cambio va a /api/admin con la clave de admin; un robot de GitHub lo aplica a los mapas y publica el sitio.
// Leaflet con el agregado Geoman (el "pm" de los mapas y capas) y Turf vienen como scripts sin tipos.
const L = /** @type {any} */ (globalThis).L;
const turf = /** @type {any} */ (globalThis).turf;

import { BARRIOS_OFICIALES } from './capas-oficiales.js';
import { completarIconos } from './iconos.js';
import { contornoConManzanas, ubicarLugar } from './ubicar-lugar.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const valor = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id)).value.trim();
const CAPITAL = 'Córdoba';

/**
 * @typedef {'barrios' | 'zonas' | 'interior'} Destino
 * @typedef {{ nombre: string, destino: Destino, localidad: string, feature: any, nuevo?: boolean }} Lugar
 * @typedef {{ id: number, accion: 'contorno' | 'borrar' | 'restaurar', nombre: string, destino: Destino, localidad?: string, geometria?: any, creado: number }} Pendiente
 */

/** @type {Map<string, Lugar>} */
let lugares = new Map();
/** @type {Lugar | null} */
let elegido = null;
let cambios = false;
/** @type {any[]} */
let manuales = [];
/** @type {Pendiente[]} */
let pendientes = [];
/** @type {{ nombre: string, localidad: string, veces: number }[]} */
let faltantes = [];

// La clave de admin: la deja el panel (/admin) en esta pestaña al entrar.
let clave = '';
try {
  clave = sessionStorage.getItem('clave-admin') ?? '';
} catch {
  // sin almacenamiento: no se puede guardar nada
}

// ---------------------------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------------------------

const mapa = L.map('mapa-editor', { preferCanvas: true }).setView([-31.42, -64.19], 12);
const calles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(mapa);
const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
});
const ign = L.tileLayer('https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/capabaseargenmap@EPSG%3A3857@png/{z}/{x}/{-y}.png', {
  maxZoom: 19, maxNativeZoom: 18, attribution: '<a href="https://www.ign.gob.ar">Instituto Geográfico Nacional</a>',
});
// Guías de la Provincia (Mapas Córdoba, IDECOR): se superponen al mapa de fondo para seguir los bordes reales.
const idecor = (/** @type {string} */ capas, opacidad = 0.8) => L.tileLayer.wms('https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wms', {
  layers: capas, format: 'image/png', transparent: true, opacity: opacidad, maxZoom: 20,
  attribution: '<a href="https://www.mapascordoba.gob.ar">Mapas Córdoba (IDECOR)</a>',
});
L.control.layers(
  { 'Calles (OpenStreetMap)': calles, 'Satélite (Esri)': satelite, 'Mapa del IGN': ign },
  {
    'Manzanas (Provincia)': idecor('manzana'),
    'Parcelas (Provincia)': idecor('parcelas', 0.6),
    'Radios urbanos (Provincia)': idecor('radios_urbanos'),
    'Loteos aprobados de capital': idecor('loteos_muni_aprobados'),
    'Barrios oficiales de municipios': idecor(Object.values(BARRIOS_OFICIALES).map((b) => b.capa).join(',')),
  },
  { collapsed: true },
).addTo(mapa);
mapa.pm.setLang('es');
mapa.pm.setGlobalOptions({ allowSelfIntersection: false, snappable: true, snapDistance: 12 });

// Todos los contornos de fondo (finos), para ver los vecinos y tocar uno para elegirlo.
const contexto = L.layerGroup().addTo(mapa);
// El lugar que se está editando, y los candidatos que encontró el buscador.
const edicion = L.featureGroup().addTo(mapa);
const vistaCandidato = L.featureGroup().addTo(mapa);
const ESTILO_EDICION = { color: '#c2410c', weight: 3, fillOpacity: 0.15 };

function mensaje(/** @type {string} */ texto, tipo = '') {
  $('mensaje').textContent = texto;
  $('mensaje').className = `mensaje-editor ${tipo}`;
}

/** @param {'GET' | 'POST'} metodo @param {object} [cuerpo] @param {string} [ruta] */
async function api(metodo, cuerpo, ruta = 'api/admin') {
  const res = await fetch(ruta, {
    method: metodo, cache: 'no-store',
    headers: { Authorization: `Bearer ${clave}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos.error ?? `El servidor respondió ${res.status}`);
  return datos;
}

// ---------------------------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------------------------

async function cargar() {
  const leer = (/** @type {string} */ a) => fetch(`data/${a}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [barrios, zonas, interior, contornos, faltan] = await Promise.all(
    ['barrios.geojson', 'zonas.geojson', 'barrios-interior.geojson', 'contornos-manuales.geojson', 'lugares-faltantes.json'].map(leer));
  manuales = contornos?.features ?? [];
  faltantes = Array.isArray(faltan) ? faltan : [];
  pendientes = clave ? await api('GET', undefined, 'api/admin?contornos').catch(() => []) : [];
  lugares = new Map();
  // El orden importa: un punto de capital que también está en el interior se edita como del interior (es el que se dibuja).
  for (const f of (zonas?.features ?? []).filter((/** @type {any} */ f) => f.properties.tipo === 'localidad')) {
    lugares.set(f.properties.nombre, { nombre: f.properties.nombre, destino: 'zonas', localidad: f.properties.nombre, feature: f });
  }
  for (const f of (barrios?.features ?? []).filter((/** @type {any} */ f) => f.properties.nombre)) {
    const esPunto = f.geometry.type === 'Point';
    lugares.set(f.properties.nombre, { nombre: f.properties.nombre, destino: esPunto ? 'interior' : 'barrios', localidad: CAPITAL, feature: f });
  }
  for (const f of interior?.features ?? []) {
    lugares.set(f.properties.nombre, { nombre: f.properties.nombre, destino: 'interior', localidad: f.properties.localidad, feature: f });
  }
  // Lo que se guardó y todavía no se publicó ya se ve como va a quedar.
  for (const p of pendientes) {
    if (p.accion === 'borrar') lugares.delete(p.nombre);
    if (p.accion === 'contorno') {
      const anterior = lugares.get(p.nombre);
      lugares.set(p.nombre, {
        nombre: p.nombre, destino: p.destino, localidad: p.localidad ?? anterior?.localidad ?? CAPITAL,
        feature: { type: 'Feature', properties: { ...(anterior?.feature.properties ?? {}), nombre: p.nombre, fuente: 'manual', tipo: 'poligono' }, geometry: p.geometria },
      });
    }
  }

  $('nombres').replaceChildren(...[...lugares.keys()].sort((a, b) => a.localeCompare(b, 'es')).map((n) => new Option(n)));
  const localidades = [CAPITAL, ...[...lugares.values()].filter((l) => l.destino === 'zonas').map((l) => l.nombre).sort((a, b) => a.localeCompare(b, 'es'))];
  $('localidades').replaceChildren(...localidades.map((n) => new Option(n)));

  contexto.clearLayers();
  for (const lugar of lugares.values()) {
    if (lugar.feature.geometry?.type === 'Point' || !lugar.feature.geometry) continue;
    const estilo = lugar.destino === 'zonas' ? { color: '#6b7280', weight: 1, fillOpacity: 0, dashArray: '2 4' }
      : lugar.feature.properties.tipo === 'aproximado' ? { color: '#2563eb', weight: 1, fillOpacity: 0.03, dashArray: '4 3' }
        : { color: '#2563eb', weight: 1, fillOpacity: 0.03 };
    L.geoJSON(lugar.feature, { style: estilo, pmIgnore: true })
      .bindTooltip(lugar.nombre, { sticky: true })
      // Mientras se dibuja, un clic es un punto del borde: no cambia de lugar.
      .on('click', () => { if (!mapa.pm.globalDrawModeEnabled()) elegir(lugar.nombre); })
      .addTo(contexto);
  }
  listarPendientes();
  listarManuales();
  listarFaltantes();
}

/** Un ítem de lista con un texto y botones. @param {string} texto @param {[string, () => void][]} acciones */
function item(texto, acciones) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = texto;
  li.append(span, ...acciones.map(([etiqueta, accion]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'enlace-boton';
    b.textContent = etiqueta;
    b.addEventListener('click', accion);
    return b;
  }));
  return li;
}

const QUE_HACE = { contorno: 'contorno nuevo', borrar: 'borrar', restaurar: 'volver al original' };
function listarPendientes() {
  $('cuantos-pendientes').textContent = String(pendientes.length);
  $('pendientes').replaceChildren(...pendientes.map((p) => item(`${p.nombre} · ${QUE_HACE[p.accion]}`, [
    ['ver', () => elegir(p.nombre)],
    ['cancelar', async () => {
      if (!confirm(`¿Descartar este cambio de ${p.nombre}? No se va a publicar.`)) return;
      try {
        await api('POST', { accion: 'cancelar-contorno', id: p.id });
        await cargar();
        mensaje('Listo, descarté ese cambio.', 'ok');
      } catch (error) {
        mensaje(/** @type {Error} */ (error).message, 'error');
      }
    }],
  ])));
}

function listarFaltantes() {
  // Los que ya están en el mapa (o esperando publicarse) no se muestran más.
  const quedan = faltantes.filter((f) => !lugares.has(f.localidad === CAPITAL ? f.nombre : `${f.nombre} (${f.localidad})`));
  $('cuantos-faltan').textContent = String(quedan.length);
  $('faltantes').replaceChildren(...quedan.slice(0, 300).map((f) => item(`${f.nombre} · ${f.localidad}${f.veces > 1 ? ` (${f.veces} veces)` : ''}`, [
    ['ubicar', () => {
      /** @type {HTMLInputElement} */ ($('nuevo-nombre')).value = f.nombre;
      /** @type {HTMLInputElement} */ ($('nuevo-localidad')).value = f.localidad;
      /** @type {HTMLDetailsElement} */ ($('bloque-nuevo')).open = true;
      $('ubicar').click();
    }],
  ])));
}

function listarManuales() {
  $('cuantos').textContent = String(manuales.length);
  $('manuales').replaceChildren(...manuales.map((m) => item(`${m.properties.nombre}${m.properties.borrado ? ' (borrado)' : ''}`, [['ver', () => elegir(m.properties.nombre)]])));
}

// ---------------------------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------------------------

const tieneManual = () => Boolean(elegido) && manuales.some((m) => m.properties.nombre === elegido?.nombre && m.properties.destino === elegido?.destino);

function botones() {
  const hay = Boolean(elegido);
  const set = (/** @type {string} */ id, /** @type {boolean} */ activo) => { /** @type {HTMLButtonElement} */ ($(id)).disabled = !activo || !clave; };
  set('guardar', hay && cambios);
  set('descartar', hay && cambios);
  set('dibujar', hay);
  set('mejor', hay);
  set('restaurar', tieneManual());
  set('borrar', hay && !elegido?.nuevo);
}

function editable(/** @type {any} */ capa) {
  capa.setStyle?.(ESTILO_EDICION);
  capa.pm.enable({ allowSelfIntersection: false });
  capa.on('pm:edit pm:vertexremoved', () => { cambios = true; botones(); });
}

/** Pone un contorno en edición. @param {any} geometria */
function editar(geometria) {
  edicion.clearLayers();
  L.geoJSON({ type: 'Feature', properties: {}, geometry: geometria }).eachLayer((/** @type {any} */ capa) => { edicion.addLayer(capa); editable(capa); });
  if (edicion.getLayers().length) mapa.fitBounds(edicion.getBounds(), { padding: [40, 40] });
}

/** El nombre base y la localidad de un lugar ("Centro (Villa María)" → "Centro", "Villa María"). @param {Lugar} lugar */
const baseDe = (lugar) => (lugar.feature.properties.base ?? lugar.nombre.replace(/\s*\([^)]*\)$/, ''));

function elegir(/** @type {string} */ nombre) {
  const lugar = lugares.get(nombre);
  if (!lugar) return mensaje(`No encontré "${nombre}" en el mapa. Si es nuevo, usá "Agregar un lugar".`, 'error');
  if (cambios && elegido && !confirm(`Hay cambios sin guardar en ${elegido.nombre}. ¿Descartarlos?`)) return;
  elegido = lugar;
  cambios = false;
  mapa.pm.disableDraw();
  vistaCandidato.clearLayers();
  $('bloque-candidatos').hidden = true;
  edicion.clearLayers();
  $('elegido').textContent = nombre;
  /** @type {HTMLInputElement} */ ($('buscar')).value = nombre;
  const tipo = lugar.feature.properties.tipo;
  const origen = lugar.feature.properties.fuente === 'manual' ? 'cambiado a mano'
    : tipo === 'aproximado' ? 'contorno aproximado' : lugar.destino === 'zonas' ? 'localidad' : `fuente: ${lugar.feature.properties.fuente ?? 'OSM'}`;
  const pendiente = pendientes.some((p) => p.nombre === nombre) ? ' · esperando publicarse' : '';
  $('detalle').textContent = `${lugar.localidad === nombre ? '' : `${lugar.localidad} · `}${origen}${pendiente}`;
  mensaje(clave ? '' : 'Entrá al panel de admin con tu clave para poder guardar.');
  if (lugar.feature.geometry?.type === 'Point') {
    const [lon, lat] = lugar.feature.geometry.coordinates;
    L.marker([lat, lon], { pmIgnore: true }).addTo(edicion);
    mapa.setView([lat, lon], 16);
    mensaje('Este lugar es solo un punto: tocá "Buscar un contorno mejor" o "Dibujar de cero".');
  } else if (lugar.feature.geometry) {
    editar(lugar.feature.geometry);
  }
  botones();
}

function dibujar() {
  if (!elegido) return;
  edicion.eachLayer((/** @type {any} */ c) => { if (c instanceof L.Marker) edicion.removeLayer(c); });
  mapa.pm.enableDraw('Polygon', { templineStyle: ESTILO_EDICION, hintlineStyle: { ...ESTILO_EDICION, dashArray: '4 4' }, pathOptions: ESTILO_EDICION });
  mensaje('Tocá el mapa para poner cada punto del borde; tocá el primero para cerrarlo. Podés dibujar más de una parte. Escape cancela.');
}
mapa.on('pm:create', (/** @type {any} */ e) => {
  mapa.removeLayer(e.layer);
  if (!elegido) return;
  edicion.addLayer(e.layer);
  editable(e.layer);
  cambios = true;
  botones();
});

/** El contorno dibujado como GeoJSON: un polígono, o varios juntos. */
function geometria() {
  /** @type {any[]} */
  const partes = [];
  edicion.eachLayer((/** @type {any} */ c) => {
    if (!(c instanceof L.Polygon)) return;
    const g = /** @type {any} */ (c.toGeoJSON()).geometry;
    if (g.type === 'Polygon') partes.push(g.coordinates);
    else partes.push(...g.coordinates);
  });
  if (partes.length === 0) return null;
  // ~1 m de precisión: el pedido queda chico y alcanza de sobra para un mapa.
  const redondear = (/** @type {any} */ x) => (typeof x === 'number' ? Math.round(x * 1e5) / 1e5 : x.map(redondear));
  return partes.length === 1 ? { type: 'Polygon', coordinates: redondear(partes[0]) } : { type: 'MultiPolygon', coordinates: redondear(partes) };
}

/** Manda un cambio y recarga todo, dejando elegido el mismo lugar si sigue existiendo. @param {object} pedido @param {string} texto */
async function enviar(pedido, texto) {
  try {
    const { robot } = await api('POST', pedido);
    const nombre = elegido?.nombre ?? '';
    cambios = false;
    await cargar();
    if (lugares.has(nombre)) elegir(nombre);
    else { elegido = null; edicion.clearLayers(); $('elegido').textContent = 'Ningún lugar elegido'; $('detalle').textContent = ''; /** @type {HTMLInputElement} */ ($('buscar')).value = ''; botones(); }
    mensaje(robot === 'pedido' ? `${texto} Se publica solo en 2 o 3 minutos.`
      : `${texto} Quedó guardado, pero no pude avisarle al robot (${robot}): se publica en su próxima corrida.`, robot === 'pedido' ? 'ok' : 'error');
  } catch (error) {
    mensaje(/** @type {Error} */ (error).message, 'error');
  }
}

$('guardar').addEventListener('click', () => {
  if (!elegido) return;
  const geo = geometria();
  if (!geo) return mensaje('No hay ningún contorno dibujado.', 'error');
  enviar({ accion: 'contorno', nombre: elegido.nombre, destino: elegido.destino, localidad: elegido.localidad, geometria: geo }, `Guardé ${elegido.nombre}.`);
});

$('descartar').addEventListener('click', () => {
  if (!elegido) return;
  cambios = false;
  if (elegido.nuevo) { elegido = null; edicion.clearLayers(); $('elegido').textContent = 'Ningún lugar elegido'; botones(); return; }
  elegir(elegido.nombre);
});

$('restaurar').addEventListener('click', () => {
  if (!elegido || !confirm(`¿Volver ${elegido.nombre} a como estaba antes de cambiarlo a mano?`)) return;
  enviar({ accion: 'restaurar', nombre: elegido.nombre, destino: elegido.destino }, `${elegido.nombre} vuelve a como estaba.`);
});

$('borrar').addEventListener('click', () => {
  if (!elegido || !confirm(`¿Borrar ${elegido.nombre} del mapa? Deja de dibujarse y de reconocerse en los cortes. Se puede volver atrás con "Volver al original".`)) return;
  enviar({ accion: 'borrar', nombre: elegido.nombre, destino: elegido.destino, localidad: elegido.localidad }, `Borré ${elegido.nombre}.`);
});

$('dibujar').addEventListener('click', () => {
  if (elegido && edicion.getLayers().some((/** @type {any} */ c) => c instanceof L.Polygon) && !confirm('¿Borrar el contorno actual y dibujar uno de cero?')) return;
  edicion.clearLayers();
  dibujar();
});

// ---------------------------------------------------------------------------------------------
// Buscar y ubicar solo
// ---------------------------------------------------------------------------------------------

/** La zona donde buscar: la localidad (o capital entera), agrandada ~2 km. @param {string} localidad @returns {[number, number, number, number]} */
function cajaDe(localidad) {
  const zona = lugares.get(localidad);
  const capas = localidad === CAPITAL
    ? [...lugares.values()].filter((l) => l.destino === 'barrios').map((l) => l.feature)
    : zona ? [zona.feature] : [];
  if (capas.length === 0) return [-65.8, -35.1, -61.7, -29.4]; // toda la provincia
  const [o, s, e, n] = turf.bbox(turf.featureCollection(capas));
  return [o - 0.02, s - 0.02, e + 0.02, n + 0.02];
}

/** Muestra los candidatos y pone en edición el mejor. @param {import('./ubicar-lugar.js').Candidato[]} candidatos */
function mostrarCandidatos(candidatos) {
  $('bloque-candidatos').hidden = candidatos.length === 0;
  /** @param {number} i */
  const usar = (i) => {
    const c = candidatos[i];
    vistaCandidato.clearLayers();
    editar(c.geometria);
    cambios = true;
    botones();
    [...$('candidatos').children].forEach((li, j) => li.classList.toggle('activo', i === j));
    mensaje(`${c.aproximado ? 'Armé un contorno aproximado' : 'Lo encontré'} en ${c.fuente} (“${c.nombre}”). Revisalo con el satélite y tocá Guardar.`, 'ok');
  };
  $('candidatos').replaceChildren(...candidatos.map((c, i) => {
    const hectareas = Math.round(turf.area({ type: 'Feature', properties: {}, geometry: c.geometria }) / 10_000);
    const li = item(`${c.nombre} · ${c.fuente} · ${hectareas} ha${c.aproximado ? ' · aproximado' : ''}`, [['usar este', () => usar(i)]]);
    li.addEventListener('mouseenter', () => { vistaCandidato.clearLayers(); L.geoJSON(c.geometria, { style: { color: '#7c3aed', weight: 2, dashArray: '4 4', fillOpacity: 0.05 }, pmIgnore: true }).addTo(vistaCandidato); });
    return li;
  }));
  if (candidatos.length > 0) usar(0);
}

/** Busca un lugar en todas las fuentes y lo deja listo para revisar. @param {string} base @param {string} localidad */
async function buscarYUbicar(base, localidad) {
  const boton = /** @type {HTMLButtonElement} */ ($('ubicar'));
  boton.disabled = true;
  /** @type {HTMLButtonElement} */ ($('mejor')).disabled = true;
  try {
    const candidatos = await ubicarLugar(base, localidad, cajaDe(localidad), (texto) => mensaje(texto));
    mostrarCandidatos(candidatos);
    if (candidatos.length === 0) {
      dibujar();
      mensaje(`No encontré "${base}" en ninguna fuente de ${localidad}. Dibujalo a mano: tocá el mapa punto por punto y el primero para cerrar.`, 'error');
    }
  } finally {
    boton.disabled = false;
    botones();
  }
}

$('ubicar').addEventListener('click', () => {
  const base = valor('nuevo-nombre');
  const localidad = valor('nuevo-localidad') || CAPITAL;
  if (!base) return mensaje('Escribí el nombre del lugar.', 'error');
  if (localidad !== CAPITAL && !lugares.has(localidad)) return mensaje(`No conozco la localidad "${localidad}": elegila de la lista.`, 'error');
  // Como el resto del interior: "Centro (Villa María)". En capital, el nombre solo.
  const nombre = localidad === CAPITAL ? base : `${base} (${localidad})`;
  if (lugares.has(nombre) && lugares.get(nombre)?.feature.geometry?.type !== 'Point'
    && !confirm(`${nombre} ya está en el mapa. ¿Buscar un contorno mejor para reemplazar el actual?`)) return elegir(nombre);
  nuevoLugar(nombre, localidad);
  buscarYUbicar(base, localidad);
});

$('mejor').addEventListener('click', () => {
  if (!elegido) return;
  buscarYUbicar(baseDe(elegido), elegido.localidad);
});

/** Deja elegido un lugar (nuevo, o uno que existe y se va a reemplazar). @param {string} nombre @param {string} localidad */
function nuevoLugar(nombre, localidad) {
  const existente = lugares.get(nombre);
  elegido = existente ?? { nombre, destino: 'interior', localidad, feature: { properties: { base: nombre.replace(/\s*\([^)]*\)$/, '') }, geometry: null }, nuevo: true };
  cambios = false;
  edicion.clearLayers();
  vistaCandidato.clearLayers();
  $('elegido').textContent = existente ? nombre : `${nombre} (nuevo)`;
  $('detalle').textContent = localidad;
  const [o, s, e, n] = cajaDe(localidad);
  mapa.fitBounds([[s, o], [n, e]]);
  botones();
}

$('nuevo').addEventListener('click', () => {
  const base = valor('nuevo-nombre');
  const localidad = valor('nuevo-localidad') || CAPITAL;
  if (!base) return mensaje('Escribí el nombre del lugar.', 'error');
  const nombre = localidad === CAPITAL ? base : `${base} (${localidad})`;
  if (lugares.has(nombre)) return elegir(nombre);
  nuevoLugar(nombre, localidad);
  dibujar();
});

// Alt + clic en el mapa arma un contorno con las manzanas de alrededor de ese punto (para un lugar elegido).
mapa.on('click', async (/** @type {any} */ e) => {
  if (!e.originalEvent.altKey || !elegido || mapa.pm.globalDrawModeEnabled()) return;
  mensaje('Armando un contorno con las manzanas de alrededor…');
  const geo = await contornoConManzanas([e.latlng.lng, e.latlng.lat]);
  if (!geo) return mensaje('No hay manzanas oficiales ahí.', 'error');
  editar(geo);
  cambios = true;
  botones();
  mensaje('Listo: revisalo y tocá Guardar.', 'ok');
});

$('buscar').addEventListener('change', () => elegir(valor('buscar')));

// El link a Google Maps sigue al mapa, para comparar la misma zona (solo para mirar: los contornos no se copian de ahí).
mapa.on('moveend', () => {
  const c = mapa.getCenter();
  /** @type {HTMLAnchorElement} */ ($('google')).href = `https://www.google.com/maps/@${c.lat.toFixed(5)},${c.lng.toFixed(5)},${Math.min(mapa.getZoom(), 20)}z`;
});
window.addEventListener('beforeunload', (e) => { if (cambios) e.preventDefault(); });

completarIconos();
$('sin-clave').hidden = Boolean(clave);
await cargar();
const pedido = new URLSearchParams(location.search).get('lugar');
if (pedido) elegir(pedido);
