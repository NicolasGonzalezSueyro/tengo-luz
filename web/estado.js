// @ts-check
// Lógica de la página que no depende del mapa: qué barrios tienen cortes un día, en qué estado están,
// cuál fue el último y cuál es el próximo. Está separada del resto para poder testearla (estado.test.js).

/**
 * Un corte tal como viene en data/mantenimientos.json.
 * @typedef {{
 *   fecha: string, desde: string, hasta: string, zona: string,
 *   afectacion: 'parcial' | 'total' | null, fuente: string,
 *   barrios: string[], zonas?: string[], sinUbicar: string[]
 * }} Corte
 */

/**
 * Los lugares del mapa que toca un corte: sus barrios y sus zonas aproximadas (ej. "Zona rural Ruta 9 Norte").
 * Para la página son lo mismo: algo que se pinta y se puede tocar.
 * @param {Corte} corte
 */
export function lugaresDelCorte(corte) {
  return [...corte.barrios, ...(corte.zonas ?? [])];
}

/** @typedef {{ fecha: string, hora: string }} Momento  fecha AAAA-MM-DD y hora HH:MM, en hora de Córdoba */

/**
 * @typedef {{ cortes: Corte[], enCurso: boolean, total: boolean }} EstadoBarrio
 *   total: si algún corte del día es "en forma total"
 */

/**
 * Fecha y hora actuales en Córdoba, sin importar la zona horaria de quien abre la página.
 * @param {Date} [ahora]
 * @returns {Momento}
 */
export function momentoEnCordoba(ahora = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Cordoba',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(ahora)
      .map((p) => [p.type, p.value]),
  );
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

/**
 * @param {string} fecha AAAA-MM-DD
 * @param {number} dias
 */
export function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Los días que vale la pena ofrecer en el selector: hoy, mañana y cualquier día futuro con cortes.
 * @param {Corte[]} cortes
 * @param {string} hoy
 */
export function diasDisponibles(cortes, hoy) {
  const dias = new Set([hoy, sumarDias(hoy, 1)]);
  for (const c of cortes) if (c.fecha >= hoy) dias.add(c.fecha);
  return [...dias].sort();
}

/**
 * Para un día, qué barrios tienen cortes y cómo están. Un barrio puede tener varios cortes el mismo día.
 * @param {Corte[]} cortes
 * @param {string} fecha
 * @param {Momento} ahora
 * @returns {Map<string, EstadoBarrio>}
 */
export function estadoPorBarrio(cortes, fecha, ahora) {
  /** @type {Map<string, EstadoBarrio>} */
  const estados = new Map();
  for (const corte of cortes) {
    if (corte.fecha !== fecha) continue;
    for (const barrio of lugaresDelCorte(corte)) {
      const estado = estados.get(barrio) ?? { cortes: [], enCurso: false, total: false };
      estado.cortes.push(corte);
      estado.enCurso ||= estaEnCurso(corte, ahora);
      estado.total ||= corte.afectacion === 'total';
      estados.set(barrio, estado);
    }
  }
  return estados;
}

/**
 * @param {Corte} corte
 * @param {Momento} ahora
 */
export function estaEnCurso(corte, ahora) {
  return corte.fecha === ahora.fecha && corte.desde <= ahora.hora && ahora.hora < corte.hasta;
}

/**
 * El último corte que ya terminó y el próximo que todavía no terminó, para un barrio.
 * @param {Corte[]} cortes
 * @param {string} barrio
 * @param {Momento} ahora
 * @returns {{ ultimo: Corte | null, proximo: Corte | null }}
 */
export function historialDelBarrio(cortes, barrio, ahora) {
  const delBarrio = cortes
    .filter((c) => lugaresDelCorte(c).includes(barrio))
    .sort((a, b) => `${a.fecha} ${a.desde}`.localeCompare(`${b.fecha} ${b.desde}`));
  const termino = (/** @type {Corte} */ c) => `${c.fecha} ${c.hasta}` <= `${ahora.fecha} ${ahora.hora}`;
  return {
    ultimo: delBarrio.filter(termino).at(-1) ?? null,
    proximo: delBarrio.find((c) => !termino(c)) ?? null,
  };
}

/**
 * Los cortes de un día ordenados por horario, para la lista del panel.
 * @param {Corte[]} cortes
 * @param {string} fecha
 */
