import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enTitulo } from './barrios-interior.ts';

test('enTitulo arregla los nombres en mayúsculas de las capas oficiales', () => {
  assert.equal(enTitulo('LAS MERCEDES (EX COLCAR)'), 'Las Mercedes');
  assert.equal(enTitulo('VILLA DEL LAGO'), 'Villa del Lago');
  assert.equal(enTitulo('MANANTIALES II'), 'Manantiales II');
  assert.equal(enTitulo('Barrio Norte'), 'Barrio Norte'); // ya viene bien escrito
});
