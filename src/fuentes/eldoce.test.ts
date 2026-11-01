import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearNota } from './eldoce.ts';

// HTML reducido con las dos estructuras que vimos en notas reales de El Doce.
function nota(secciones: string, fechaTexto = 'sábado 31 de octubre'): string {
  return `
    <h1 class="article__title">Cortes de luz de Epec para este sábado en Córdoba</h1>
    <time dateTime="2026-10-30T21:39:01Z"><span>30 de octubre 2026, 18:39hs</span></time>
    <p>La <b>Epec</b> informó que este<b> ${fechaTexto} </b>habrá cortes de luz programados.</p>
    <p><b>+ MIRÁ MÁS: </b><b>Pronóstico para el fin de semana</b></p>
    <p><b>Cortes programados</b></p>
    ${secciones}
    <p>Noticias relacionadas</p>`;
}

// Formato "lista": <p><b>Ciudad</b></p> y un <li> por corte.
function conLista(ciudad: string, ...renglones: string[]): string {
  return `<p class="paragraph"><b>${ciudad}</b></p><ul class="list">${renglones
    .map((r) => `<li class="list__item"><span>${r}</span></li>`)
    .join('')}</ul>`;
}

// Formato "párrafos": la ciudad dentro de un <li> y cada corte en un <p> que empieza con guion o raya.
function conParrafos(ciudad: string, ...renglones: string[]): string {
  return `<ul class="list"><li class="list__item"><b>${ciudad}</b></li></ul>${renglones
    .map((r) => `<p class="paragraph">${r}</p>`)
    .join('')}`;
}

const SAN_FRANCISCO = conLista('San Francisco', 'De 07:30 a 10:30: barrio Roca, entre las calles 25 de mayo y Urquiza.');
const URL = 'https://eldoce.tv/actualidad/2026/10/30/cortes-de-luz-de-epec-para-este-sabado/';

test('formato lista: lee los cortes de cada localidad, con capital como "Córdoba"', () => {
  const html = nota(
    conLista(
      'Córdoba capital',
      'De 07:30 a 10:30: Barrio Argüello, en forma parcial.',
      'De 08:00 a 13:00: Sector comprendido por Camino 60 Cuadras, en forma total.',
    ) + SAN_FRANCISCO,
  );
  const { mantenimientos, noReconocidas } = parsearNota(html, URL);

  assert.deepEqual(noReconocidas, []);
  assert.deepEqual(mantenimientos, [
    { localidad: 'Córdoba', fecha: '2026-10-31', desde: '07:30', hasta: '10:30', zona: 'Barrio Argüello, en forma parcial.', afectacion: 'parcial', fuente: URL },
    { localidad: 'Córdoba', fecha: '2026-10-31', desde: '08:00', hasta: '13:00', zona: 'Sector comprendido por Camino 60 Cuadras, en forma total.', afectacion: 'total', fuente: URL },
    { localidad: 'San Francisco', fecha: '2026-10-31', desde: '07:30', hasta: '10:30', zona: 'barrio Roca, entre las calles 25 de mayo y Urquiza.', afectacion: null, fuente: URL },
  ]);
});

test('formato párrafos: título "Córdoba", guiones y horas sin minutos', () => {
  const html = nota(
    conParrafos('Córdoba', '-De 8 a 12:30: barrios La Favela y Villa Urquiza.', '–De 14 a 17: barrio Los Olmos.') +
      conParrafos('Villa Allende', '-De 13 a 13.20: barrios: Las Rosas, Español.'),
  );
  const { mantenimientos } = parsearNota(html, URL);
  assert.deepEqual(
    mantenimientos.map((m) => [m.localidad, m.desde, m.hasta, m.zona]),
    [
      ['Córdoba', '08:00', '12:30', 'barrios La Favela y Villa Urquiza.'],
      ['Córdoba', '14:00', '17:00', 'barrio Los Olmos.'],
      ['Villa Allende', '13:00', '13:20', 'barrios: Las Rosas, Español.'],
    ],
  );
});

test('"Otras localidades": el corte queda con esa sección y el texto nombra las localidades', () => {
  const html = nota(conLista('Otras localidades', 'De 06:30 a 06:45: Localidades de Alta Gracia y Los Aromos: barrios Don Bosco y Villa Oviedo.'));
  const [corte] = parsearNota(html, URL).mantenimientos;
  assert.equal(corte.localidad, 'Otras localidades');
  assert.match(corte.zona, /^Localidades de Alta Gracia/);
});

