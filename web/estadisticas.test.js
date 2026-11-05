// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadisticas, estadisticasFallas, minutos } from './estadisticas.js';

/** @param {string} fecha @param {string} desde @param {string} hasta @param {string[]} barrios @param {object} [extra] */
const corte = (fecha, desde, hasta, barrios, extra = {}) => ({
  fecha, desde, hasta, zona: '', afectacion: /** @type {'parcial' | 'total' | null} */ (null), fuente: '', barrios, sinUbicar: [], ...extra,
});

test('minutos, también si el corte pasa la medianoche', () => {
  assert.equal(minutos(corte('2026-10-31', '08:00', '13:30', [])), 330);
  assert.equal(minutos(corte('2026-10-31', '22:00', '02:00', [])), 240);
});

test('estadisticas: totales, barrios con más cortes, días de la semana y franjas', () => {
  const e = estadisticas([
    corte('2026-10-30', '08:00', '12:00', ['Alberdi', 'Centro']), // viernes, mañana, 4 h
    corte('2026-10-31', '14:00', '16:00', ['Alberdi']), // sábado, tarde, 2 h
    corte('2026-10-31', '07:00', '08:00', [], { zonas: ['Villa Carlos Paz'], localidad: 'Villa Carlos Paz', afectacion: 'total' }), // 1 h
  ]);
  assert.equal(e.cortes, 3);
  assert.equal(e.dias, 2);
  assert.equal(e.desde, '2026-10-30');
  assert.equal(e.horas, 7);
  assert.equal(e.lugaresAfectados, 3);
  assert.equal(e.duracionMediana, 120);
  assert.equal(e.totales, 1);
  assert.equal(e.granCordoba, 1);
  assert.deepEqual(e.masAfectados[0], { nombre: 'Alberdi', cortes: 2, minutos: 360 });
  assert.deepEqual(e.porDia.map((d) => d.cortes), [0, 0, 0, 0, 1, 2, 0]);
  assert.deepEqual(e.porFranja.map((f) => f.cortes), [0, 2, 1, 0]);
});

test('estadisticas sin cortes no se rompe', () => {
  const e = estadisticas([]);
  assert.equal(e.cortes, 0);
  assert.equal(e.desde, null);
  assert.equal(e.duracionMediana, 0);
  assert.deepEqual(e.masAfectados, []);
});

test('estadisticasFallas: cantidad, horas, lugares y franja horaria (en hora de Córdoba)', () => {
  const hora = 60 * 60 * 1000;
  const nueve = Date.parse('2026-11-01T09:00:00-03:00');
  const e = estadisticasFallas([
    { lugares: ['Centro', 'Alberdi'], creado: nueve, hasta: nueve + 2 * hora }, // mañana, 2 h
    { lugares: ['Centro'], creado: nueve + 10 * hora, hasta: nueve + 16 * hora }, // 19 h → noche; sigue activa
  ], nueve + 11 * hora);
  assert.equal(e.cortes, 2);
  assert.equal(e.horas, 3); // 2 h de la primera + 1 h de la que sigue (hasta "ahora")
  assert.equal(e.lugaresAfectados, 2);
  assert.deepEqual(e.masAfectados[0], { nombre: 'Centro', cortes: 2, minutos: 180 });
  assert.deepEqual(e.porFranja.map((f) => f.cortes), [0, 1, 0, 1]);
  assert.equal(estadisticasFallas([]).cortes, 0);
});
