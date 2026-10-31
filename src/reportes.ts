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

export async function contarReportes(db: BaseDeDatos, ahora: number): Promise<Resumen> {
  const { results } = await db
    .prepare('SELECT barrio, COUNT(*) AS cantidad, MAX(creado) AS ultimo FROM reportes WHERE creado > ? GROUP BY barrio')
    .bind(ahora - VIGENCIA)
    .all();
  return Object.fromEntries(results.map((r) => [String(r.barrio), { cantidad: Number(r.cantidad), ultimo: Number(r.ultimo) }]));
}

export async function guardarReporte(db: BaseDeDatos, barrio: string, huella: string, ahora: number): Promise<Resultado> {
  // Cada conexión reporta una sola vez cada 3 horas, en cualquier barrio: una persona está en un solo lugar,
  // y así nadie puede pintar media ciudad de rojo para hacer una broma.
  const previo = await db.prepare('SELECT barrio FROM reportes WHERE huella = ? AND creado > ? LIMIT 1').bind(huella, ahora - VIGENCIA).first();
  if (previo) return previo.barrio === barrio ? 'repetido' : 'demasiados';
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
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${clave}|${dia}|${redDeLaIp(ip)}`));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Con IPv6, cada casa recibe millones de direcciones (un bloque "/64"), así que limitar por dirección no
 * frenaría a nadie: se usa el bloque. Con IPv4 se usa la dirección entera.
 */
export function redDeLaIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [izquierda, derecha = ''] = ip.toLowerCase().split('::');
  const partes = (texto: string) => (texto ? texto.split(':') : []);
  const ceros = Array(8 - partes(izquierda).length - partes(derecha).length).fill('0');
  const grupos = ip.includes('::') ? [...partes(izquierda), ...ceros, ...partes(derecha)] : partes(izquierda);
  return `${grupos.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** El nombre del barrio tal como lo manda la página. La API además exige que sea un lugar del mapa. */
export function barrioValido(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const barrio = valor.trim();
  return barrio.length > 0 && barrio.length <= 80 ? barrio : null;
}
