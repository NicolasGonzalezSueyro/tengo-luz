import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplificarGeometria, simplificarLinea } from './simplificar.ts';

test('simplificarLinea saca los puntos en línea recta y los repetidos, y deja las esquinas', () => {
  // Una "L" de unos 1.000 m por lado, con puntos intermedios en línea y uno repetido.
  const linea: [number, number][] = [[-64.20, -31.40], [-64.195, -31.40], [-64.195, -31.40], [-64.19, -31.40], [-64.19, -31.405], [-64.19, -31.41]];
  assert.deepEqual(simplificarLinea(linea, 4), [[-64.20, -31.40], [-64.19, -31.40], [-64.19, -31.41]]);
});

test('simplificarLinea conserva una curva que se aparta más que la tolerancia', () => {
  const conPico: [number, number][] = [[-64.20, -31.40], [-64.195, -31.3999], [-64.19, -31.40]]; // el pico está a ~11 m
  assert.equal(simplificarLinea(conPico, 4).length, 3);
  assert.equal(simplificarLinea(conPico, 20).length, 2);
});

test('simplificarGeometria deja los polígonos cerrados y válidos, y no toca los puntos', () => {
  const cuadrado: [number, number][] = [[0, 0], [0.005, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0.005], [0, 0]];
  const { coordinates } = simplificarGeometria({ type: 'Polygon', coordinates: [cuadrado] }) as { coordinates: [number, number][][] };
  assert.deepEqual(coordinates[0], [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]);
  const punto = { type: 'Point', coordinates: [-64.2, -31.4] };
  assert.deepEqual(simplificarGeometria(punto), punto);
});
