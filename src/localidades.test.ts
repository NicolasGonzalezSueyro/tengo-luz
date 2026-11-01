import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarManuales, crearUbicadorDeLocalidades, elegir, nombresDeLocalidades, type Candidato, type Localidad } from './localidades.ts';

// Los textos son renglones reales de las notas de El Doce.

test('nombresDeLocalidades: el título de la sección y las localidades que nombra el texto', () => {
  assert.deepEqual(nombresDeLocalidades('Villa María', 'barrio Centro, en forma parcial.'), ['Villa María']);
  assert.deepEqual(nombresDeLocalidades('Alta Gracia y Bosque Alegre', 'Campo de Barrandegui y Campo Lima.'), ['Alta Gracia', 'Bosque Alegre']);
  assert.deepEqual(
    nombresDeLocalidades('Río Ceballos', 'barrios El Cedro y Sábato. Localidad de Unquillo: barrios Loteo La Bancaria.'),
    ['Río Ceballos', 'Unquillo'],
  );
  // Un camino con nombre de pueblo no es un corte en ese pueblo.
  assert.deepEqual(nombresDeLocalidades('Malagueño', 'Sector sobre Camino a Alta Gracia, desde el puente.'), ['Malagueño']);
});

test('nombresDeLocalidades: si el corte empieza nombrando localidades, el título de la sección no cuenta', () => {
  // En la nota este renglón quedó bajo el título "Saldán", pero es de otra zona de la provincia.
  assert.deepEqual(nombresDeLocalidades('Saldán', 'Localidad de Colazo, James Craik y Las Junturas.'), ['Colazo', 'James Craik', 'Las Junturas']);
  assert.deepEqual(
    nombresDeLocalidades('Otras localidades', 'Localidades de Alta Gracia, Los Aromos, Cooperativa Serranita y Cooperativa Rancherita: barrios Don Bosco.'),
    ['Alta Gracia', 'Los Aromos'],
  );
  assert.deepEqual(nombresDeLocalidades('Río Cuarto', 'Localidad de Marcos Juárez y Cooperativa General Roca.'), ['Marcos Juárez']);
  assert.deepEqual(
    nombresDeLocalidades('Otras localidades', 'Localidad Parque Siquiman en forma parcial: calle las gemelas. Localidad Santa Cruz del Lago, barrios Lago Azul.'),
    ['Parque Siquiman', 'Santa Cruz del Lago'],
  );
  assert.deepEqual(nombresDeLocalidades('Otras localidades', 'En las localidades de Pampa Alta y San Clemente: Villa del Cóndor.'), ['Pampa Alta', 'San Clemente']);
  // "Lucio V. Mansilla" no corta la lista, y "zona rural desde…" o "Córdoba capital" no son localidades a buscar.
  assert.deepEqual(
    nombresDeLocalidades('Villa Nueva', 'Localidades de Quilino, Paraje Los Cadillos, Lucio V. Mansilla, El Tuscal y zona rural desde La Tosca hasta La Costa.'),
    ['Quilino', 'Los Cadillos', 'Lucio V Mansilla', 'El Tuscal'],
  );
  assert.deepEqual(nombresDeLocalidades('Villa Allende', 'barrios Lomas Sur y Barrio Norte I. Localidad de Córdoba capital: barrio Villa Cornú.'), ['Villa Allende']);
});

const candidato = (nombre: string, osm: string, rango: number, punto: [number, number]): Candidato =>
  ({ nombre, osm, tipo: rango <= 16 ? 'town' : 'hamlet', rango, punto, departamento: 'Prueba' });

// Tres "San Antonio" reales de la provincia y dos "La Paz".
const sanAntonio = [
  candidato('San Antonio', 'N1', 20, [-62.82, -31.51]), // San Justo
  candidato('San Antonio', 'N2', 20, [-65.08, -30.39]), // Cruz del Eje
  candidato('San Antonio', 'N3', 20, [-64.56, -30.62]), // Ischilín
];

test('elegir: con nombres repetidos gana el más cercano al resto del corte, o el claramente más grande', () => {
  assert.equal(elegir(sanAntonio, [-64.35, -30.42])?.osm, 'N3'); // cerca de Deán Funes
  assert.equal(elegir(sanAntonio), null); // sin referencia no se adivina
  assert.equal(elegir(sanAntonio, [-64.5, -30.21]), null); // desde Quilino el más cercano está a 47 km: ante la duda, no
  assert.equal(elegir([candidato('San Francisco', 'R1', 16, [-62.08, -31.42]), candidato('San Francisco', 'N9', 20, [-64, -31])])?.osm, 'R1');
  assert.equal(elegir([]), null);
});

