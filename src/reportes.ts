// Reportes de vecinos ("No tengo luz"). La lógica está acá y la usa la API de Cloudflare
// (functions/api/reportes.ts), así se puede probar con tests sin subir nada.

/** Lo poco que usamos de una base D1 de Cloudflare. En los tests y en `npm run dev` es un SQLite en memoria. */
export type BaseDeDatos = {
  prepare(sql: string): {
    bind(...valores: (string | number)[]): {
      all(): Promise<{ results: Record<string, unknown>[] }>;
      first(): Promise<Record<string, unknown> | null>;
      run(): Promise<unknown>;
    };
  };
};

/** Cuántos vecinos reportaron cada barrio y cuándo fue el último reporte (ms). */
export type Resumen = Record<string, { cantidad: number; ultimo: number }>;
export type Resultado = 'guardado' | 'repetido' | 'demasiados';

const HORA = 60 * 60 * 1000;
export const VIGENCIA = 3 * HORA; // un reporte cuenta durante 3 horas; después se supone que volvió la luz
const MAXIMO_POR_HORA = 5; // una misma persona no puede reportar más de 5 barrios por hora

export async function contarReportes(db: BaseDeDatos, ahora: number): Promise<Resumen> {
  const { results } = await db
    .prepare('SELECT barrio, COUNT(*) AS cantidad, MAX(creado) AS ultimo FROM reportes WHERE creado > ? GROUP BY barrio')
    .bind(ahora - VIGENCIA)
    .all();
  return Object.fromEntries(results.map((r) => [String(r.barrio), { cantidad: Number(r.cantidad), ultimo: Number(r.ultimo) }]));
}

export async function guardarReporte(db: BaseDeDatos, barrio: string, huella: string, ahora: number): Promise<Resultado> {
  const previos = await db
    .prepare(
      `SELECT COALESCE(SUM(barrio = ?), 0) AS mismo, COALESCE(SUM(creado > ?), 0) AS ultimaHora
       FROM reportes WHERE huella = ? AND creado > ?`,
    )
    .bind(barrio, ahora - HORA, huella, ahora - VIGENCIA)
    .first();
  if (Number(previos?.mismo) > 0) return 'repetido';
  if (Number(previos?.ultimaHora) >= MAXIMO_POR_HORA) return 'demasiados';
  await db.prepare('INSERT INTO reportes (barrio, creado, huella) VALUES (?, ?, ?)').bind(barrio, ahora, huella).run();
  // Lo vencido no se usa más: lo borramos para no guardar datos de más.
  await db.prepare('DELETE FROM reportes WHERE creado < ?').bind(ahora - 24 * HORA).run();
  return 'guardado';
}

/**
 * Identifica a quien reporta sin guardar su IP: un hash de la IP con una clave secreta y el día.
 * Sin la clave no se puede volver a la IP, y como cambia cada día no sirve para seguir a nadie.
 */
export async function huellaDe(ip: string, clave: string, ahora: number): Promise<string> {
  const dia = new Date(ahora).toISOString().slice(0, 10);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${clave}|${dia}|${ip}`));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** El nombre del barrio tal como lo manda la página. La página ignora los nombres que no están en el mapa. */
export function barrioValido(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const barrio = valor.trim();
  return barrio.length > 0 && barrio.length <= 80 ? barrio : null;
}
