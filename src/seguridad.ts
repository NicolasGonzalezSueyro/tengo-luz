// Comprobación de claves secretas (ADMIN_CLAVE, FALLAS_CLAVE, SECRETO_BOT).

import { anotarIntento, frenado } from './freno.ts';
import { huellaDe, type BaseDeDatos } from './reportes.ts';

const sha256 = async (texto: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));

/**
 * Compara dos textos sin cortar antes: se comparan los hash byte por byte, así el tiempo de respuesta no da
 * pistas de cuántas letras se acertaron.
 */
export async function igualesSeguro(dado: string, real: string) {
  const [a, b] = await Promise.all([sha256(dado), sha256(real)]);
  let diferencias = 0;
  for (let i = 0; i < b.length; i++) diferencias |= a[i] ^ b[i];
  return diferencias === 0;
}

/** La clave llega como "Authorization: Bearer <clave>". */
export const claveCorrecta = (request: Request, clave: string) => igualesSeguro(request.headers.get('Authorization') ?? '', `Bearer ${clave}`);

const MINUTO = 60 * 1000;
export const INTENTOS_DE_CLAVE = 10; // claves mal puestas por conexión cada 15 minutos; después, a esperar

/**
 * Como claveCorrecta, pero con freno: después de 10 claves mal puestas desde la misma conexión en 15 minutos,
 * responde "bloqueado" sin mirar la clave. Así no se puede adivinar probando miles por segundo.
 */
export async function revisarClave(request: Request, clave: string, db: BaseDeDatos, secreto: string, ahora = Date.now()): Promise<'ok' | 'mala' | 'bloqueado'> {
  const huella = await huellaDe(request.headers.get('CF-Connecting-IP') ?? 'desconocida', secreto, ahora);
  if (await frenado(db, 'clave', huella, INTENTOS_DE_CLAVE, 15 * MINUTO, ahora)) return 'bloqueado';
  if (await claveCorrecta(request, clave)) return 'ok';
  await anotarIntento(db, 'clave', huella, ahora);
  return 'mala';
}
