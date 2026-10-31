// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivoIcs, horarioUtc, linkGoogleCalendar, tituloDelEvento } from './calendario.js';

/** @type {import('./estado.js').Corte} */
const corte = {
  fecha: '2026-10-31', desde: '08:00', hasta: '13:00', zona: 'Barrios Alberdi, Centro y Güemes, en forma parcial.',
  afectacion: 'parcial', fuente: 'https://eldoce.tv/nota', barrios: ['Alberdi', 'Centro', 'Güemes', 'Paso de los Andes'], zonas: [], sinUbicar: [],
};
const SITIO = 'https://tengo-luz.pages.dev';

test('horarioUtc pasa la hora de Córdoba (UTC-3) a UTC, también si cruza la medianoche', () => {
  assert.deepEqual(horarioUtc(corte), ['20261031T110000Z', '20261031T160000Z']);
  assert.deepEqual(horarioUtc({ ...corte, desde: '22:00', hasta: '02:00' }), ['20261101T010000Z', '20261101T050000Z']);
});

test('tituloDelEvento nombra el barrio, o resume si son muchos', () => {
  assert.equal(tituloDelEvento(corte, 'Alberdi'), '⚡ Corte de luz en Alberdi');
  assert.equal(tituloDelEvento(corte, null), '⚡ Corte de luz en Alberdi, Centro y 2 más');
  assert.equal(tituloDelEvento({ ...corte, barrios: [] }, null), '⚡ Corte de luz programado');
});

test('linkGoogleCalendar arma el evento completo', () => {
  const link = new URL(linkGoogleCalendar(corte, 'Alberdi', SITIO));
  assert.equal(link.origin + link.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(link.searchParams.get('dates'), '20261031T110000Z/20261031T160000Z');
  assert.equal(link.searchParams.get('text'), '⚡ Corte de luz en Alberdi');
  assert.match(String(link.searchParams.get('details')), /Mapa: https:\/\/tengo-luz\.pages\.dev\/\?barrio=Alberdi/);
});

test('archivoIcs es un .ics válido: CRLF, escapes, renglones cortos y recordatorios', () => {
  const ics = archivoIcs(corte, 'Alberdi', SITIO, new Date(Date.UTC(2026, 9, 30, 12)));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /\n/); // solo saltos CRLF
  const desplegado = ics.replace(/\r\n /g, ''); // así lo lee un calendario
  assert.match(desplegado, /\r\nDTSTART:20261031T110000Z\r\nDTEND:20261031T160000Z\r\n/);
  assert.match(desplegado, /DESCRIPTION:Barrios Alberdi\\, Centro y Güemes\\, en forma parcial\.\\nAfectación: parcial\./);
  // Recordatorio a las 20 h de Córdoba del día anterior (23 h UTC) y otro una hora antes.
  assert.match(desplegado, /TRIGGER;VALUE=DATE-TIME:20261030T230000Z/);
  assert.match(desplegado, /TRIGGER:-PT1H/);
  for (const renglon of ics.split('\r\n')) assert.ok(new TextEncoder().encode(renglon).length <= 75, renglon);
});
