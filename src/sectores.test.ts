import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarSector, esquinas, nucleoDeCalle, piezasDelTexto, sinPuntosSueltos, type Caja } from './sectores.ts';

test('sinPuntosSueltos descarta una esquina lejana con el mismo nombre de calles', () => {
  // Cuatro esquinas del centro (a ~100 m entre sí) y una "Belgrano y Florida" a 4 km.
  const centro: [number, number][] = [[-64.500, -31.420], [-64.499, -31.420], [-64.499, -31.419], [-64.500, -31.419]];
  const lejana: [number, number] = [-64.520, -31.390];
  assert.deepEqual(sinPuntosSueltos([...centro, lejana]), centro);
  // Con dos puntos ("calle X entre A y B") no hay forma de saber cuál sobra: quedan los dos.
  assert.deepEqual(sinPuntosSueltos([centro[0], lejana]), [centro[0], lejana]);
});

test('piezasDelTexto separa calles, lugares y barrios de textos reales de EPEC', () => {
  assert.deepEqual(piezasDelTexto('Sector comprendido por calles Alberdi, Caseros, Alvear, Miguel Juárez, San Martín y Avenida General Paz.'), {
    calles: ['Alberdi', 'Caseros', 'Alvear', 'Miguel Juárez', 'San Martín', 'Avenida General Paz'], lugares: [], barrios: [],
  });
  assert.deepEqual(
    piezasDelTexto('Sector comprendido por Edificio Stefano IV, Teatro del Lago, Terminal de Ómnibus y calles Alvear, Belgrano, Maipú y Florida.'),
    { calles: ['Alvear', 'Belgrano', 'Maipú', 'Florida'], lugares: ['Edificio Stefano IV', 'Teatro del Lago', 'Terminal de Ómnibus'], barrios: [] },
  );
  assert.deepEqual(piezasDelTexto('Localidades de Alta Gracia, Los Aromos y Cooperativa Serranita: barrios Don Bosco, Villa Oviedo y Las Tres Marías.'), {
    calles: [], lugares: [], barrios: ['Don Bosco', 'Villa Oviedo', 'Las Tres Marías'],
  });
  assert.deepEqual(piezasDelTexto('Barrio Los Boulevares, comprendido por calle M. P. Cabrera entre Bv. de los Rusos y de los Alemanes.').calles, [
    'M. P. Cabrera', 'Bv. de los Rusos', 'de los Alemanes',
  ]);
  // El texto real, con coma antes del "entre".
  assert.deepEqual(
    piezasDelTexto('Barrio Los Boulevares, comprendido por calle M. P. Cabrera, entre Bv. De los Rusos y De los Alemanes, en forma parcial.'),
    { calles: ['M. P. Cabrera', 'Bv. De los Rusos', 'De los Alemanes'], lugares: [], barrios: ['Los Boulevares'] },
  );
  assert.deepEqual(piezasDelTexto('Sector comprendido por calle Guardias Nacionales al 1380.').calles, ['Guardias Nacionales']);
  assert.deepEqual(piezasDelTexto('corte total en la localidad'), { calles: [], lugares: [], barrios: [] });
});

test('nucleoDeCalle saca "Avenida", "Bv." e iniciales', () => {
  assert.equal(nucleoDeCalle('Avenida General Paz'), 'general paz');
  assert.equal(nucleoDeCalle('Bv. de los Rusos'), 'los rusos');
  assert.equal(nucleoDeCalle('de los Alemanes'), 'los alemanes');
  assert.equal(nucleoDeCalle('M. P. Cabrera'), 'cabrera');
  assert.equal(nucleoDeCalle('Miguel Juárez'), 'miguel juarez');
});

test('esquinas encuentra dónde se cruzan calles distintas', () => {
  // Una cuadrícula: dos calles horizontales y dos verticales forman 4 esquinas.
  const calles = new Map<string, [number, number][][]>([
    ['norte', [[[0, 1], [3, 1]]]],
    ['sur', [[[0, 0], [3, 0]]]],
    ['oeste', [[[1, -1], [1, 2]]]],
    ['este', [[[2, -1], [2, 2]]]],
  ]);
  const puntos = esquinas(calles).map(([x, y]) => `${x},${y}`).sort();
  assert.deepEqual(puntos, ['1,0', '1,1', '2,0', '2,1']);
});

test('esquinas cuenta las T: una calle que termina a pocos metros de otra sin tocarla', () => {
  // Una avenida horizontal y una calle que baja y termina ~5 m antes de llegar (0,00005° de latitud).
  const calles = new Map<string, [number, number][][]>([
    ['avenida', [[[-64.21, -31.34], [-64.20, -31.34]]]],
    ['calle', [[[-64.205, -31.33], [-64.205, -31.33995]]]],
  ]);
  assert.deepEqual(esquinas(calles), [[-64.205, -31.33995]]);
  // A 200 m ya no es esquina.
  const lejos = new Map<string, [number, number][][]>([...calles, ['calle', [[[-64.205, -31.33], [-64.205, -31.338]]]]]);
  assert.deepEqual(esquinas(lejos), []);
});

test('armarSector dibuja el área de las esquinas, o null si no aporta', () => {
  const caja: Caja = [-31.45, -64.52, -31.38, -64.45]; // unos 7 km de lado
  const manzana: [number, number][] = [[-64.50, -31.42], [-64.499, -31.42], [-64.499, -31.419], [-64.50, -31.419]];
  const sector = armarSector(manzana, [], [], caja);
  assert.ok(sector && sector.length > 4);
  assert.deepEqual(sector?.[0], sector?.at(-1)); // cerrado, como pide GeoJSON
  assert.equal(armarSector([], [], [], caja), null);
  // Puntos en las cuatro puntas de la zona: el área sería casi toda la localidad, así que no sirve.
  assert.equal(armarSector([[-64.52, -31.45], [-64.45, -31.45], [-64.45, -31.38], [-64.52, -31.38]], [], [], caja), null);
});
