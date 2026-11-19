// Los cambios de contornos que hace el admin desde /admin-contornos esperan en la base (D1) hasta que el robot de
// GitHub los aplica a los mapas y publica el sitio (src/aplicar-contornos.ts). Después el robot los saca de la lista.

import type { PedidoDeContorno } from './contornos.ts';
import type { BaseDeDatos } from './reportes.ts';

export type PedidoGuardado = PedidoDeContorno & { id: number; creado: number };

const listas = new WeakSet<BaseDeDatos>(); // la tabla se crea sola la primera vez (una vez por base)
async function prepararTabla(db: BaseDeDatos) {
  if (listas.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS contornos_pendientes (id INTEGER PRIMARY KEY, pedido TEXT NOT NULL, creado INTEGER NOT NULL)').bind().run();
  listas.add(db);
}

export async function guardarPedido(db: BaseDeDatos, pedido: PedidoDeContorno, ahora: number) {
  await prepararTabla(db);
  await db.prepare('INSERT INTO contornos_pendientes (pedido, creado) VALUES (?, ?)').bind(JSON.stringify(pedido), ahora).run();
}

/** Los pedidos que todavía no se aplicaron, en el orden en que llegaron. */
export async function pedidosPendientes(db: BaseDeDatos): Promise<PedidoGuardado[]> {
  await prepararTabla(db);
  const { results } = await db.prepare('SELECT id, pedido, creado FROM contornos_pendientes ORDER BY id').bind().all();
  return results.map((r) => ({ ...(JSON.parse(String(r.pedido)) as PedidoDeContorno), id: Number(r.id), creado: Number(r.creado) }));
}

/** Saca de la lista los pedidos que el robot ya aplicó (o que el admin canceló). Devuelve cuántos sacó. */
export async function sacarPedidos(db: BaseDeDatos, ids: number[]): Promise<number> {
  await prepararTabla(db);
  let sacados = 0;
  for (const id of ids.filter((i) => Number.isInteger(i)).slice(0, 500)) {
    const fila = await db.prepare('SELECT 1 AS si FROM contornos_pendientes WHERE id = ?').bind(id).first();
    if (!fila) continue;
    await db.prepare('DELETE FROM contornos_pendientes WHERE id = ?').bind(id).run();
    sacados++;
  }
  return sacados;
}
