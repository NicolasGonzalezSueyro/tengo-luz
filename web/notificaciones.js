// @ts-check
// Notificaciones del navegador: suscribirse a los avisos de cortes de un barrio (como el bot de Telegram).
// El navegador da una dirección anónima y unas claves; se mandan a /api/push junto con el barrio.
// Los barrios con aviso se recuerdan acá (localStorage) solo para mostrar el botón como activado.

const GUARDADOS = 'avisos-push';

/** Si este navegador puede recibir notificaciones (en iPhone, solo con la app instalada). */
export const soportaNotificaciones = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** @returns {string[]} */
export function barriosConAviso() {
  try {
    return JSON.parse(localStorage.getItem(GUARDADOS) ?? '[]');
  } catch {
    return [];
  }
}

/** @param {string[]} barrios */
function recordar(barrios) {
  try {
    localStorage.setItem(GUARDADOS, JSON.stringify(barrios));
  } catch {
    // Sin almacenamiento: el aviso funciona igual, solo que el botón no se acuerda.
  }
}

/** @param {string} valor */
function deBase64url(valor) {
  const base64 = valor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (valor.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** La suscripción del navegador, creada con nuestra clave pública. Si la clave cambió, se renueva. */
async function suscripcion() {
  const respuesta = await fetch('api/push');
  if (!respuesta.ok) throw new Error('Las notificaciones todavía no están disponibles. Probá más tarde.');
  const clave = deBase64url((await respuesta.json()).clavePublica);
  const registro = await navigator.serviceWorker.ready;
  let actual = await registro.pushManager.getSubscription();
  const suya = actual?.options.applicationServerKey;
  if (actual && suya && new Uint8Array(suya).join() !== clave.join()) {
    await actual.unsubscribe();
    actual = null;
  }
  return actual ?? registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: clave });
}

/** @param {'agregar' | 'quitar'} accion @param {string} barrio @param {PushSubscription} s */
async function avisarAlServidor(accion, barrio, s) {
  const respuesta = await fetch('api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accion, barrio, suscripcion: s.toJSON() }),
  });
  if (!respuesta.ok) throw new Error((await respuesta.json().catch(() => ({}))).error ?? 'No se pudo guardar el aviso. Probá de nuevo.');
}

/** @param {string} barrio */
export async function activarAvisos(barrio) {
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Para avisarte, el navegador necesita permiso para mostrar notificaciones (se cambia en la configuración del sitio).');
  }
  await avisarAlServidor('agregar', barrio, await suscripcion());
  recordar([...new Set([...barriosConAviso(), barrio])]);
}

/** @param {string} barrio */
export async function desactivarAvisos(barrio) {
  const s = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (s) await avisarAlServidor('quitar', barrio, s);
  recordar(barriosConAviso().filter((b) => b !== barrio));
}
