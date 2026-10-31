// @ts-check
// Eventos de calendario para un corte: un link para Google Calendar y un archivo .ics (el formato estándar
// que entienden el calendario del iPhone, los de Android y Outlook). Lo usan la página y functions/api/calendario.ts.

import { lugaresDelCorte, simplificar } from './estado.js';

/** @typedef {import('./estado.js').Corte} Corte */

/**
 * Pasa una fecha y hora de Córdoba a UTC en el formato de los calendarios (20261031T110000Z).
 * Córdoba está siempre en UTC-3: Argentina no tiene horario de verano desde 2009.
 * @param {string} fecha AAAA-MM-DD @param {string} hora HH:MM
 */
function aUtc(fecha, hora) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const [horas, minutos] = hora.split(':').map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia, horas + 3, minutos));
}
/** @param {Date} momento */
const formatoCalendario = (momento) => momento.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Inicio y fin del corte en UTC. Si termina "antes" de empezar, es que pasa la medianoche. @param {Corte} corte */
export function horarioUtc(corte) {
  const inicio = aUtc(corte.fecha, corte.desde);
  let fin = aUtc(corte.fecha, corte.hasta);
  if (fin <= inicio) fin = new Date(fin.getTime() + 24 * 60 * 60 * 1000);
  return [formatoCalendario(inicio), formatoCalendario(fin)];
}

/** "Alberdi", o "Alberdi, Centro y 3 más" si el corte toca varios lugares. @param {Corte} corte @param {string | null} lugar */
function donde(corte, lugar) {
  if (lugar) return lugar;
  const lugares = lugaresDelCorte(corte);
  if (lugares.length <= 3) return lugares.join(', ');
  return `${lugares.slice(0, 2).join(', ')} y ${lugares.length - 2} más`;
}

/** @param {Corte} corte @param {string | null} lugar */
export function tituloDelEvento(corte, lugar) {
  const lugares = donde(corte, lugar);
  return lugares ? `⚡ Corte de luz en ${lugares}` : '⚡ Corte de luz programado';
}

/** @param {Corte} corte @param {string | null} lugar @param {string} sitio la dirección del sitio */
function detalleDelEvento(corte, lugar, sitio) {
  return [
    corte.zona,
    corte.afectacion && `Afectación: ${corte.afectacion}.`,
    `Anuncio: ${corte.fuente}`,
    `Mapa: ${lugar ? `${sitio}/?barrio=${encodeURIComponent(lugar)}` : sitio}`,
    '¿Tengo luz? es un sitio no oficial.',
  ].filter(Boolean).join('\n');
}

/** Link que abre Google Calendar con el evento ya completo. @param {Corte} corte @param {string | null} lugar @param {string} sitio */
export function linkGoogleCalendar(corte, lugar, sitio) {
  const datos = new URLSearchParams({
    action: 'TEMPLATE',
    text: tituloDelEvento(corte, lugar),
    dates: horarioUtc(corte).join('/'),
    details: detalleDelEvento(corte, lugar, sitio),
    location: lugar ? `${lugar}, Córdoba` : 'Córdoba',
  });
  return `https://calendar.google.com/calendar/render?${datos}`;
}

/** Escapa un texto para el formato .ics: barras, comas, punto y coma y saltos de línea. @param {string} texto */
const escapar = (texto) => texto.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');

/**
 * El formato .ics pide renglones de hasta 75 bytes: los más largos se cortan y siguen en el renglón
 * de abajo empezando con un espacio. Se corta por bytes (no por letras) para no partir una tilde a la mitad.
 * @param {string} renglon
 */
function plegar(renglon) {
  const partes = [];
  let actual = '';
  for (const letra of renglon) {
    const limite = partes.length === 0 ? 75 : 74; // los renglones de continuación ya usan 1 byte en el espacio
    if (new TextEncoder().encode(actual + letra).length > limite) {
      partes.push(actual);
      actual = '';
    }
    actual += letra;
  }
  partes.push(actual);
  return partes.join('\r\n ');
}

/**
 * El archivo .ics del corte, con dos recordatorios: la noche anterior a las 20 h y una hora antes.
 * @param {Corte} corte @param {string | null} lugar @param {string} sitio @param {Date} [ahora]
 */
export function archivoIcs(corte, lugar, sitio, ahora = new Date()) {
  const [inicio, fin] = horarioUtc(corte);
  const nocheAnterior = new Date(aUtc(corte.fecha, '20:00').getTime() - 24 * 60 * 60 * 1000);
  const id = simplificar(`${corte.fecha} ${corte.desde} ${corte.hasta} ${lugar ?? corte.zona}`).replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const titulo = tituloDelEvento(corte, lugar);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//tengo-luz//Cortes de luz en Cordoba//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${id}@tengo-luz.pages.dev`,
    `DTSTAMP:${formatoCalendario(ahora)}`,
    `DTSTART:${inicio}`,
    `DTEND:${fin}`,
    `SUMMARY:${escapar(titulo)}`,
    `DESCRIPTION:${escapar(detalleDelEvento(corte, lugar, sitio))}`,
    `LOCATION:${escapar(lugar ? `${lugar}, Córdoba` : 'Córdoba')}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapar(`Mañana: ${titulo} de ${corte.desde} a ${corte.hasta}`)}`,
    `TRIGGER;VALUE=DATE-TIME:${formatoCalendario(nocheAnterior)}`,
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapar(`En una hora: ${titulo}`)}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].map(plegar).join('\r\n') + '\r\n';
}