export function cortesDelDia(cortes, fecha) {
  return cortes.filter((c) => c.fecha === fecha).sort((a, b) => a.desde.localeCompare(b.desde));
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * "2026-10-31" → "sábado 31 de octubre"
 * @param {string} fecha
 */
export function fechaLarga(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/**
 * Etiqueta corta para los botones de día: "Hoy", "Mañana" o "Mar 3/11".
 * @param {string} fecha
 * @param {string} hoy
 */
export function etiquetaCorta(fecha, hoy) {
  if (fecha === hoy) return 'Hoy';
  if (fecha === sumarDias(hoy, 1)) return 'Mañana';
  const d = new Date(`${fecha}T12:00:00Z`);
  const dia = DIAS_CORTOS[d.getUTCDay()];
  return `${dia.charAt(0).toUpperCase()}${dia.slice(1)} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

/**
 * ¿En qué barrio cae un punto (por ejemplo, la ubicación del GPS)? Devuelve el nombre o null.
 * Usa el método del "rayo": se traza una línea horizontal desde el punto y se cuentan los bordes que cruza;
 * si son impares, el punto está adentro. Respeta los huecos de los polígonos.
 * @param {{ properties: { nombre: string | null }, geometry: { type: string, coordinates?: any } }[]} barrios
 * @param {[number, number]} punto [longitud, latitud], el orden que usa GeoJSON
 */
export function barrioEnPunto(barrios, punto) {
  for (const barrio of barrios) {
    const { type, coordinates } = barrio.geometry;
    /** @type {number[][][][]} */
    const poligonos = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : [];
    const adentro = poligonos.some(([borde, ...huecos]) => dentroDelAnillo(borde, punto) && !huecos.some((h) => dentroDelAnillo(h, punto)));
    if (adentro && barrio.properties.nombre) return barrio.properties.nombre;
  }
  return null;
}

/** @param {number[][]} anillo @param {[number, number]} punto */
function dentroDelAnillo(anillo, [x, y]) {
  let adentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) adentro = !adentro;
  }
  return adentro;
}

/**
 * Etiqueta larga del día: "Hoy · sábado 31 de octubre", "Mañana · …" o solo la fecha.
 * @param {string} fecha
 * @param {string} hoy
 */
export function etiquetaDia(fecha, hoy) {
  if (fecha === hoy) return `Hoy · ${fechaLarga(fecha)}`;
  if (fecha === sumarDias(hoy, 1)) return `Mañana · ${fechaLarga(fecha)}`;
  return fechaLarga(fecha).replace(/^./, (l) => l.toUpperCase());
}

/**
 * Cuánto pasó desde un momento, para los reportes de vecinos: "recién", "hace 5 min", "hace 2 h".
 * @param {number} momento milisegundos (Date.now())
 * @param {number} [ahora]
 */
export function hace(momento, ahora = Date.now()) {
  const minutos = Math.max(0, Math.round((ahora - momento) / 60_000));
  if (minutos < 1) return 'recién';
  if (minutos < 60) return `hace ${minutos} min`;
  return `hace ${Math.floor(minutos / 60)} h`;
}

/** Para comparar nombres sin importar tildes ni mayúsculas: 'Argüello' → 'arguello'. @param {string} texto */
export const simplificar = (texto) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Las sugerencias del buscador mientras se escribe, de mejor a peor: el nombre exacto, los que empiezan con lo
 * escrito, los que tienen una palabra que empieza así ('alb' → 'Alto Alberdi') y los que lo contienen en el medio.
 * @param {string[]} nombres @param {string} texto @param {number} [maximo]
 */
export function sugerencias(nombres, texto, maximo = 8) {
  const buscado = simplificar(texto);
  if (!buscado) return [];
  /** @param {string} nombre */
  const puntaje = (nombre) => {
    const s = simplificar(nombre);
    if (s === buscado) return 0;
    if (s.startsWith(buscado)) return 1;
    if (s.split(/[^a-z0-9]+/).some((palabra) => palabra.startsWith(buscado))) return 2;
    return s.includes(buscado) ? 3 : null;
  };
  return nombres
    .flatMap((nombre) => {
      const p = puntaje(nombre);
      return p === null ? [] : [{ nombre, p }];
    })
    .sort((a, b) => a.p - b.p || a.nombre.localeCompare(b.nombre, 'es'))
    .slice(0, maximo)
    .map((s) => s.nombre);
}

/**
 * Dónde aparece lo buscado dentro del nombre, para resaltarlo: [desde, hasta], o null.
 * @param {string} nombre @param {string} texto
 * @returns {[number, number] | null}
 */
export function posicionCoincidencia(nombre, texto) {
  const buscado = simplificar(texto);
  const s = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Si quitar tildes cambió el largo, las posiciones no coinciden con el nombre original: no resaltamos.
  if (!buscado || s.length !== nombre.length) return null;
  const desde = s.indexOf(buscado);
  return desde < 0 ? null : [desde, desde + buscado.length];
}

/**
 * El texto para compartir un barrio (WhatsApp u otra app): si tiene cortes ese día, con sus horarios.
 * @param {string} barrio @param {Corte[]} delDia los cortes del barrio ese día @param {string} dia @param {string} hoy
 * @param {number} [vecinos] cuántos vecinos reportan que no tienen luz (solo cuenta si el día es hoy)
 */
export function textoParaCompartir(barrio, delDia, dia, hoy, vecinos = 0) {
  const lineas = delDia.length > 0
    ? [
      `⚡ Corte de luz programado en ${barrio}`,
      `📅 ${etiquetaDia(dia, hoy)}`,
      ...delDia.map((c) => `🕗 De ${c.desde} a ${c.hasta}${c.afectacion ? ` (${c.afectacion})` : ''}`),
    ]
    : [`✅ Sin cortes de luz programados en ${barrio}`, `📅 ${etiquetaDia(dia, hoy)}`];
  if (vecinos > 0 && dia === hoy) lineas.push(`🔴 ${vecinos === 1 ? '1 vecino reporta' : `${vecinos} vecinos reportan`} que no tiene${vecinos === 1 ? '' : 'n'} luz`);
  return lineas.join('\n');
}
