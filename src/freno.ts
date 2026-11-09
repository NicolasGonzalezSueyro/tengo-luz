// Frenos por conexión: cuántas veces alguien hizo algo en un rato (claves mal puestas, suscripciones nuevas).
// "huella" es el hash de la IP del día (huellaDe en src/reportes.ts): no se guarda la IP.
// La tabla se crea sola la primera vez, así no hay que tocar la consola de D1.

import type { BaseDeDatos } from './reportes.ts';

const listas = new WeakSet<BaseDeDatos>(); // una vez por base (en los tests hay muchas)
async function prepararTabla(db: BaseDeDatos) {
  if (listas.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS intentos (accion TEXT NOT NULL, huella TEXT NOT NULL, creado INTEGER NOT NULL)').bind().run();
  await db.prepare('CREATE INDEX IF NOT EXISTS intentos_buscar ON intentos (accion, huella, creado)').bind().run();
  listas.add(db);
}

/** ¿Esta conexión ya hizo `accion` `limite` veces en los últimos `ventana` milisegundos? */
export async function frenado(db: BaseDeDatos, accion: string, huella: string, limite: number, ventana: number, ahora: number): Promise<boolean> {
  await prepararTabla(db);
  const fila = await db.prepare('SELECT COUNT(*) AS n FROM intentos WHERE accion = ? AND huella = ? AND creado > ?').bind(accion, huella, ahora - ventana).first();
  return Number(fila?.n ?? 0) >= limite;
}

/** Anota una vez más. Lo de más de un día se borra: no se guardan datos de más. */
export async function anotarIntento(db: BaseDeDatos, accion: string, huella: string, ahora: number) {
  await prepararTabla(db);
  await db.prepare('INSERT INTO intentos (accion, huella, creado) VALUES (?, ?, ?)').bind(accion, huella, ahora).run();
  await db.prepare('DELETE FROM intentos WHERE creado < ?').bind(ahora - 24 * 60 * 60 * 1000).run();
}
