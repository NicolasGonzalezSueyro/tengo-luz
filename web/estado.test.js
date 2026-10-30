// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cortesDelDia, diasDisponibles, estadoPorBarrio, etiquetaDia, historialDelBarrio, momentoEnCordoba, sumarDias,
} from './estado.js';

/**
 * @param {string} fecha @param {string} desde @param {string} hasta @param {string[]} barrios
 * @param {'parcial' | 'total' | null} [afectacion]
 * @returns {import('./estado.js').Corte}
 */
function corte(fecha, desde, hasta, barrios, afectacion = 'parcial') {
  return { fecha, desde, hasta, zona: barrios.join(', '), afectacion, fuente: 'https://ejemplo', barrios, sinUbicar: [] };
}

const CORTES = [
  corte('2026-10-29', '08:00', '12:30', ['Villa General Urquiza']),
  corte('2026-10-31', '07:30', '10:30', ['Argüello']),
  corte('2026-10-31', '08:00', '13:00', ['Argüello', 'Alta Córdoba'], 'total'),
  corte('2026-10-31', '14:30', '18:30', ['San Lorenzo Sur']),
  corte('2026-11-03', '07:30', '11:30', ['Argüello']),
];

test('momentoEnCordoba usa la hora de Córdoba (UTC-3), no la de la compu', () => {
  assert.deepEqual(momentoEnCordoba(new Date('2026-10-31T02:30:00Z')), { fecha: '2026-10-30', hora: '23:30' });
});

test('sumarDias cruza fin de mes y de año', () => {
  assert.equal(sumarDias('2026-10-31', 1), '2026-11-01');
  assert.equal(sumarDias('2026-12-31', 1), '2027-01-01');
});

test('diasDisponibles: hoy, mañana y los días futuros con cortes, sin los pasados', () => {
  assert.deepEqual(diasDisponibles(CORTES, '2026-10-30'), ['2026-10-30', '2026-10-31', '2026-11-03']);
});

test('estadoPorBarrio junta los cortes de cada barrio en el día', () => {
  const estados = estadoPorBarrio(CORTES, '2026-10-31', { fecha: '2026-10-30', hora: '20:00' });
  assert.deepEqual([...estados.keys()].sort(), ['Alta Córdoba', 'Argüello', 'San Lorenzo Sur']);
  assert.equal(estados.get('Argüello')?.cortes.length, 2);
  assert.equal(estados.get('Argüello')?.total, true);
  assert.equal(estados.get('San Lorenzo Sur')?.total, false);
});

test('estadoPorBarrio marca "en curso" solo dentro del horario', () => {
  const durante = estadoPorBarrio(CORTES, '2026-10-31', { fecha: '2026-10-31', hora: '09:00' });
  assert.equal(durante.get('Argüello')?.enCurso, true);
  assert.equal(durante.get('San Lorenzo Sur')?.enCurso, false);
  const alTerminar = estadoPorBarrio(CORTES, '2026-10-31', { fecha: '2026-10-31', hora: '18:30' });
  assert.equal(alTerminar.get('San Lorenzo Sur')?.enCurso, false);
});

test('historialDelBarrio: último corte terminado y próximo pendiente', () => {
  const { ultimo, proximo } = historialDelBarrio(CORTES, 'Argüello', { fecha: '2026-10-31', hora: '11:00' });
  assert.equal(ultimo?.desde, '07:30'); // terminó a las 10:30
  assert.equal(proximo?.desde, '08:00'); // sigue en curso hasta las 13:00
});

test('historialDelBarrio sin cortes devuelve null', () => {
  assert.deepEqual(historialDelBarrio(CORTES, 'Centro', { fecha: '2026-10-31', hora: '11:00' }), { ultimo: null, proximo: null });
});

test('cortesDelDia ordena por horario', () => {
  assert.deepEqual(cortesDelDia(CORTES, '2026-10-31').map((c) => c.desde), ['07:30', '08:00', '14:30']);
});

test('etiquetaDia', () => {
  assert.equal(etiquetaDia('2026-10-30', '2026-10-30'), 'Hoy · viernes 30 de octubre');
  assert.equal(etiquetaDia('2026-10-31', '2026-10-30'), 'Mañana · sábado 31 de octubre');
  assert.equal(etiquetaDia('2026-11-03', '2026-10-30'), 'Martes 3 de noviembre');
});
