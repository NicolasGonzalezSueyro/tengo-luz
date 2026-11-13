import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { aMantenimientos, cortesValidos, FUENTE_EPEC, leerFoto, nombreDeLocalidad, recibirFoto } from './fuentes/epec.ts';
import { unir, type Mantenimiento } from './mantenimiento.ts';
import * as cortesEpec from '../functions/api/cortes-epec.ts';

// Un corte tal como lo publica EPEC.
const corte = {
  id: '88117', fecha: '11/11/2026', horaDesde: '08:00', horaHasta: '11:00',
  zona: 'barrio Hernández, en el perímetro comprendido por las calles: Güemes, Almafuerte, Roma y España.',
  localidad: 'SAN FRANCISCO', motivoResumido: 'Mantenimiento Y Mejoras', codLocalidad: 4000, estado: 'P',
};

test('cortesValidos: acepta el formato de EPEC y rechaza lo que no sirve', () => {
  assert.equal((cortesValidos([corte]) as unknown[]).length, 1);
  assert.equal((cortesValidos({ cortes: [corte] }) as unknown[]).length, 1);
  assert.equal((cortesValidos([]) as unknown[]).length, 0); // un día sin cortes también es una foto válida
  assert.match(cortesValidos('hola') as string, /array/);
  assert.match(cortesValidos([{ ...corte, fecha: '2026-11-11' }]) as string, /DD\/MM\/AAAA/);
  assert.match(cortesValidos([{ ...corte, horaHasta: '25:00' }]) as string, /HH:MM/);
  assert.match(cortesValidos([{ ...corte, zona: '' }]) as string, /zona/);
  assert.match(cortesValidos(Array(301).fill(corte)) as string, /300/);
  assert.equal((cortesValidos([{ ...corte, id: 88117 }]) as { id: string }[])[0].id, '88117'); // id numérico: se pasa a texto
});

test('aMantenimientos: formato del lector, capital es Córdoba, solo los programados', () => {
  const [m] = aMantenimientos([corte]);
  assert.deepEqual(m, {
    localidad: 'San Francisco', fecha: '2026-11-11', desde: '08:00', hasta: '11:00', zona: corte.zona, afectacion: null, fuente: FUENTE_EPEC,
  });
  assert.equal(nombreDeLocalidad('CORDOBA'), 'Córdoba');
  assert.equal(nombreDeLocalidad('VILLA DEL TOTORAL'), 'Villa del Totoral');
  assert.equal(nombreDeLocalidad('LA CALERA'), 'La Calera');
  assert.equal(aMantenimientos([{ ...corte, zona: 'Barrio Centro, en forma parcial.' }])[0].afectacion, 'parcial');
  assert.equal(aMantenimientos([{ ...corte, estado: 'S' }]).length, 0);
});

test('/api/cortes-epec: pide la clave, valida, guarda la foto y el robot la lee', async () => {
  const env = { DB: baseLocal(), EPEC_OFICIAL_KEY: 'clave' };
  const pedir = (metodo: string, clave?: string, cuerpo?: unknown) => new Request('http://x/api/cortes-epec', {
    method: metodo, headers: clave ? { Authorization: `Bearer ${clave}` } : {}, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  assert.equal((await cortesEpec.onRequestPost({ request: pedir('POST', 'clave', [corte]), env: { DB: env.DB } })).status, 503);
  assert.equal((await cortesEpec.onRequestPost({ request: pedir('POST', undefined, [corte]), env })).status, 401);
  assert.equal((await cortesEpec.onRequestPost({ request: pedir('POST', 'clave', [{ ...corte, fecha: 'ayer' }]), env })).status, 400);
  assert.deepEqual(await (await cortesEpec.onRequestGet({ request: pedir('GET', 'clave'), env })).json(), { recibido: 0, cortes: [] });

  assert.deepEqual(await (await cortesEpec.onRequestPost({ request: pedir('POST', 'clave', [corte]), env })).json(), { guardados: 1, robot: 'sin token' });
  const foto = await (await cortesEpec.onRequestGet({ request: pedir('GET', 'clave'), env })).json();
  assert.equal(foto.cortes[0].id, '88117');
  assert.ok(Date.now() - foto.recibido < 5000);
  // Cada envío reemplaza al anterior.
  await cortesEpec.onRequestPost({ request: pedir('POST', 'clave', []), env });
  assert.deepEqual((await (await cortesEpec.onRequestGet({ request: pedir('GET', 'clave'), env })).json()).cortes, []);
  assert.equal((await cortesEpec.onRequestGet({ request: pedir('GET', 'otra'), env })).status, 401);
});

test('unir con fechasCubiertas: un corte cancelado por EPEC desaparece aunque ese día no quede ninguno', () => {
  const m = (fecha: string, zona: string): Mantenimiento => ({ localidad: 'Córdoba', fecha, desde: '08:00', hasta: '12:00', zona, afectacion: null, fuente: 'x' });
  const guardados = [m('2026-11-11', 'Barrio Alberdi.'), m('2026-11-12', 'Barrio Centro.'), m('2026-11-01', 'Barrio Viejo.')];
  // EPEC hoy solo trae un corte del 11: el del 12 se canceló. El del 1 (pasado) queda en el historial.
  const resultado = unir(guardados, [m('2026-11-11', 'Barrio Alberdi.')], ['2026-11-11', '2026-11-12', '2026-11-13']);
  assert.deepEqual(resultado.map((x) => x.zona), ['Barrio Viejo.', 'Barrio Alberdi.']);
});

test('/api/cortes-epec: si la foto cambió, le pide a GitHub que corra el robot (no si es igual, ni dos veces en 10 minutos)', async (t) => {
  const pedidos: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    pedidos.push(`${url} ${opciones.body}`);
    return new Response(null, { status: 204 });
  });
  const env = { DB: baseLocal(), EPEC_OFICIAL_KEY: 'clave', GITHUB_TOKEN: 'token' };
  const enviar = async (cortes: unknown[]) => (await (await cortesEpec.onRequestPost({
    request: new Request('http://x/api/cortes-epec', { method: 'POST', headers: { Authorization: 'Bearer clave' }, body: JSON.stringify(cortes) }), env,
  })).json()).robot;
  assert.equal(await enviar([corte]), 'pedido');
  assert.equal(await enviar([corte]), 'sin cambios'); // la misma foto: no hace falta
  assert.equal(await enviar([]), 'hace poco'); // cambió, pero ya se pidió hace menos de 10 minutos
  assert.equal(await enviar([]), 'hace poco'); // sigue pendiente: se va a pedir cuando pasen los 10 minutos
  assert.equal(pedidos.length, 1);
  assert.match(pedidos[0], /actualizar\.yml\/dispatches .*"ref":"main"/);
});

