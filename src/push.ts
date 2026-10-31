// Notificaciones push (las que llegan al celular como las de cualquier app), sin librerías: con WebCrypto,
// que tienen tanto Cloudflare como Node.
//
// Cada aviso viaja a un servicio de push (el de Google, Apple, Mozilla o Microsoft, según el navegador) que lo
// entrega al teléfono. Para eso se usan dos estándares:
// - VAPID (RFC 8292): firmamos cada pedido con nuestra clave privada, así el servicio sabe que somos nosotros.
// - Cifrado (RFC 8291): el contenido va cifrado con claves del navegador del vecino; el servicio no puede leerlo.

export type SuscripcionPush = { endpoint: string; keys: { p256dh: string; auth: string } };
/** Nuestra clave privada (VAPID), en formato JWK: es el secreto PUSH_CLAVE de Cloudflare. */
export type ClavePush = JsonWebKey & { x: string; y: string; d: string };

// Los servicios de push de los navegadores. Solo se les manda a ellos: así nadie puede usar nuestra API
// para que el servidor le haga pedidos a cualquier otra dirección.
const SERVICIOS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

const texto = new TextEncoder();
/** Bytes: lo que reciben las funciones de WebCrypto y fetch. */
type Bytes = Uint8Array<ArrayBuffer>;

export function aBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deBase64url(valor: string): Bytes {
  const base64 = valor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (valor.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) as Bytes;
}

const unir = (...partes: Uint8Array[]): Bytes => {
  const total = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) [total.set(p, i), (i += p.length)];
  return total;
};

/** La clave pública en el formato que piden los navegadores: 0x04 + x + y (65 bytes), en base64url. */
export function clavePublicaDe(clave: ClavePush): string {
  return aBase64url(unir(new Uint8Array([4]), deBase64url(clave.x), deBase64url(clave.y)));
}

/** ¿Es una suscripción válida, de un servicio de push conocido? */
export function suscripcionValida(valor: unknown): valor is SuscripcionPush {
  const s = valor as SuscripcionPush | null;
  if (typeof s?.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return false;
  try {
    const url = new URL(s.endpoint);
    return url.protocol === 'https:' && SERVICIOS.some((r) => r.test(url.hostname)) && s.endpoint.length < 1000
      && deBase64url(s.keys.p256dh).length === 65 && deBase64url(s.keys.auth).length === 16;
  } catch {
    return false;
  }
}

/** HKDF con SHA-256 (extraer y expandir en un paso), como pide el RFC 8291. */
async function hkdf(sal: Bytes, material: Bytes, info: Bytes, largo: number): Promise<Bytes> {
  const clave = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sal, info }, clave, largo * 8));
}

/**
 * Cifra el mensaje para un navegador (RFC 8291, formato aes128gcm). `prueba` permite fijar la sal y la clave
 * efímera para comparar con el ejemplo del RFC; en uso normal se generan al azar en cada mensaje.
 */
export async function cifrar(
  mensaje: string,
  suscripcion: SuscripcionPush,
  prueba?: { sal: Bytes; efimera: CryptoKeyPair },
): Promise<Bytes> {
  const publicaDelNavegador = deBase64url(suscripcion.keys.p256dh);
  const secretoDelNavegador = deBase64url(suscripcion.keys.auth);
  const sal: Bytes = prueba?.sal ?? crypto.getRandomValues(new Uint8Array(16));
  const efimera = prueba?.efimera ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const nuestraPublica: Bytes = new Uint8Array(await crypto.subtle.exportKey('raw', efimera.publicKey));

  // Secreto compartido (ECDH) entre nuestra clave efímera y la del navegador.
  const delNavegador = await crypto.subtle.importKey('raw', publicaDelNavegador, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const compartido: Bytes = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: delNavegador }, efimera.privateKey, 256));

  const material = await hkdf(secretoDelNavegador, compartido, unir(texto.encode('WebPush: info\0'), publicaDelNavegador, nuestraPublica), 32);
  const claveDeContenido = await hkdf(sal, material, texto.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(sal, material, texto.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', claveDeContenido, 'AES-GCM', false, ['encrypt']);
  // El mensaje + 0x02 ("último registro"), en un solo bloque cifrado.
  const cifrado: Bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, unir(texto.encode(mensaje), new Uint8Array([2]))));

  // Encabezado: sal (16) + tamaño de registro (4, = 4096) + largo de la clave (1) + nuestra clave pública (65).
  const tamano = new Uint8Array([0, 0, 16, 0]);
  return unir(sal, tamano, new Uint8Array([nuestraPublica.length]), nuestraPublica, cifrado);
}

/** El encabezado Authorization de VAPID: un JWT firmado con nuestra clave, válido 12 horas para ese servicio. */
export async function firmaVapid(endpoint: string, clave: ClavePush, sujeto: string, ahora = Date.now()): Promise<string> {
  const enBase64url = (objeto: object) => aBase64url(texto.encode(JSON.stringify(objeto)));
  const datos = `${enBase64url({ typ: 'JWT', alg: 'ES256' })}.${enBase64url({
    aud: new URL(endpoint).origin,
    exp: Math.floor(ahora / 1000) + 12 * 60 * 60,
    sub: sujeto,
  })}`;
  const privada = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: clave.x, y: clave.y, d: clave.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const firma = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privada, texto.encode(datos)));
  return `vapid t=${datos}.${aBase64url(firma)}, k=${clavePublicaDe(clave)}`;
}

/**
 * Manda una notificación. Devuelve la respuesta del servicio de push:
 * 201 = entregada, 404/410 = la suscripción ya no existe (hay que borrarla).
 */
export async function enviarPush(suscripcion: SuscripcionPush, mensaje: object, clave: ClavePush, sujeto: string): Promise<Response> {
  return fetch(suscripcion.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await firmaVapid(suscripcion.endpoint, clave, sujeto),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 60 * 60), // si el celular está apagado, el servicio guarda el aviso hasta un día
      Urgency: 'normal',
    },
    body: await cifrar(JSON.stringify(mensaje), suscripcion),
  });
}

/** Genera un par de claves nuevo (para `npm run claves-push`). */
export async function generarClave(): Promise<ClavePush> {
  const par = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const { kty, crv, x, y, d } = (await crypto.subtle.exportKey('jwk', par.privateKey)) as ClavePush;
  return { kty, crv, x, y, d };
}

if (import.meta.main) {
  const clave = await generarClave();
  console.log('Copiá esta línea entera como valor del secreto PUSH_CLAVE en Cloudflare (y no la compartas):\n');
  console.log(JSON.stringify(clave));
  console.log(`\nClave pública (esta sí es pública, la página la pide sola): ${clavePublicaDe(clave)}`);
}