test('crearUbicadorDeLocalidades: usa las del mapa, busca las nuevas una sola vez y las agrega', async () => {
  const cuadrado = (lon: number, lat: number) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.02, lat], [lon + 0.02, lat + 0.02], [lon, lat]]] });
  const zonas: Localidad[] = [
    { type: 'Feature', properties: { nombre: 'Villa Carlos Paz', tipo: 'localidad', patron: String.raw`\bcarlos paz\b`, descripcion: '', osm: 'R2284280' }, geometry: cuadrado(-64.5, -31.42) },
  ];
  const deanFunes = candidato('Deán Funes', 'R10', 16, [-64.35, -30.42]);
  const resultados: Record<string, Candidato[]> = { 'deán funes': [deanFunes], 'san antonio': sanAntonio, 'pueblo inventado': [] };
  const busquedas: string[] = [];
  const red = {
    buscar: async (nombre: string) => (busquedas.push(nombre), resultados[nombre.toLowerCase()] ?? []),
    geometria: async (c: Candidato) => cuadrado(...c.punto),
  };
  const buscadas: Record<string, Candidato[]> = {};
  const ubicar = crearUbicadorDeLocalidades(zonas, buscadas, red);

  assert.deepEqual(await ubicar(['Carlos Paz']), { localidades: ['Villa Carlos Paz'], noEncontradas: [] });
  assert.deepEqual(await ubicar(['Deán Funes', 'San Antonio', 'Pueblo inventado']), {
    localidades: ['Deán Funes', 'San Antonio'],
    noEncontradas: ['Pueblo inventado'],
  });
  assert.equal(zonas.find((z) => z.properties.nombre === 'San Antonio')?.properties.osm, 'N3'); // el de cerca de Deán Funes
  assert.match(zonas.find((z) => z.properties.nombre === 'San Antonio')!.properties.descripcion, /círculo/); // sin límite en OSM

  // La segunda vez no se busca de nuevo, y "San Antonio" solo (sin referencia) queda sin marcar.
  busquedas.length = 0;
  assert.deepEqual(await ubicar(['Deán Funes', 'Pueblo inventado']), { localidades: ['Deán Funes'], noEncontradas: [] });
  assert.deepEqual(await ubicar(['San Antonio']), { localidades: [], noEncontradas: [] });
  assert.deepEqual(busquedas, []);
  assert.equal(zonas.length, 3);
});

test('aplicarManuales: un pueblo cargado a mano con coordenadas de Google Maps se ubica, y las malas se avisan', async () => {
  const zonas: Localidad[] = [];
  const buscadas: Record<string, Candidato[]> = { 'mula muerta': [] }; // OpenStreetMap no lo encontró
  const manuales = { 'Mula Muerta': '-30.0123, -64.4567', 'La Tuna': '64.1, -31.2', 'Mal copiado': 'hola' };
  const { invalidas, cambiaron } = aplicarManuales(zonas, buscadas, manuales);
  assert.deepEqual(invalidas, ['La Tuna', 'Mal copiado']); // latitud y longitud al revés, y texto
  assert.equal(cambiaron, true);
  assert.equal(zonas[0].properties.nombre, 'Mula Muerta');
  assert.match(zonas[0].properties.descripcion, /se ubicó a mano/);

  const red = { buscar: async () => assert.fail('no tiene que buscar'), geometria: async () => assert.fail('ya tiene su círculo') };
  assert.deepEqual(await crearUbicadorDeLocalidades(zonas, buscadas, red)(['Mula Muerta']), { localidades: ['Mula Muerta'], noEncontradas: [] });
  // La corrida siguiente, con las mismas coordenadas, no cambia nada.
  assert.equal(aplicarManuales(zonas, buscadas, { 'Mula Muerta': '-30.0123, -64.4567' }).cambiaron, false);
  assert.equal(zonas.length, 1);
});

test('crearUbicadorDeLocalidades: una localidad a más de 80 km de las demás del corte no se marca', async () => {
  const lejos = candidato('Lejana', 'R20', 16, [-62, -33]);
  const cerca1 = candidato('Uno', 'R21', 16, [-64.5, -31.4]);
  const cerca2 = candidato('Dos', 'R22', 16, [-64.45, -31.35]);
  const resultados: Record<string, Candidato[]> = { lejana: [lejos], uno: [cerca1], dos: [cerca2] };
  const red = { buscar: async (n: string) => resultados[n.toLowerCase()], geometria: async () => ({ type: 'Polygon', coordinates: [] }) };
  const ubicar = crearUbicadorDeLocalidades([], {}, red);
  assert.deepEqual((await ubicar(['Uno', 'Dos', 'Lejana'])).localidades, ['Uno', 'Dos']);
});
