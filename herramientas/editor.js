// Editor de contornos (lo sirve `npm run editor`). Arma la lista de lugares con los tres mapas, deja editar el
// contorno del elegido con Leaflet-Geoman y lo manda a /guardar.
/* global L */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const CAPITAL = 'Córdoba';

/** @typedef {{ nombre: string, destino: 'barrios' | 'zonas' | 'interior', localidad: string, feature: any }} Lugar */
/** @type {Map<string, Lugar>} */
let lugares = new Map();
/** @type {Lugar | null} */
let elegido = null;
let cambios = false;
/** @type {any[]} */
let manuales = [];
/** @type {{ nombre: string, localidad: string, veces: number }[]} los lugares que nombra EPEC y el mapa no tiene */
let faltantes = [];

const mapa = L.map('mapa', { preferCanvas: true }).setView([-31.42, -64.19], 12);
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
const BARRIOS_OFICIALES = ['anisacate_barrios', 'ccaroya_barrios', 'corralito_barrios', 'cosquin_barrios', 'cruzalta_barrios', 'hernando_barrios',
  'Jesus_Maria_Barrios', 'barrios_lf', 'mteros_barrios', 'riocuarto_vecinales', 'barrios_salsipuedes', 'unq_barrios', 'va_barrios',
  'Villa_Giardino_Barrios', 'vm_barrios'].join(',');
L.control.layers(
  { 'Calles (OpenStreetMap)': calles, 'Satélite (Esri)': satelite, 'Mapa del IGN': ign },
  {
    'Manzanas (Provincia)': idecor('manzana'),
    'Parcelas (Provincia)': idecor('parcelas', 0.6),
    'Radios urbanos (Provincia)': idecor('radios_urbanos'),
    'Loteos aprobados de capital': idecor('loteos_muni_aprobados'),
    'Barrios oficiales de municipios': idecor(BARRIOS_OFICIALES),
  },
  { collapsed: true },
).addTo(mapa);
mapa.pm.setLang('es');
mapa.pm.setGlobalOptions({ allowSelfIntersection: false, snappable: true, snapDistance: 12 });

// Todos los contornos de fondo (finos), para ver los vecinos y tocar uno para elegirlo.
const contexto = L.layerGroup().addTo(mapa);
// El lugar que se está editando.
const edicion = L.featureGroup().addTo(mapa);
const ESTILO_EDICION = { color: '#c2410c', weight: 3, fillOpacity: 0.15 };

function mensaje(/** @type {string} */ texto, tipo = '') {
  $('mensaje').textContent = texto;
  $('mensaje').className = tipo;
}

async function cargar() {
  const leer = (/** @type {string} */ a) => fetch(`/data/${a}`).then((r) => (r.ok ? r.json() : { features: [] }));
  const [barrios, zonas, interior, contornos, faltan] = await Promise.all(
    ['barrios.geojson', 'zonas.geojson', 'barrios-interior.geojson', 'contornos-manuales.geojson', 'lugares-faltantes.json'].map(leer));
  manuales = contornos.features;
  faltantes = Array.isArray(faltan) ? faltan : [];
  lugares = new Map();
  // El orden importa: un punto de capital que también está en el interior se edita como del interior (es el que se dibuja).
  for (const f of zonas.features.filter((/** @type {any} */ f) => f.properties.tipo === 'localidad')) {
    lugares.set(f.properties.nombre, { nombre: f.properties.nombre, destino: 'zonas', localidad: f.properties.nombre, feature: f });
  }
  for (const f of barrios.features.filter((/** @type {any} */ f) => f.properties.nombre)) {
    const esPunto = f.geometry.type === 'Point';
    lugares.set(f.properties.nombre, { nombre: f.properties.nombre, destino: esPunto ? 'interior' : 'barrios', localidad: CAPITAL, feature: f });
  }
  for (const f of interior.features) {
    lugares.set(f.properties.nombre, { nombre: f.properties.nombre, destino: 'interior', localidad: f.properties.localidad, feature: f });
  }

  $('nombres').replaceChildren(...[...lugares.keys()].sort((a, b) => a.localeCompare(b, 'es')).map((n) => new Option(n)));
  const localidades = [CAPITAL, ...[...lugares.values()].filter((l) => l.destino === 'zonas').map((l) => l.nombre)];
  $('localidades').replaceChildren(...localidades.map((n) => new Option(n)));

  contexto.clearLayers();
  for (const lugar of lugares.values()) {
    if (lugar.feature.geometry.type === 'Point') continue;
    const estilo = lugar.destino === 'zonas' ? { color: '#6b7280', weight: 1, fillOpacity: 0, dashArray: '2 4' }
      : lugar.feature.properties.tipo === 'aproximado' ? { color: '#2563eb', weight: 1, fillOpacity: 0.03, dashArray: '4 3' }
        : { color: '#2563eb', weight: 1, fillOpacity: 0.03 };
    L.geoJSON(lugar.feature, { style: estilo, pmIgnore: true })
      .bindTooltip(lugar.nombre, { sticky: true })
      // Mientras se dibuja, un clic es un punto del borde: no cambia de lugar.
      .on('click', () => { if (!mapa.pm.globalDrawModeEnabled()) elegir(lugar.nombre); })
      .addTo(contexto);
  }
  listarManuales();
  listarFaltantes();
}

