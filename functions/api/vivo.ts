import { fallasParaElMapa } from '../../src/fallas.ts';
import { contarReportes, type BaseDeDatos } from '../../src/reportes.ts';

// GET /api/vivo → lo que cambia minuto a minuto, en un solo pedido: los reportes de vecinos y las fallas publicadas.
// La página lo pide una vez por minuto mientras está a la vista. Antes eran dos pedidos cada 30 segundos, y el plan
// gratis de Cloudflare permite 100.000 pedidos a funciones por día: un apagón grande lo agotaba.
// (/api/reportes y /api/fallas siguen andando igual, para las páginas viejas que quedaron abiertas.)

type Contexto = { env: { DB: BaseDeDatos } };

export async function onRequestGet({ env }: Contexto) {
  const ahora = Date.now();
  const [reportes, fallas] = await Promise.all([contarReportes(env.DB, ahora), fallasParaElMapa(env.DB, ahora)]);
  return Response.json({ reportes, fallas }, { headers: { 'Cache-Control': 'no-store' } });
}
