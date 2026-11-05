// @ts-check
// Los números de la página de estadísticas, calculados del historial de cortes (data/mantenimientos.json).
// Solo cálculos, sin nada de la página, para poder probarlos (estadisticas.test.js).

import { lugaresDelCorte } from './estado.js';

/** @typedef {import('./estado.js').Corte} Corte */

/** Duración de un corte en minutos (si pasa la medianoche, termina al día siguiente). @param {Corte} c */
export function minutos(c) {
  const [hd, md] = c.desde.split(':').map(Number);
  const [hh, mh] = c.hasta.split(':').map(Number);
  const duracion = hh * 60 + mh - (hd * 60 + md);
  return duracion > 0 ? duracion : duracion + 24 * 60;
}

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const FRANJAS = [
  { nombre: 'Madrugada (0 a 6 h)', hasta: 6 },
  { nombre: 'Mañana (6 a 12 h)', hasta: 12 },
  { nombre: 'Tarde (12 a 18 h)', hasta: 18 },
  { nombre: 'Noche (18 a 24 h)', hasta: 24 },
];

/** @param {number[]} valores */
const mediana = (valores) => {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 ? ordenados[medio] : (ordenados[medio - 1] + ordenados[medio]) / 2;
};

/**
 * Todo lo que muestra la página. Cada corte del historial cuenta una vez por cada horario anunciado.
 * @param {Corte[]} cortes
 */
export function estadisticas(cortes) {
  const fechas = [...new Set(cortes.map((c) => c.fecha))].sort();

  /** @type {Map<string, { cortes: number, minutos: number }>} */
  const porLugar = new Map();
  for (const c of cortes) {
    for (const lugar of lugaresDelCorte(c)) {
      const actual = porLugar.get(lugar) ?? { cortes: 0, minutos: 0 };
      porLugar.set(lugar, { cortes: actual.cortes + 1, minutos: actual.minutos + minutos(c) });
    }
  }
  const lugares = [...porLugar].map(([nombre, datos]) => ({ nombre, ...datos }))
    .sort((a, b) => b.cortes - a.cortes || b.minutos - a.minutos || a.nombre.localeCompare(b.nombre, 'es'));

  // getUTCDay de la fecha a las 12 UTC: el día de la semana sin que importe la zona horaria de quien mira.
  const porDia = DIAS.map((nombre) => ({ nombre, cortes: 0 }));
  for (const c of cortes) porDia[(new Date(`${c.fecha}T12:00:00Z`).getUTCDay() + 6) % 7].cortes++;

  const porFranja = FRANJAS.map(({ nombre }) => ({ nombre, cortes: 0 }));
  for (const c of cortes) porFranja[FRANJAS.findIndex((f) => Number(c.desde.slice(0, 2)) < f.hasta)].cortes++;

  return {
    cortes: cortes.length,
    dias: fechas.length,
    desde: fechas[0] ?? null,
    horas: Math.round(cortes.reduce((total, c) => total + minutos(c), 0) / 60),
    lugaresAfectados: lugares.length,
    duracionMediana: mediana(cortes.map(minutos)),
    totales: cortes.filter((c) => c.afectacion === 'total').length,
    granCordoba: cortes.filter((c) => c.localidad && c.localidad !== 'Córdoba').length,
    masAfectados: lugares.slice(0, 10),
    porDia,
    porFranja,
  };
}

/** @typedef {{ lugares: string[], creado: number, hasta: number }} FallaHistorica */

const HORA_MS = 60 * 60 * 1000;
// Córdoba está siempre en UTC-3 (Argentina no cambia la hora): la hora local sale restando 3 horas.
const horaEnCordoba = (/** @type {number} */ momento) => new Date(momento - 3 * HORA_MS).getUTCHours();

/**
 * Los cortes repentinos: las fallas que EPEC confirmó en sus redes (vienen de /api/fallas?historial).
 * Una falla que sigue activa cuenta hasta ahora.
 * @param {FallaHistorica[]} fallas @param {number} [ahora]
 */
export function estadisticasFallas(fallas, ahora = Date.now()) {
  const duracion = (/** @type {FallaHistorica} */ f) => Math.max(0, (Math.min(f.hasta, ahora) - f.creado) / 60_000);
  /** @type {Map<string, { cortes: number, minutos: number }>} */
  const porLugar = new Map();
  for (const f of fallas) {
    for (const lugar of f.lugares) {
      const actual = porLugar.get(lugar) ?? { cortes: 0, minutos: 0 };
      porLugar.set(lugar, { cortes: actual.cortes + 1, minutos: actual.minutos + duracion(f) });
    }
  }
  const lugares = [...porLugar].map(([nombre, datos]) => ({ nombre, ...datos }))
    .sort((a, b) => b.cortes - a.cortes || b.minutos - a.minutos || a.nombre.localeCompare(b.nombre, 'es'));
  const porFranja = FRANJAS.map(({ nombre }) => ({ nombre, cortes: 0 }));
  for (const f of fallas) porFranja[FRANJAS.findIndex((franja) => horaEnCordoba(f.creado) < franja.hasta)].cortes++;
  return {
    cortes: fallas.length,
    horas: Math.round(fallas.reduce((total, f) => total + duracion(f), 0) / 60),
    lugaresAfectados: lugares.length,
    duracionMediana: mediana(fallas.map(duracion)),
    masAfectados: lugares.slice(0, 10),
    porFranja,
  };
}
