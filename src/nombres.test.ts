import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveSimple, crearBuscadorDeBarrios, distancia, nombresDelTramo } from './nombres.ts';
import { localidadesComoBarrios } from './localidades.ts';
import { completarNumeros } from './barrios.ts';

// Barrios reales de La Calera (OpenStreetMap) y de Villa María, y cómo los escribe EPEC en sus anuncios.
const barrio = (base: string, localidad: string) => ({ nombre: `${base} (${localidad})`, base, localidad });
const buscar = crearBuscadorDeBarrios([
  ...['Centro', 'Covico', 'Matadero', 'Minetti', 'Stoecklin', 'Doctor Cocca', 'Terrazas de Estanzuela', 'Los Prados', 'Los Prados II', 'Cerro Norte']
    .map((b) => barrio(b, 'La Calera')),
  ...['Centro', 'Valle Escondido', 'Bello Horizonte'].map((b) => barrio(b, 'Villa María')),
]);

test('nombresDelTramo: los nombres tal como vienen, sin descripciones', () => {
  assert.deepEqual(nombresDelTramo('Barrios Villa Corema, Buena Vista y La Quebrada, en forma parcial.'), ['Villa Corema', 'Buena Vista', 'La Quebrada']);
  assert.deepEqual(nombresDelTramo('barrio: Bello Horizonte, entre las calles: Cartagena y Universidad.'), ['Bello Horizonte']);
  assert.deepEqual(nombresDelTramo('Sector comprendido por calles Alberdi, Caseros y Alvear.'), []);
});

test('claveSimple y distancia', () => {
  assert.equal(claveSimple('Terrazas de la Estanzuela'), claveSimple('Terrazas de Estanzuela'));
  assert.equal(claveSimple('Minetti III'), claveSimple('Minetti 3'));
  assert.equal(claveSimple('Covicco'), claveSimple('Covico'));
  assert.equal(claveSimple('Mataderos'), claveSimple('Matadero'));
  assert.equal(distancia('estoecklin', 'stoecklin'), 1);
  assert.equal(claveSimple('Santa Isabel 2ª Sección'), claveSimple('santa isabel 2'));
  assert.equal(claveSimple('Parque Liceo 3ª Sección'), claveSimple('Parque Liceo III'));
});

test('reconoce los barrios aunque EPEC los escriba distinto, siempre dentro de la localidad del corte', () => {
  assert.deepEqual(
    buscar(['La Calera'], 'Barrios Centro, Covicco, Cerro Norte, Minetti III, Mataderos, Estoecklin, Dr. Cocca y Terrazas de la Estanzuela.').barrios,
    ['Centro (La Calera)', 'Covico (La Calera)', 'Cerro Norte (La Calera)', 'Minetti (La Calera)', 'Matadero (La Calera)',
      'Stoecklin (La Calera)', 'Doctor Cocca (La Calera)', 'Terrazas de Estanzuela (La Calera)'],
  );
  // El mismo nombre en otra localidad es otro barrio.
  assert.deepEqual(buscar(['Villa María'], 'barrio Centro, en forma parcial.').barrios, ['Centro (Villa María)']);
  assert.deepEqual(buscar(['Villa María'], 'barrio: Valle Escondido, entre las calles: Mary Amaya y Los Caldenes.').barrios, ['Valle Escondido (Villa María)']);
  // Si hay dos parecidos (Los Prados y Los Prados II), "Los Prados 1" no se adivina.
  assert.deepEqual(buscar(['La Calera'], 'Barrio Los Prados II.').barrios, ['Los Prados II (La Calera)']);
  // Lo que no está, se informa.
  assert.deepEqual(buscar(['La Calera'], 'Barrios IPV y Monoblock.').sinUbicar, ['IPV', 'Monoblock']);
});

test('un barrio que está en las dos localidades del anuncio se marca en las dos', () => {
  assert.deepEqual(buscar(['La Calera', 'Villa María'], 'barrios Centro y Covico.').barrios, ['Centro (La Calera)', 'Centro (Villa María)', 'Covico (La Calera)']);
});
test('los alias del interior reconocen cómo escribe EPEC un barrio que en el mapa tiene otro nombre', () => {
  const conAlias = crearBuscadorDeBarrios([barrio('Dos Hermanos', 'San Francisco')], {
    '2 Hermanos (San Francisco)': 'Dos Hermanos (San Francisco)',
    'Otro (Villa María)': 'Dos Hermanos (San Francisco)', // de otra localidad: no se usa
  });
  assert.deepEqual(conAlias(['San Francisco'], 'barrios 2 Hermanos.').barrios, ['Dos Hermanos (San Francisco)']);
  assert.deepEqual(conAlias(['Villa María'], 'barrio Otro.').barrios, []);
});
test('localidadesComoBarrios: la localidad nombrada como barrio de sí misma, y las que están adentro de otra', () => {
  const zona = (nombre: string, dentroDe?: string) => ({ type: 'Feature', properties: { nombre, tipo: 'localidad', patron: '', descripcion: '', ...(dentroDe ? { dentroDe } : {}) }, geometry: null }) as never;
  const buscarCon = crearBuscadorDeBarrios(localidadesComoBarrios([zona('Saldán'), zona('Villa Carlos Paz'), zona('Yocsina', 'Malagueño')]));
  assert.deepEqual(buscarCon(['Saldán'], 'barrio Villa Saldán.').barrios, ['Saldán']);
  assert.deepEqual(buscarCon(['Malagueño'], 'barrios Yocsina.').barrios, ['Yocsina']);
  assert.deepEqual(buscarCon(['Villa Carlos Paz'], 'barrio Carlos Paz 1.').barrios, []); // una línea, no la ciudad entera
});
test('un número suelto se completa con el nombre anterior ("Loteo Terranostra I y II")', () => {
  assert.deepEqual(completarNumeros(['Loteo Terranostra I', 'II']), ['Loteo Terranostra I', 'Loteo Terranostra II']);
  assert.deepEqual(completarNumeros(['Parque Liceo 1ª', ' 2ª', '3ª sección']), ['Parque Liceo 1ª', 'Parque Liceo 2ª', 'Parque Liceo 3ª sección']);
  assert.deepEqual(completarNumeros(['Alberdi', 'Centro']), ['Alberdi', 'Centro']); // sin números: no cambia nada
  assert.deepEqual(nombresDelTramo('Barrios Los Prados I y II, en forma parcial.'), ['Los Prados I', 'Los Prados II']);
});

test('un pedazo hecho solo de conectores no es un barrio ("en el" de "en el perímetro comprendido por…")', () => {
  assert.deepEqual(nombresDelTramo('barrio Hernández, en el perímetro comprendido por las calles: Güemes, Almafuerte, Roma y España.'), ['Hernández']);
});
