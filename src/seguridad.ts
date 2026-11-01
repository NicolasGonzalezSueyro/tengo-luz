// Comprobación de claves secretas (ADMIN_CLAVE, FALLAS_CLAVE) que llegan como "Authorization: Bearer <clave>".

const sha256 = async (texto: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));

/**
 * Compara la clave recibida con la verdadera. Se comparan los hash byte por byte sin cortar antes:
 * así el tiempo de respuesta no da pistas de cuántas letras se acertaron.
 */
export async function claveCorrecta(request: Request, clave: string) {
  const [dada, real] = await Promise.all([sha256(request.headers.get('Authorization') ?? ''), sha256(`Bearer ${clave}`)]);
  let diferencias = 0;
  for (let i = 0; i < real.length; i++) diferencias |= dada[i] ^ real[i];
  return diferencias === 0;
}