function listarFaltantes() {
  // Los que ya se dibujaron con el editor no se muestran más.
  const pendientes = faltantes.filter((f) => !lugares.has(f.localidad === CAPITAL ? f.nombre : `${f.nombre} (${f.localidad})`));
  $('cuantos-faltan').textContent = String(pendientes.length);
  $('faltantes').replaceChildren(...pendientes.slice(0, 300).map((f) => {
    const li = document.createElement('li');
    const ir = document.createElement('button');
    ir.textContent = 'dibujar';
    ir.addEventListener('click', () => {
      /** @type {HTMLInputElement} */ ($('nuevo-nombre')).value = f.nombre;
      /** @type {HTMLInputElement} */ ($('nuevo-localidad')).value = f.localidad;
      $('nuevo').click();
    });
    li.append(`${f.nombre} · ${f.localidad}${f.veces > 1 ? ` (${f.veces} veces)` : ''}`, ir);
    return li;
  }));
}

function listarManuales() {
  $('cuantos').textContent = String(manuales.length);
  $('manuales').replaceChildren(...manuales.map((m) => {
    const li = document.createElement('li');
    const ir = document.createElement('button');
    ir.textContent = 'ver';
    ir.addEventListener('click', () => elegir(m.properties.nombre));
    li.append(m.properties.nombre, ir);
    return li;
  }));
}

function botones() {
  const hay = Boolean(elegido);
  /** @type {HTMLButtonElement} */ ($('guardar')).disabled = !hay || !cambios;
  /** @type {HTMLButtonElement} */ ($('descartar')).disabled = !hay || !cambios;
  /** @type {HTMLButtonElement} */ ($('dibujar')).disabled = !hay;
  /** @type {HTMLButtonElement} */ ($('restaurar')).disabled = !hay
    || !manuales.some((m) => m.properties.nombre === elegido?.nombre && m.properties.destino === elegido?.destino);
}

function editable(/** @type {any} */ capa) {
  capa.setStyle?.(ESTILO_EDICION);
  capa.pm.enable({ allowSelfIntersection: false });
  capa.on('pm:edit pm:vertexremoved', () => { cambios = true; botones(); });
}

function elegir(/** @type {string} */ nombre) {
  const lugar = lugares.get(nombre);
  if (!lugar) return mensaje(`No encontré "${nombre}" en el mapa. Si es nuevo, usá "Agregar un lugar nuevo".`, 'error');
  if (cambios && elegido && !confirm(`Hay cambios sin guardar en ${elegido.nombre}. ¿Descartarlos?`)) return;
  elegido = lugar;
  cambios = false;
  mapa.pm.disableDraw();
  edicion.clearLayers();
  $('elegido').textContent = nombre;
  /** @type {HTMLInputElement} */ ($('buscar')).value = nombre;
  const tipo = lugar.feature.properties.tipo;
  const origen = lugar.feature.properties.fuente === 'manual' ? 'cambiado a mano'
    : tipo === 'aproximado' ? 'contorno aproximado' : lugar.destino === 'zonas' ? 'localidad' : `fuente: ${lugar.feature.properties.fuente ?? 'OSM'}`;
  $('detalle').textContent = `${lugar.localidad === nombre ? '' : `${lugar.localidad} · `}${origen}`;
  mensaje('');
  if (lugar.feature.geometry.type === 'Point') {
    const [lon, lat] = lugar.feature.geometry.coordinates;
    L.marker([lat, lon], { pmIgnore: true }).addTo(edicion);
    mapa.setView([lat, lon], 16);
    mensaje('Este lugar es solo un punto: tocá "Dibujar de cero" para darle contorno.');
  } else {
    L.geoJSON(lugar.feature).eachLayer((capa) => { edicion.addLayer(capa); editable(capa); });
    mapa.fitBounds(edicion.getBounds(), { padding: [40, 40] });
  }
  botones();
}

