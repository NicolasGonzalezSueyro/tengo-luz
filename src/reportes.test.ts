import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barrioValido, contarReportes, guardarReporte, huellaDe, redDeLaIp, VIGENCIA } from './reportes.ts';
import { baseLocal } from './base-local.ts';
import { onRequestGet, onRequestPost } from '../functions/api/reportes.ts';

const HORA = 60 * 60 * 1000;
const T = Date.UTC(2026, 9, 30, 15, 0);

test('cuenta los reportes por barrio, uno por persona', async () => {
  const db = baseLocal();
  assert.equal(await guardarReporte(db, 'Alberdi', 'ana', T), 'guardado');
  assert.equal(await guardarReporte(db, 'Alberdi', 'ana', T + 1000), 'repetido');
  assert.equal(await guardarReporte(db, 'Alberdi', 'beto', T + 2000), 'guardado');
  assert.equal(await guardarReporte(db, 'Centro', 'ana', T + 3000), 'guardado');
  assert.deepEqual(await contarReportes(db, T + 5000), {
    Alberdi: { cantidad: 2, ultimo: T + 2000 },
    Centro: { cantidad: 1, ultimo: T + 3000 },
  });
});

test('los reportes vencen a las 3 horas y después se puede volver a reportar', async () => {
  const db = baseLocal();
  await guardarReporte(db, 'Alberdi', 'ana', T);
  assert.deepEqual(await contarReportes(db, T + VIGENCIA + 1), {});
  assert.equal(await guardarReporte(db, 'Alberdi', 'ana', T + VIGENCIA + 1), 'guardado');
});

test('una persona no puede reportar más de 5 barrios por hora', async () => {
  const db = baseLocal();
  for (let i = 0; i < 5; i++) assert.equal(await guardarReporte(db, `Barrio ${i}`, 'ana', T + i), 'guardado');
  assert.equal(await guardarReporte(db, 'Barrio 5', 'ana', T + 10), 'demasiados');
  assert.equal(await guardarReporte(db, 'Barrio 5', 'ana', T + HORA + 10), 'guardado');
});

test('la huella no contiene la IP, es fija en el día y cambia al otro día', async () => {
  const huella = await huellaDe('181.1.2.3', 'secreto', T);
  assert.match(huella, /^[0-9a-f]{64}$/);
  assert.equal(await huellaDe('181.1.2.3', 'secreto', T + HORA), huella);
  assert.notEqual(await huellaDe('181.1.2.3', 'secreto', T + 24 * HORA), huella);
  assert.notEqual(await huellaDe('181.1.2.3', 'otra clave', T), huella);
});

test('barrioValido acepta nombres razonables', () => {
  assert.equal(barrioValido('  Alberdi '), 'Alberdi');
  assert.equal(barrioValido(''), null);
  assert.equal(barrioValido(42), null);
  assert.equal(barrioValido('x'.repeat(81)), null);
});

test('API: POST guarda, GET devuelve la cuenta y se rechazan pedidos inválidos', async () => {
  const env = { DB: baseLocal(), CLAVE: 'secreto' };
  const pedido = (cuerpo: string, tipo = 'application/json') =>
    new Request('http://x/api/reportes', { method: 'POST', headers: { 'Content-Type': tipo, 'CF-Connecting-IP': '1.2.3.4' }, body: cuerpo });

  const ok = await onRequestPost({ request: pedido('{"barrio":"Alberdi"}'), env });
  assert.deepEqual(await ok.json(), { resultado: 'guardado' });
  assert.equal((await onRequestPost({ request: pedido('{"barrio":"Alberdi"}', 'text/plain'), env })).status, 415);
  assert.equal((await onRequestPost({ request: pedido('{"barrio":""}'), env })).status, 400);
  assert.equal((await onRequestPost({ request: pedido('no es json'), env })).status, 400);
  // Solo lugares del mapa, y nada de cuerpos gigantes.
  assert.equal((await onRequestPost({ request: pedido('{"barrio":"Barrio Inventado"}'), env })).status, 400);
  assert.equal((await onRequestPost({ request: pedido(JSON.stringify({ barrio: 'Alberdi', relleno: 'x'.repeat(5000) })), env })).status, 413);

  const cuenta = await (await onRequestGet({ request: new Request('http://x/api/reportes'), env })).json();
  assert.deepEqual(Object.keys(cuenta), ['Alberdi']);
  assert.equal(cuenta.Alberdi.cantidad, 1);
});

test('redDeLaIp: con IPv6 cuenta el bloque de la casa (/64), con IPv4 la dirección', () => {
  assert.equal(redDeLaIp('181.1.2.3'), '181.1.2.3');
  assert.equal(redDeLaIp('2800:810:4f2:a1::1'), '2800:810:4f2:a1::/64');
  assert.equal(redDeLaIp('2800:0810:04f2:00a1:1234:5678:9abc:def0'), '2800:810:4f2:a1::/64');
  assert.equal(redDeLaIp('2800:810::9'), '2800:810:0:0::/64');
  assert.equal(redDeLaIp('::1'), '0:0:0:0::/64');
});

test('dos direcciones IPv6 de la misma casa tienen la misma huella', async () => {
  assert.equal(await huellaDe('2800:810:4f2:a1::1', 'secreto', T), await huellaDe('2800:810:4f2:a1:ffff::9', 'secreto', T));
  assert.notEqual(await huellaDe('2800:810:4f2:a1::1', 'secreto', T), await huellaDe('2800:810:4f2:a2::1', 'secreto', T));
});
