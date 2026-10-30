// @ts-check
// Lógica de la página que no depende del mapa: qué barrios tienen cortes un día, en qué estado están,
// cuál fue el último y cuál es el próximo. Está separada del resto para poder testearla (estado.test.js).

/**
 * Un corte tal como viene en data/mantenimientos.json.
 * @typedef {{
 *   fecha: string, desde: string, hasta: string, zona: string,
 *   afectacion: 'parcial' | 'total' | null, fuente: string,
 *   barrios: string[], sinUbicar: string[]
 * }} Corte
 */

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
    for (const barrio of corte.barrios) {
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
    .filter((c) => c.barrios.includes(barrio))
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

/**
 * Etiqueta para el selector de día: "Hoy · sábado 31 de octubre", "Mañana · …" o solo la fecha.
 * @param {string} fecha
 * @param {string} hoy
 */
export function etiquetaDia(fecha, hoy) {
  if (fecha === hoy) return `Hoy · ${fechaLarga(fecha)}`;
  if (fecha === sumarDias(hoy, 1)) return `Mañana · ${fechaLarga(fecha)}`;
  return fechaLarga(fecha).replace(/^./, (l) => l.toUpperCase());
}
