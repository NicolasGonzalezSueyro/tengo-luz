import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unir, type Mantenimiento } from './mantenimiento.ts';

function corte(fecha: string, desde: string, zona: string): Mantenimiento {
  return { fecha, desde, hasta: '12:00', zona, afectacion: null, fuente: 'https://ejemplo' };
}

test('conserva los días viejos y agrega los nuevos, ordenados', () => {
  const resultado = unir([corte('2026-10-30', '08:00', 'Centro')], [corte('2026-10-31', '07:00', 'Güemes')]);
  assert.deepEqual(resultado.map((m) => m.fecha), ['2026-10-30', '2026-10-31']);
});

test('si llega info nueva de un día, reemplaza la vieja de ese día', () => {
  const anteriores = [corte('2026-10-31', '08:00', 'Centro'), corte('2026-10-31', '09:00', 'Alberdi')];
  const resultado = unir(anteriores, [corte('2026-10-31', '08:00', 'Centro')]);
  assert.deepEqual(resultado.map((m) => m.zona), ['Centro']);
});

test('no duplica cortes repetidos', () => {
  const resultado = unir([], [corte('2026-10-31', '08:00', 'Centro'), corte('2026-10-31', '08:00', 'Centro')]);
  assert.equal(resultado.length, 1);
});
