import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveSimple, crearBuscadorDeBarrios, distancia, nombresDelTramo } from './nombres.ts';

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
