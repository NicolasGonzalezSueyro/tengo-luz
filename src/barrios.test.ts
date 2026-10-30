import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearUbicador, normalizar } from './barrios.ts';

// Un mapa chiquito con nombres reales de data/barrios.geojson.
const NOMBRES = [
  'Los Paraísos', 'Alta Córdoba', 'Argüello', 'Los Boulevares', 'San Lorenzo Sur', 'Jardín del Sud',
  'Las Palmas', 'Mutual de los Docentes', 'Bº San Ignacio de Horizonte', 'Santa Isabel 2ª Sección',
  'Villa Cornú Zona Este', 'Empalme Casas de Obreros y Empleados', 'Las Rosas', 'Español',
];
const ubicar = crearUbicador(NOMBRES, { 'Mutual Docente': 'Mutual de los Docentes' });

test('normalizar: tildes, mayúsculas, símbolos, Sud/Sur y prefijos', () => {
  assert.equal(normalizar('Bº San Ignacio de Horizonte'), 'san ignacio horizonte');
  assert.equal(normalizar('Santa Isabel 2ª Sección'), 'santa isabel 2 seccion');
  assert.equal(normalizar('Loteo Jardín del Sud'), 'jardin sur');
  assert.equal(normalizar('  Barrio   ARGÜELLO. '), 'arguello');
});

test('normalizar: la misma forma para cómo escriben la Municipalidad, OSM y las notas', () => {
  const iguales = [
    ['San Lorenzo Sud', 'SAN LORENZO (S)'],
    ['Maipú 2ª Sección', 'MAIPU 2A SECCION'],
    ['Altos de San Martín', 'ALTOS SAN MARTIN'],
    ['Doctor Remo M. Copello', 'DR REMO M. COPELLO'],
    ['Nueva Córdoba Anexo', 'NUEVA CORDOBA ANEXA'],
    ['Liceo Gral. Paz', 'Liceo General Paz'],
  ];
  for (const [a, b] of iguales) assert.equal(normalizar(a), normalizar(b), `${a} ≠ ${b}`);
});

test('lista de barrios separada por comas e "y"', () => {
  assert.deepEqual(ubicar('Barrios Los Paraísos, San Martín Anexo y Alta Córdoba, en forma parcial.'), {
    barrios: ['Los Paraísos', 'Alta Córdoba'],
    sinUbicar: ['san martin anexo'],
  });
});

test('"Sud" en la nota y "Sur" en el mapa (y al revés) son el mismo barrio', () => {
  assert.deepEqual(ubicar('Barrio San Lorenzo Sud, en forma parcial.').barrios, ['San Lorenzo Sur']);
  assert.deepEqual(ubicar('Barrios Jardín del Sur y Las Palmas.').barrios, ['Jardín del Sud', 'Las Palmas']);
});

test('usa la tabla de alias y saca "Loteo"', () => {
  assert.deepEqual(ubicar('Barrios Loteo Mutual Docente, en forma parcial.').barrios, ['Mutual de los Docentes']);
});

test('corta la descripción por calles y la guarda aparte', () => {
  assert.deepEqual(
    ubicar('Barrio Los Boulevares, comprendido por calle M. P. Cabrera, entre Bv. De Los Rusos y De Los Alemanes, en forma parcial.'),
    { barrios: ['Los Boulevares'], sinUbicar: ['comprendido por calle m p cabrera entre bv de los rusos y de los alemanes'] },
  );
});

test('una zona descripta solo por calles queda sin ubicar, entera', () => {
  assert.deepEqual(ubicar('Sector comprendido por Camino 60 Cuadras, desde el Km. 13 en adelante, en forma total.'), {
    barrios: [],
    sinUbicar: ['sector comprendido por camino 60 cuadras desde el km 13 en adelante'],
  });
});

test('"barrios:" con dos puntos', () => {
  assert.deepEqual(ubicar('barrios: Las Rosas, Español.').barrios, ['Las Rosas', 'Español']);
});

test('barrios cuyo nombre tiene " y " o "zona" no se parten', () => {
  assert.deepEqual(ubicar('Barrios Empalme Casas de Obreros y Empleados y Argüello.').barrios, [
    'Empalme Casas de Obreros y Empleados', 'Argüello',
  ]);
  assert.deepEqual(ubicar('Barrio Villa Cornú Zona Este, en forma parcial.'), { barrios: ['Villa Cornú Zona Este'], sinUbicar: [] });
});

test('ordinales escritos distinto: "2° Sección" y "2ª Sección"', () => {
  assert.deepEqual(ubicar('Barrio Santa Isabel 2° Sección.').barrios, ['Santa Isabel 2ª Sección']);
});

test('no repite un barrio nombrado dos veces', () => {
  assert.deepEqual(ubicar('Barrios Argüello y Argüello.').barrios, ['Argüello']);
});

test('un alias en null marca un nombre ambiguo que no se ubica solo', () => {
  const conAmbiguo = crearUbicador(NOMBRES, { 'Las Palmas': null });
  assert.deepEqual(conAmbiguo('Barrios Las Palmas y Argüello.'), { barrios: ['Argüello'], sinUbicar: ['las palmas'] });
});

test('falla si un alias apunta a un barrio que no existe', () => {
  assert.throws(() => crearUbicador(NOMBRES, { 'X': 'Barrio Inventado' }), /no está en el mapa/);
});