test('un renglón con dos horarios genera dos cortes', () => {
  const html = nota(conParrafos('Córdoba', '-De 6 a 7.30 y de 14 a 17: Barrio Argentino, en forma parcial.'));
  assert.deepEqual(
    parsearNota(html, URL).mantenimientos.map((m) => [m.desde, m.hasta]),
    [['06:00', '07:30'], ['14:00', '17:00']],
  );
});

test('acepta "hs" y dos puntos dentro de la zona', () => {
  const html = nota(conLista('Córdoba capital', 'De 8:30 a 12.30 hs: barrios: Centro y Alberdi.'));
  const [m] = parsearNota(html, URL).mantenimientos;
  assert.deepEqual([m.desde, m.hasta, m.zona], ['08:30', '12:30', 'barrios: Centro y Alberdi.']);
});

test('afectación: parcial, total, o null si no lo dice o mezcla las dos', () => {
  const html = nota(
    conLista(
      'Córdoba capital',
      'De 8 a 9: Barrio Centro, en forma total.',
      'De 8 a 9: Barrio Güemes.',
      'De 8 a 9: barrios San Clemente, en forma parcial y barrio La Amalia, en forma total.',
    ),
  );
  assert.deepEqual(parsearNota(html, URL).mantenimientos.map((m) => m.afectacion), ['total', null, null]);
});

test('ignora la fecha de publicación y usa la fecha de los cortes', () => {
  const html = nota(conLista('Córdoba capital', 'De 07:30 a 10:30: Barrio Güemes.'));
  assert.equal(parsearNota(html, URL).mantenimientos[0].fecha, '2026-10-31');
});

test('el primer día del mes puede venir con ordinal: "1° de noviembre"', () => {
  const html = nota(conLista('Córdoba capital', 'De 07:30 a 12:30: barrio Los Boulevares.'), 'domingo 1° de noviembre');
  const url = 'https://eldoce.tv/actualidad/2026/10/31/cortes-de-luz-de-epec-para-este-domingo/';
  assert.equal(parsearNota(html, url).mantenimientos[0].fecha, '2026-11-01');
  assert.equal(parsearNota(nota(conLista('Córdoba', 'De 8 a 9: barrio Centro.'), 'domingo 1º de noviembre'), url).mantenimientos[0].fecha, '2026-11-01');
});

test('una nota de fin de año puede anunciar cortes de enero del año siguiente', () => {
  const html = nota(conLista('Córdoba capital', 'De 07:30 a 10:30: Barrio Centro.'), 'jueves 1 de enero');
  const url = 'https://eldoce.tv/actualidad/2026/12/31/cortes-de-luz-de-epec-para-este-jueves/';
  assert.equal(parsearNota(html, url).mantenimientos[0].fecha, '2027-01-01');
});

test('falla si la fecha de los cortes no tiene sentido', () => {
  const html = nota(conLista('Córdoba capital', 'De 07:30 a 10:30: Barrio Centro.'), 'lunes 3 de agosto');
  assert.throws(() => parsearNota(html, URL), /no tiene sentido/);
});

test('decodifica caracteres especiales del HTML', () => {
  const html = nota(conLista('Córdoba capital', 'De 07:30 a 10:30: Barrio Alberdi &amp; Clínicas&nbsp;Sur.'));
  assert.equal(parsearNota(html, URL).mantenimientos[0].zona, 'Barrio Alberdi & Clínicas Sur.');
});

test('guarda aparte los renglones de capital que parecen cortes pero no entiende', () => {
  const html = nota(conLista('Córdoba capital', 'De 07:30 a 10:30: Barrio Centro.', 'Mañana de 8 a 9 en barrio Jardín.'));
  const { mantenimientos, noReconocidas } = parsearNota(html, URL);
  assert.equal(mantenimientos.length, 1);
  assert.deepEqual(noReconocidas, ['Mañana de 8 a 9 en barrio Jardín.']);
});

test('si no hay cortes en capital, devuelve solo los de otras localidades', () => {
  const { mantenimientos, noReconocidas } = parsearNota(nota(SAN_FRANCISCO), URL);
  assert.deepEqual(mantenimientos.map((m) => m.localidad), ['San Francisco']);
  assert.deepEqual(noReconocidas, []);
});

test('falla si la nota no tiene ningún corte reconocible (cambió el formato)', () => {
  assert.throws(() => parsearNota(nota('<p>Córdoba capital: de 8 a 12 en barrio Centro</p>'), URL), /cambió el formato/);
});
