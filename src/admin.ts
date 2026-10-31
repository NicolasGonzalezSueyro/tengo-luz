// Lo que puede ver y hacer el admin. Lo usan el bot de Telegram (/estado, /limpiar) y el panel web (/admin),
// así los dos muestran lo mismo.

import { contarReportes, type BaseDeDatos, type Resumen } from './reportes.ts';

export type Estadisticas = {
  personas: number; // chats de Telegram con al menos un barrio
  barriosSeguidos: number;
  notificaciones: number; // navegadores con avisos push activados
  avisos: number; // avisos mandados en los últimos 30 días
  reportes: Resumen; // reportes de vecinos vigentes, por barrio
  masSeguidos: { barrio: string; personas: number }[];
};

const numero = async (db: BaseDeDatos, sql: string) => Number((await db.prepare(sql).bind().first())?.n ?? 0);

export async function estadisticas(db: BaseDeDatos, ahora: number): Promise<Estadisticas> {
  const { results } = await db
    .prepare('SELECT barrio, COUNT(*) AS personas FROM suscripciones GROUP BY barrio ORDER BY personas DESC, barrio LIMIT 10')
    .bind()
    .all();
  return {
    personas: await numero(db, 'SELECT COUNT(DISTINCT chat) AS n FROM suscripciones'),
    barriosSeguidos: await numero(db, 'SELECT COUNT(*) AS n FROM suscripciones'),
    notificaciones: await numero(db, 'SELECT COUNT(DISTINCT endpoint) AS n FROM push_suscripciones'),
    avisos: await numero(db, 'SELECT COUNT(*) AS n FROM avisados'),
    reportes: await contarReportes(db, ahora),
    masSeguidos: results.map((r) => ({ barrio: String(r.barrio), personas: Number(r.personas) })),
  };
}

/**
 * Borra los reportes de vecinos de un barrio, o todos si no se dice cuál. Devuelve cuántos borró.
 * Borra también los vencidos que todavía estén guardados, así el barrio deja de verse rojo seguro.
 */
export async function limpiarReportes(db: BaseDeDatos, barrio?: string): Promise<number> {
  const [filtro, valores] = barrio ? [' WHERE barrio = ?', [barrio]] : ['', []];
  const cuantos = Number((await db.prepare(`SELECT COUNT(*) AS n FROM reportes${filtro}`).bind(...valores).first())?.n ?? 0);
  await db.prepare(`DELETE FROM reportes${filtro}`).bind(...valores).run();
  return cuantos;
}
