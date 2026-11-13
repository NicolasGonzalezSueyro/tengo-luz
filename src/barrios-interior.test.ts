import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { alRadio, claveDeLugar, claveSinLocalidad, sinPedazosSueltos, enTitulo, km2, mismaLocalidad, sinEncimar, sinRepetidos, suavizar, unirMismoNombre } from './barrios-interior.ts';

test('enTitulo arregla los nombres en mayúsculas de las capas oficiales', () => {
  assert.equal(enTitulo('LAS MERCEDES (EX COLCAR)'), 'Las Mercedes');
  assert.equal(enTitulo('VILLA DEL LAGO'), 'Villa del Lago');
  assert.equal(enTitulo('MANANTIALES II'), 'Manantiales II');
  assert.equal(enTitulo('Barrio Norte'), 'Barrio Norte'); // ya viene bien escrito
});

test('alRadio recorta el casco al radio urbano oficial y lo deja igual si no hay radio o no se tocan', () => {
  const casco = turf.bboxPolygon([-64.50, -31.10, -64.40, -31.00]);
  const radio = turf.bboxPolygon([-64.50, -31.10, -64.45, -31.05]);
  const lejos = turf.bboxPolygon([-63.0, -32.0, -62.9, -31.9]);
  const recortado = alRadio(casco, [radio])!;
  assert.ok(Math.abs(km2(recortado) - km2(radio)) < 0.01);
  assert.equal(alRadio(casco, []), casco);
  assert.equal(alRadio(casco, [lejos]), casco);
  assert.equal(alRadio(null, [radio]), null);
});
test('sinRepetidos deja un barrio por lugar, el más confiable, y guarda el otro nombre como alias', () => {
  const b = (base: string, fuente: string, tipo = 'poligono') => ({ properties: { nombre: `${base} (Malagueño)`, base, localidad: 'Malagueño', tipo, fuente } });
  const lista = [b('Tejas 4', 'nominatim', 'aproximado'), b('Country Tejas Cuatro', 'osm'), b('La Perla', 'osm'), b('LA PERLA', 'municipio')];
  const quedan = sinRepetidos(lista);
  assert.deepEqual(quedan.map((x) => x.properties.base), ['Country Tejas Cuatro', 'LA PERLA']);
  assert.deepEqual((quedan[0].properties as { alias?: string[] }).alias, ['Tejas 4']);
  assert.equal(claveDeLugar('Country Tejas Cuatro'), claveDeLugar('Tejas 4 (Malagueño)'));
});

