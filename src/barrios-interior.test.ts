import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { alRadio, enTitulo, km2 } from './barrios-interior.ts';

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