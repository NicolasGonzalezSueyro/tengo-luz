// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barrioEnPunto, cortesDelDia, diasDisponibles, estadoPorBarrio, estaTerminado, etiquetaCorta, etiquetaDia, hace, historialDelBarrio,
  momentoEnCordoba, posicionCoincidencia, sugerencias, sumarDias, textoParaCompartir,
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

test('las zonas aproximadas cuentan como lugares del corte', () => {
  const conZona = { ...corte('2026-10-31', '08:00', '13:00', []), zonas: ['Zona rural Ruta 9 Norte'] };
  const estados = estadoPorBarrio([conZona], '2026-10-31', { fecha: '2026-10-30', hora: '20:00' });
  assert.deepEqual([...estados.keys()], ['Zona rural Ruta 9 Norte']);
  assert.equal(historialDelBarrio([conZona], 'Zona rural Ruta 9 Norte', { fecha: '2026-10-30', hora: '20:00' }).proximo, conZona);
});

test('historialDelBarrio sin cortes devuelve null', () => {
  assert.deepEqual(historialDelBarrio(CORTES, 'Centro', { fecha: '2026-10-31', hora: '11:00' }), { ultimo: null, proximo: null });
});

test('cortesDelDia ordena por horario', () => {
  assert.deepEqual(cortesDelDia(CORTES, '2026-10-31').map((c) => c.desde), ['07:30', '08:00', '14:30']);
});

test('etiquetaCorta para los botones de día', () => {
  assert.equal(etiquetaCorta('2026-10-30', '2026-10-30'), 'Hoy');
  assert.equal(etiquetaCorta('2026-10-31', '2026-10-30'), 'Mañana');
  assert.equal(etiquetaCorta('2026-11-03', '2026-10-30'), 'Mar 3/11');
});

// Dos barrios cuadrados de 10x10, uno de ellos con un hueco en el medio (como una plaza que no es parte del barrio).
const MAPA = [
  { properties: { nombre: 'Cuadrado' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } },
  {
    properties: { nombre: 'Con hueco' },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]], [[24, 4], [26, 4], [26, 6], [24, 6], [24, 4]]]],
    },
  },
];

test('barrioEnPunto encuentra el barrio que contiene el punto', () => {
  assert.equal(barrioEnPunto(MAPA, [5, 5]), 'Cuadrado');
  assert.equal(barrioEnPunto(MAPA, [21, 9]), 'Con hueco');
});

test('barrioEnPunto devuelve null fuera de los barrios o dentro de un hueco', () => {
  assert.equal(barrioEnPunto(MAPA, [15, 5]), null);
  assert.equal(barrioEnPunto(MAPA, [25, 5]), null);
});

test('etiquetaDia', () => {
  assert.equal(etiquetaDia('2026-10-30', '2026-10-30'), 'Hoy · viernes 30 de octubre');
  assert.equal(etiquetaDia('2026-10-31', '2026-10-30'), 'Mañana · sábado 31 de octubre');
  assert.equal(etiquetaDia('2026-11-03', '2026-10-30'), 'Martes 3 de noviembre');
});

test('hace', () => {
  const t = Date.UTC(2026, 9, 30, 15, 0);
  assert.equal(hace(t, t + 20_000), 'recién');
  assert.equal(hace(t, t + 5 * 60_000), 'hace 5 min');
  assert.equal(hace(t, t + 150 * 60_000), 'hace 2 h');
});

test('sugerencias: sin tildes, ordenadas de mejor a peor y con máximo', () => {
  const nombres = ['Alto Alberdi', 'Alberdi', 'Villa Alberdi Sur', 'Argüello', 'Barrio Jardín', 'Alta Córdoba'];
  assert.deepEqual(sugerencias(nombres, 'alberdi'), ['Alberdi', 'Alto Alberdi', 'Villa Alberdi Sur']);
  assert.deepEqual(sugerencias(nombres, 'ARGUE'), ['Argüello']);
  assert.deepEqual(sugerencias(nombres, 'al'), ['Alberdi', 'Alta Córdoba', 'Alto Alberdi', 'Villa Alberdi Sur']);
  assert.deepEqual(sugerencias(nombres, 'rdi'), ['Alberdi', 'Alto Alberdi', 'Barrio Jardín', 'Villa Alberdi Sur']);
  assert.deepEqual(sugerencias(nombres, 'al', 2), ['Alberdi', 'Alta Córdoba']);
  assert.deepEqual(sugerencias(nombres, '  '), []);
});

test('posicionCoincidencia marca lo buscado aunque tenga tildes', () => {
  assert.deepEqual(posicionCoincidencia('Alta Córdoba', 'cordo'), [5, 10]);
  assert.deepEqual(posicionCoincidencia('Alberdi', 'x'), null);
});

test('textoParaCompartir', () => {
  const corte = { fecha: '2026-10-31', desde: '08:00', hasta: '13:00', zona: '', afectacion: /** @type {const} */ ('parcial'), fuente: '', barrios: [], sinUbicar: [] };
  assert.equal(textoParaCompartir('Alberdi', [corte], '2026-10-31', '2026-10-30'),
    '⚡ Corte de luz programado en Alberdi\n📅 Mañana · sábado 31 de octubre\n🕗 De 08:00 a 13:00 (parcial)');
  assert.equal(textoParaCompartir('Centro', [], '2026-10-30', '2026-10-30', 2),
    '✅ Sin cortes de luz programados en Centro\n📅 Hoy · viernes 30 de octubre\n🔴 2 vecinos reportan que no tienen luz');
  // Los reportes son de 'ahora': mirando otro día no se mencionan.
  assert.doesNotMatch(textoParaCompartir('Centro', [], '2026-10-31', '2026-10-30', 2), /vecino/);
});

test('estaTerminado y el estado "terminado" de un barrio (todos sus cortes de hoy ya pasaron)', () => {
  /** @param {string} desde @param {string} hasta @param {string} barrio */
  const corte = (desde, hasta, barrio) => ({
    fecha: '2026-10-31', desde, hasta, zona: '', afectacion: null, fuente: '', barrios: [barrio], sinUbicar: [],
  });
  const ahora = { fecha: '2026-10-31', hora: '12:00' };
  assert.equal(estaTerminado(corte('08:00', '11:00', 'A'), ahora), true);
  assert.equal(estaTerminado(corte('08:00', '12:00', 'A'), ahora), true);
  assert.equal(estaTerminado(corte('11:00', '13:00', 'A'), ahora), false);
  assert.equal(estaTerminado(corte('22:00', '02:00', 'A'), ahora), false); // pasa la medianoche
  assert.equal(estaTerminado(corte('08:00', '11:00', 'A'), { fecha: '2026-11-01', hora: '12:00' }), false); // solo hoy

  const estados = estadoPorBarrio(
    [corte('07:00', '09:00', 'Alberdi'), corte('08:00', '10:00', 'Centro'), corte('14:00', '16:00', 'Centro')],
    '2026-10-31',
    ahora,
  );
  assert.equal(estados.get('Alberdi')?.terminado, true);
  assert.equal(estados.get('Centro')?.terminado, false); // le falta el de la tarde
});
