import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centro, crearUbicador, distanciaKm, encabezadoDelCorte, localidadesQueNombra, lugaresSeparados, normalizar, type Punto } from './barrios.ts';

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
    zonas: [],
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
    { barrios: ['Los Boulevares'], zonas: [], sinUbicar: ['comprendido por calle m p cabrera entre bv de los rusos y de los alemanes'] },
  );
});

test('una zona descripta solo por calles queda sin ubicar, entera', () => {
  assert.deepEqual(ubicar('Sector comprendido por calles Belgrano y Achával Rodríguez.'), {
    barrios: [],
    zonas: [],
    sinUbicar: ['sector comprendido por calles belgrano y achaval rodriguez'],
  });
});

const ZONAS = [
  { nombre: 'Zona rural Ruta 9 Norte', patron: String.raw`\bruta (nacional )?9\b.*\bnorte\b|\bruta 9 norte\b` },
  { nombre: 'Camino a 60 Cuadras (desde el Km 13)', patron: String.raw`\bcamino (a )?60 cuadras\b` },
];
const ubicarConZonas = crearUbicador(NOMBRES, {}, ZONAS);

test('una ruta conocida se asocia a su zona aproximada y deja de figurar como sin ubicar', () => {
  assert.deepEqual(ubicarConZonas('zona rural sobre Ruta Nacional 9 hacia el norte, en forma parcial.'), {
    barrios: [],
    zonas: ['Zona rural Ruta 9 Norte'],
    sinUbicar: [],
  });
  assert.deepEqual(ubicarConZonas('Sector comprendido por Camino 60 Cuadras, desde el Km. 13 en adelante, en forma total.'), {
    barrios: [],
    zonas: ['Camino a 60 Cuadras (desde el Km 13)'],
    sinUbicar: [],
  });
});

test('una ruta mencionada al pasar no se confunde con la zona (Ruta 9 hacia el sur no es "Ruta 9 Norte")', () => {
  assert.deepEqual(ubicarConZonas('Barrio Argüello, sobre Ruta 9 hacia el sur.').zonas, []);
});

test('"barrios:" con dos puntos', () => {
  assert.deepEqual(ubicar('barrios: Las Rosas, Español.').barrios, ['Las Rosas', 'Español']);
});

test('barrios cuyo nombre tiene " y " o "zona" no se parten', () => {
  assert.deepEqual(ubicar('Barrios Empalme Casas de Obreros y Empleados y Argüello.').barrios, [
    'Empalme Casas de Obreros y Empleados', 'Argüello',
  ]);
  assert.deepEqual(ubicar('Barrio Villa Cornú Zona Este, en forma parcial.'), { barrios: ['Villa Cornú Zona Este'], zonas: [], sinUbicar: [] });
});

test('ordinales escritos distinto: "2° Sección" y "2ª Sección"', () => {
  assert.deepEqual(ubicar('Barrio Santa Isabel 2° Sección.').barrios, ['Santa Isabel 2ª Sección']);
});

test('no repite un barrio nombrado dos veces', () => {
  assert.deepEqual(ubicar('Barrios Argüello y Argüello.').barrios, ['Argüello']);
});

test('un alias en null marca un nombre ambiguo que no se ubica solo', () => {
  const conAmbiguo = crearUbicador(NOMBRES, { 'Las Palmas': null });
  assert.deepEqual(conAmbiguo('Barrios Las Palmas y Argüello.'), { barrios: ['Argüello'], zonas: [], sinUbicar: ['las palmas'] });
});

test('falla si un alias apunta a un barrio que no existe', () => {
  assert.throws(() => crearUbicador(NOMBRES, { 'X': 'Barrio Inventado' }), /no está en el mapa/);
});

test('centro y distanciaKm', () => {
  assert.deepEqual(centro({ type: 'Point', coordinates: [-64.18, -31.42] }), [-64.18, -31.42]);
  assert.deepEqual(centro({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] }), [1, 1]);
  // Del centro de Córdoba a Villa Allende son unos 17 km en línea recta.
  const km = distanciaKm([-64.1833, -31.4167], [-64.2950, -31.2950]);
  assert.ok(km > 16 && km < 18, String(km));
});

test('lugaresSeparados avisa cuando un nombre repetido cae lejos del resto del corte', () => {
  const centros = new Map<string, Punto>([
    ['SMATA', [-64.2242, -31.455]],
    ['Manantiales', [-64.2314, -31.4538]],
    ['Horizonte', [-64.2067, -31.4584]],
    ['Los Manantiales (noroeste)', [-64.2424, -31.33975]],
  ]);
  assert.equal(lugaresSeparados(['SMATA', 'Manantiales', 'Horizonte'], centros), null);
  const separados = lugaresSeparados(['SMATA', 'Los Manantiales (noroeste)', 'Horizonte'], centros);
  assert.ok([separados?.a, separados?.b].includes('Los Manantiales (noroeste)'));
  assert.ok((separados?.km ?? 0) > 12);
  // Los lugares sin posición conocida no cuentan.
  assert.equal(lugaresSeparados(['SMATA', 'Desconocido'], centros), null);
});

test('localidadesQueNombra encuentra las de Gran Córdoba en el título o en el texto', () => {
  const localidades = [
    { nombre: 'Villa Carlos Paz', patron: String.raw`\bcarlos paz\b`, tipo: 'localidad' as const },
    { nombre: 'Alta Gracia', patron: String.raw`\balta gracia\b`, tipo: 'localidad' as const },
    { nombre: 'Malagueño', patron: String.raw`\bmalagueno\b`, tipo: 'localidad' as const },
  ];
  assert.deepEqual(localidadesQueNombra('Villa Carlos Paz Sector comprendido por calles Alberdi y Caseros.', localidades), ['Villa Carlos Paz']);
  assert.deepEqual(
    localidadesQueNombra('Otras localidades Localidades de Alta Gracia, Los Aromos y Malagueño: barrios Don Bosco.', localidades),
    ['Alta Gracia', 'Malagueño'],
  );
  assert.deepEqual(localidadesQueNombra('Río Cuarto Barrios Las Ferias y Pizarro.', localidades), []);
});

test('encabezadoDelCorte: la localidad sale del título o de lo que está antes de los dos puntos', () => {
  const localidades = [
    { nombre: 'Alta Gracia', patron: String.raw`\balta gracia\b`, tipo: 'localidad' as const },
    { nombre: 'Malagueño', patron: String.raw`\bmalagueno\b`, tipo: 'localidad' as const },
  ];
  const en = (seccion: string, zona: string) => localidadesQueNombra(encabezadoDelCorte(seccion, zona), localidades);
  assert.deepEqual(en('Otras localidades', 'Localidades de Alta Gracia y Los Aromos: barrios Don Bosco.'), ['Alta Gracia']);
  assert.deepEqual(en('Malagueño', 'Sector sobre Camino a Alta Gracia, desde el puente.'), ['Malagueño']); // el camino no cuenta
  assert.deepEqual(en('Otras localidades', 'Sector sobre calle Los Aromos.'), []);
});