test('mismaLocalidad: iguales o uno es el comienzo del otro, pero no cualquier palabra en común', () => {
  assert.equal(mismaLocalidad('Villa Yacanto de Calamuchita', 'VILLA YACANTO'), true);
  assert.equal(mismaLocalidad('Malagueño', 'MALAGUEÑO'), true);
  assert.equal(mismaLocalidad('Pampa Alta', 'La Pampa'), false);
  assert.equal(mismaLocalidad('James Craik', 'JAMES CRAICK'), true);
  assert.equal(mismaLocalidad('Icho Cruz', 'VILLA RIO ICHO CRUZ'), true);
  assert.equal(mismaLocalidad('Cruz', 'La Cruz'), false); // una sola palabra: no
  assert.equal(mismaLocalidad('Villa Quilino', 'QUILINO'), false); // el Villa cuenta: son dos pueblos
  assert.equal(mismaLocalidad('La Paz', 'La Pez'), false); // cortos: no
});
test('sinRepetidos junta los que se escriben casi igual si están en el mismo lugar, no si están lejos', () => {
  const cuadrado = (x: number) => turf.bboxPolygon([x, -31.5, x + 0.01, -31.49]).geometry;
  const b = (base: string, x: number) => ({ type: 'Feature', geometry: cuadrado(x), properties: { nombre: base, base, localidad: 'Córdoba', tipo: 'poligono', fuente: 'osm' } });
  const quedan = sinRepetidos([b('Brisas de Manantiales', -64.2), b('Brisas de Manatiales', -64.2), b('Brisas de Manantiale', -63.5)]);
  assert.deepEqual(quedan.map((x) => x.properties.base), ['Brisas de Manantiales', 'Brisas de Manantiale']);
});
test('claveSinLocalidad: "El Talar de Mendiolaza" es "El Talar", "Villa Allende Centro" es "Centro"', () => {
  assert.equal(claveSinLocalidad('El Talar de Mendiolaza', 'Mendiolaza'), claveSinLocalidad('El Talar', 'Mendiolaza'));
  assert.equal(claveSinLocalidad('Villa Allende Centro', 'Villa Allende'), claveSinLocalidad('Centro', 'Villa Allende'));
  assert.equal(claveDeLugar('Las Cañitas Barrio Privado'), claveDeLugar('Las Cañitas'));
  assert.notEqual(claveSinLocalidad('Nuevo Malagueño', 'Malagueño'), claveSinLocalidad('Malagueño', 'Malagueño'));
});
test('sinRepetidos entre localidades: el mismo barrio en el mismo lugar se va la copia de capital', () => {
  const cuadrado = turf.bboxPolygon([-64.30, -31.32, -64.29, -31.31]).geometry;
  const b = (localidad: string, fuente: string) => ({ type: 'Feature', geometry: cuadrado, properties: { nombre: `San Remo (${localidad})`, base: 'San Remo', localidad, tipo: 'poligono', fuente } });
  assert.deepEqual(sinRepetidos([b('Córdoba', 'osm'), b('Saldán', 'osm')]).map((x) => x.properties.localidad), ['Saldán']);
  // Entre dos localidades del interior quedan los dos: EPEC puede nombrarlo en cualquiera.
  assert.deepEqual(sinRepetidos([b('Saldán', 'osm'), b('Villa Allende', 'municipio')]).map((x) => x.properties.localidad), ['Saldán', 'Villa Allende']);
});
test('sinRepetidos junta variantes de la misma localidad que se pisan ("Manuel Belgrano" y "Belgrano")', () => {
  const cuadrado = turf.bboxPolygon([-64.50, -31.42, -64.49, -31.41]).geometry;
  const b = (base: string) => ({ type: 'Feature', geometry: cuadrado, properties: { nombre: `${base} (Villa Carlos Paz)`, base, localidad: 'Villa Carlos Paz', tipo: 'poligono', fuente: 'osm' } });
  assert.equal(sinRepetidos([b('Manuel Belgrano'), b('Belgrano')]).length, 1);
  assert.equal(sinRepetidos([b('Costa Azul'), b('Villa Balnearia')]).length, 2); // nombres distintos: no
});

test('sinPedazosSueltos: saca pedacitos y pedazos lejanos fuera del municipio, deja los grandes de adentro', () => {
  const cuadro = (o: number, s: number, lado: number) => turf.bboxPolygon([o, s, o + lado, s + lado]).geometry.coordinates;
  const area = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [
    cuadro(-64.20, -31.30, 0.02), // principal (~4 km²)
    cuadro(-64.20, -31.25, 0.008), // lejos (5 km), grande (~0,6 km²) y dentro del municipio: queda
    cuadro(-64.10, -31.30, 0.008), // lejos, grande, pero fuera del municipio: se va
    cuadro(-64.175, -31.30, 0.001), // cerca, pero un pedacito (~0,01 km²): se va
  ] } } as never;
  const municipio = turf.bboxPolygon([-64.21, -31.31, -64.15, -31.20]);
  const quedan = turf.flatten(sinPedazosSueltos(area, municipio)).features.length;
  assert.equal(quedan, 2);
});