function dibujar() {
  if (!elegido) return;
  edicion.eachLayer((c) => { if (c instanceof L.Marker) edicion.removeLayer(c); });
  mapa.pm.enableDraw('Polygon', { templineStyle: ESTILO_EDICION, hintlineStyle: { ...ESTILO_EDICION, dashArray: '4 4' }, pathOptions: ESTILO_EDICION });
  mensaje('Tocá el mapa para poner cada punto del borde; tocá el primero para cerrarlo. Podés dibujar más de una parte. Escape cancela.');
}
mapa.on('pm:create', (/** @type {any} */ e) => {
  if (!elegido) return mapa.removeLayer(e.layer);
  mapa.removeLayer(e.layer);
  edicion.addLayer(e.layer);
  editable(e.layer);
  cambios = true;
  botones();
});

/** El contorno dibujado como GeoJSON: un polígono, o varios juntos. */
function geometria() {
  /** @type {any[]} */
  const partes = [];
  edicion.eachLayer((c) => {
    if (!(c instanceof L.Polygon)) return;
    const g = /** @type {any} */ (c.toGeoJSON()).geometry;
    if (g.type === 'Polygon') partes.push(g.coordinates);
    else partes.push(...g.coordinates);
  });
  if (partes.length === 0) return null;
  return partes.length === 1 ? { type: 'Polygon', coordinates: partes[0] } : { type: 'MultiPolygon', coordinates: partes };
}

async function enviar(/** @type {object} */ pedido) {
  const res = await fetch('/guardar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pedido) });
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error);
  return datos.mensaje;
}

$('guardar').addEventListener('click', async () => {
  if (!elegido) return;
  const geo = geometria();
  if (!geo) return mensaje('No hay ningún contorno dibujado.', 'error');
  try {
    const nombre = elegido.nombre;
    mensaje(await enviar({ nombre, destino: elegido.destino, localidad: elegido.localidad, geometria: geo }), 'ok');
    cambios = false;
    await cargar();
    const texto = $('mensaje').textContent ?? '';
    elegir(nombre);
    mensaje(texto, 'ok');
  } catch (error) {
    mensaje(/** @type {Error} */ (error).message, 'error');
  }
});

$('descartar').addEventListener('click', () => {
  if (!elegido) return;
  cambios = false;
  elegir(elegido.nombre);
});

$('restaurar').addEventListener('click', async () => {
  if (!elegido || !confirm(`¿Volver ${elegido.nombre} al contorno que tenía antes de cambiarlo a mano?`)) return;
  try {
    const nombre = elegido.nombre;
    const texto = await enviar({ nombre, destino: elegido.destino, restaurar: true });
    cambios = false;
    await cargar();
    if (lugares.has(nombre)) elegir(nombre);
    else { elegido = null; edicion.clearLayers(); $('elegido').textContent = 'Ningún lugar elegido'; botones(); }
    mensaje(texto, 'ok');
  } catch (error) {
    mensaje(/** @type {Error} */ (error).message, 'error');
  }
});

$('dibujar').addEventListener('click', () => {
  if (elegido && edicion.getLayers().some((c) => c instanceof L.Polygon)
    && !confirm('¿Borrar el contorno actual y dibujar uno de cero?')) return;
  edicion.clearLayers();
  dibujar();
});

$('nuevo').addEventListener('click', () => {
  const base = /** @type {HTMLInputElement} */ ($('nuevo-nombre')).value.trim();
  const localidad = /** @type {HTMLInputElement} */ ($('nuevo-localidad')).value.trim() || CAPITAL;
  if (!base) return mensaje('Escribí el nombre del lugar nuevo.', 'error');
  // Como el resto del interior: "Centro (Villa María)". En capital, el nombre solo.
  const nombre = localidad === CAPITAL ? base : `${base} (${localidad})`;
  if (lugares.has(nombre)) return elegir(nombre);
  elegido = { nombre, destino: 'interior', localidad, feature: { properties: {}, geometry: { type: 'Polygon' } } };
  cambios = false;
  edicion.clearLayers();
  $('elegido').textContent = `${nombre} (nuevo)`;
  $('detalle').textContent = localidad;
  const zona = lugares.get(localidad);
  if (zona && zona.feature.geometry.type !== 'Point') mapa.fitBounds(L.geoJSON(zona.feature).getBounds());
  botones();
  dibujar();
});

$('buscar').addEventListener('change', () => elegir(/** @type {HTMLInputElement} */ ($('buscar')).value.trim()));

// El link a Google Maps sigue al mapa, para comparar la misma zona (solo para mirar: los contornos no se copian de ahí).
mapa.on('moveend', () => {
  const c = mapa.getCenter();
  /** @type {HTMLAnchorElement} */ ($('google')).href = `https://www.google.com/maps/@${c.lat.toFixed(5)},${c.lng.toFixed(5)},${Math.min(mapa.getZoom(), 20)}z`;
});
window.addEventListener('beforeunload', (e) => { if (cambios) e.preventDefault(); });

await cargar();
const pedido = new URLSearchParams(location.search).get('lugar');
if (pedido) elegir(pedido);
