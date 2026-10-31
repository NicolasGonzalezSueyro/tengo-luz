import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corredor, envolventeConvexa } from './descargar-zonas.ts';

test('envolventeConvexa deja afuera los puntos interiores y cierra el contorno', () => {
  const contorno = envolventeConvexa([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [1, 0.5]]);
  assert.deepEqual(contorno[0], contorno.at(-1));
  assert.equal(contorno.length, 5); // 4 esquinas + el cierre
  assert.ok(!contorno.some(([x, y]) => x === 1 && y === 1));
});

test('corredor rodea la ruta con el ancho pedido', () => {
  // Una ruta recta de norte a sur en Córdoba, de 1 km.
  const ruta: [number, number][] = [[-64.18, -31.40], [-64.18, -31.409]];
  const contorno = corredor(ruta, 450);
  const lons = contorno.map((p) => p[0]);
  const lats = contorno.map((p) => p[1]);
  const anchoMetros = (Math.max(...lons) - Math.min(...lons)) * 111_320 * Math.cos((31.4 * Math.PI) / 180);
  assert.ok(Math.abs(anchoMetros - 900) < 20, `ancho ${anchoMetros}`);
  assert.ok(Math.min(...lats) < -31.409 && Math.max(...lats) > -31.40);
});