test('claveDeLugar completa abreviaturas y saca artículos: "Bv Horizonte" es "Boulevares de Horizonte"', () => {
  assert.equal(claveDeLugar('Bv Horizonte'), claveDeLugar('Boulevares de Horizonte'));
  assert.equal(claveDeLugar('Las Corzuelas'), claveDeLugar('Corzuelas'));
  assert.equal(claveDeLugar('Cooperativa 16 de Noviembre'), claveDeLugar('16 de Noviembre'));
  assert.notEqual(claveDeLugar('Alberdi'), claveDeLugar('Alto Alberdi'));
  assert.equal(claveDeLugar('La'), 'la'); // si todo son artículos, queda como está
});

test('suavizar rellena la entrada entre dos brazos y saca una tira fina', () => {
  const u = turf.union(turf.featureCollection([
    turf.bboxPolygon([-64.30, -31.40, -64.29, -31.37]), // brazo oeste
    turf.bboxPolygon([-64.28, -31.40, -64.27, -31.37]), // brazo este, a ~950 m
    turf.bboxPolygon([-64.30, -31.40, -64.27, -31.39]), // la base que los une
    turf.bboxPolygon([-64.27, -31.385, -64.25, -31.3845]), // tira de 55 m de ancho
  ]))!;
  const suave = suavizar(u as never);
  // La entrada de ~950 m de ancho no se rellena con 200 m (solo se redondean las esquinas)…
  assert.equal(turf.booleanPointInPolygon(turf.point([-64.285, -31.38]), suave), false);
  // …pero la tira fina desaparece.
  assert.equal(turf.booleanPointInPolygon(turf.point([-64.26, -31.3848]), suave), false);
  // Una entrada angosta (100 m) sí se rellena.
  const angosta = turf.union(turf.featureCollection([
    turf.bboxPolygon([-64.30, -31.40, -64.285, -31.37]),
    turf.bboxPolygon([-64.284, -31.40, -64.27, -31.37]),
    turf.bboxPolygon([-64.30, -31.40, -64.27, -31.39]),
  ]))!;
  assert.equal(turf.booleanPointInPolygon(turf.point([-64.2845, -31.38]), suavizar(angosta as never)), true);
});

test('unirMismoNombre junta los pedazos con el mismo nombre y deja los sin nombre', () => {
  const f = (nombre: string | null, x: number) => ({ type: 'Feature', properties: { nombre }, geometry: turf.bboxPolygon([x, -31.5, x + 0.01, -31.49]).geometry });
  const quedan = unirMismoNombre([f('Villa El Libertador', -64.2), f(null, -64.1), f('Villa El Libertador', -64.19), f(null, -64.0)]);
  assert.deepEqual(quedan.map((x) => x.properties.nombre), ['Villa El Libertador', null, null]);
  assert.ok(km2(quedan[0] as never) > 1.5 * km2(f('x', 0) as never));
});

test('sinEncimar: dos barrios que se pisan a medias dejan de pisarse; uno adentro de otro queda igual', () => {
  const b = (base: string, caja: [number, number, number, number], fuente: string, tipo = 'poligono') =>
    ({ type: 'Feature', geometry: turf.bboxPolygon(caja).geometry, properties: { nombre: base, base, localidad: 'La Calera', tipo, fuente } });
  // El oficial (oeste) y uno de OSM corrido al este, que lo pisa en un cuarto.
  const oficial = b('Centro', [-64.340, -31.350, -64.330, -31.340], 'municipio');
  const deOsm = b('Industrial', [-64.3325, -31.350, -64.3225, -31.340], 'osm');
  // Una parte del oficial, bien adentro.
  const parte = b('Centro Norte', [-64.338, -31.344, -64.334, -31.341], 'osm');
  const antes = km2(deOsm as never);
  sinEncimar([deOsm, oficial, parte]);
  assert.ok(Math.abs(km2(oficial as never) - 1.057) < 0.05); // el oficial no se toca
  assert.ok(km2(deOsm as never) < 0.8 * antes && km2(deOsm as never) > 0.7 * antes); // perdió el cuarto pisado
  assert.equal(turf.booleanIntersects(turf.point([-64.3315, -31.345]), deOsm as never), false);
  assert.ok(Math.abs(km2(parte as never) - 0.127) < 0.02); // la parte de adentro queda como estaba
});