test('cortesValidos: rechaza fechas que no existen o están lejísimo de hoy', () => {
  const hoy = Date.UTC(2026, 10, 13);
  const c = { id: '1', horaDesde: '08:00', horaHasta: '12:00', zona: 'Barrio Alberdi', localidad: 'CORDOBA' };
  assert.equal((cortesValidos([{ ...c, fecha: '13/11/2026' }], hoy) as unknown[]).length, 1);
  assert.match(cortesValidos([{ ...c, fecha: '99/99/2026' }], hoy) as string, /no existe/);
  assert.match(cortesValidos([{ ...c, fecha: '31/02/2026' }], hoy) as string, /no existe/);
  assert.match(cortesValidos([{ ...c, fecha: '01/01/2099' }], hoy) as string, /60 días/);
});

test('recibirFoto: una foto que pierde más de la mitad de los cortes que venían queda en espera hasta que se repite', async () => {
  const db = baseLocal();
  const c = (id: string, fecha: string, horaHasta = '12:00') => ({ id, fecha, horaDesde: '08:00', horaHasta, zona: 'Barrio Alberdi', localidad: 'CORDOBA' });
  const momento = { fecha: '2026-11-13', hora: '10:00' };
  const completa = [c('1', '13/11/2026'), c('2', '14/11/2026'), c('3', '14/11/2026'), c('4', '15/11/2026')];
  const t0 = Date.UTC(2026, 10, 13, 13);
  assert.equal(await recibirFoto(db, completa, t0, momento), 'guardada');
  // Llega vacía: no reemplaza a la anterior.
  assert.equal(await recibirFoto(db, [], t0 + 60_000, momento), 'en espera');
  assert.equal((await leerFoto(db))!.cortes.length, 4);
  // Otra vez, a los 5 minutos: sigue esperando (sin avisar de nuevo).
  assert.equal(await recibirFoto(db, [], t0 + 5 * 60_000, momento), 'sigue en espera');
  // Si después llega una buena, la espera se olvida.
  assert.equal(await recibirFoto(db, completa, t0 + 10 * 60_000, momento), 'guardada');
  assert.equal(await recibirFoto(db, [c('1', '13/11/2026')], t0 + 11 * 60_000, momento), 'en espera');
  // Media hora después sigue viniendo así: EPEC sacó esos cortes de verdad.
  assert.equal(await recibirFoto(db, [c('1', '13/11/2026')], t0 + 45 * 60_000, momento), 'guardada');
  assert.equal((await leerFoto(db))!.cortes.length, 1);
});

test('recibirFoto: que desaparezcan los cortes que ya terminaron no es sospechoso', async () => {
  const db = baseLocal();
  const c = (id: string, fecha: string, horaHasta = '12:00') => ({ id, fecha, horaDesde: '08:00', horaHasta, zona: 'Barrio Alberdi', localidad: 'CORDOBA' });
  const t0 = Date.UTC(2026, 10, 13, 13);
  await recibirFoto(db, [c('1', '13/11/2026'), c('2', '13/11/2026'), c('3', '13/11/2026'), c('4', '14/11/2026')], t0, { fecha: '2026-11-13', hora: '07:00' });
  // A las 15 h los tres de hoy ya terminaron (12:00): que no estén es normal.
  assert.equal(await recibirFoto(db, [c('4', '14/11/2026')], t0 + 60_000, { fecha: '2026-11-13', hora: '15:00' }), 'guardada');
});
