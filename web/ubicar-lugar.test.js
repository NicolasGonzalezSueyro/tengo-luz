import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clave, parecido } from './ubicar-lugar.js';

test('clave: sin tildes, sin "barrio", "loteo" ni la localidad entre paréntesis', () => {
  assert.equal(clave('Barrio Villa Corema'), 'villa corema');
  assert.equal(clave('Loteo Terranostra II (Córdoba)'), 'terranostra ii');
  assert.equal(clave('B° Sábato'), 'sabato');
});

test('parecido: igual, uno dentro del otro por palabras enteras, o nada', () => {
  assert.equal(parecido('VILLA COREMA', 'Villa Corema'), 3);
  assert.equal(parecido('Barrio Privado Los Cielos', 'Los Cielos'), 3);
  assert.equal(parecido('Los Cielos Etapa 2', 'Los Cielos'), 2);
  assert.equal(parecido('Cielos del Sur', 'Los Cielos'), 0);
  assert.equal(parecido('Colonia', 'Colón'), 0);
});
