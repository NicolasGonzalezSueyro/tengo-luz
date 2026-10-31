// Las suscripciones a notificaciones push y los avisos que les toca recibir (como el bot, pero en el navegador).
// El cifrado está en src/push.ts. Al final, mandarAvisos: el envío por Telegram y push que comparten
// los avisos de cortes (/api/avisar) y los de vecinos sin luz (/api/reportes).

import { etiquetaDia, momentoEnCordoba, type Corte } from '../web/estado.js';
import { agruparAvisos, marcarAvisado, olvidarChat, SITIO, type Aviso } from './bot.ts';
import { enviarPush, type ClavePush, type SuscripcionPush } from './push.ts';
import { VIGENCIA, type BaseDeDatos } from './reportes.ts';
import { enviarMensaje } from './telegram.ts';

const MAXIMO_BARRIOS = 10; // por navegador, igual que en el bot

export type AvisoPush = { suscripcion: SuscripcionPush; clave: string; mensaje: { titulo: string; cuerpo: string; url: string } };

export async function suscribir(db: BaseDeDatos, s: SuscripcionPush, barrio: string, ahora: number): Promise<'listo' | 'demasiados'> {
  const actuales = (await db.prepare('SELECT barrio FROM push_suscripciones WHERE endpoint = ?').bind(s.endpoint).all()).results;
  if (!actuales.some((r) => r.barrio === barrio) && actuales.length >= MAXIMO_BARRIOS) return 'demasiados';
  // Si ya existía, se actualizan las claves (el navegador puede renovarlas).
  await db
    .prepare('INSERT OR REPLACE INTO push_suscripciones (endpoint, barrio, p256dh, auth, creado) VALUES (?, ?, ?, ?, ?)')
    .bind(s.endpoint, barrio, s.keys.p256dh, s.keys.auth, ahora)
    .run();
  return 'listo';
}

export async function desuscribir(db: BaseDeDatos, endpoint: string, barrio: string) {
  await db.prepare('DELETE FROM push_suscripciones WHERE endpoint = ? AND barrio = ?').bind(endpoint, barrio).run();
}

/** El navegador ya no acepta avisos (se desinstaló la app, se borraron los datos…): se olvida del todo. */
export async function olvidarNavegador(db: BaseDeDatos, endpoint: string) {
  await db.prepare('DELETE FROM push_suscripciones WHERE endpoint = ?').bind(endpoint).run();
}

/** Las notificaciones que faltan mandar: una por navegador y por corte de hoy en adelante en sus barrios. */
export async function avisosPushPendientes(db: BaseDeDatos, cortes: Corte[], hoy: string): Promise<AvisoPush[]> {
  if (!cortes.some((c) => c.fecha >= hoy)) return [];
  const filas = (await db.prepare('SELECT endpoint, barrio, p256dh, auth FROM push_suscripciones').bind().all()).results;
  const claves = new Map(filas.map((f) => [String(f.endpoint), { p256dh: String(f.p256dh), auth: String(f.auth) }]));
  const yaAvisados = new Set(
    (await db.prepare('SELECT endpoint, clave FROM push_avisados').bind().all()).results.map((r) => `${r.endpoint}|${r.clave}`),
  );
  return agruparAvisos(filas.map((f) => ({ destino: String(f.endpoint), barrio: String(f.barrio) })), yaAvisados, cortes, hoy)
    .map(({ destino, clave, corte, barrios }) => ({
      suscripcion: { endpoint: destino, keys: claves.get(destino)! },
      clave,
      mensaje: {
        titulo: `⚡ Corte de luz en ${barrios.join(', ')}`,
        cuerpo: `${etiquetaDia(corte.fecha, hoy)}, de ${corte.desde} a ${corte.hasta}${corte.afectacion ? ` (${corte.afectacion})` : ''}.`,
        url: `./?barrio=${encodeURIComponent(barrios[0])}`,
      },
    }));
}

export async function marcarPushAvisado(db: BaseDeDatos, endpoint: string, clave: string, ahora: number) {
  await db.prepare('INSERT OR IGNORE INTO push_avisados (endpoint, clave, creado) VALUES (?, ?, ?)').bind(endpoint, clave, ahora).run();
  await db.prepare('DELETE FROM push_avisados WHERE creado < ?').bind(ahora - 30 * 24 * 60 * 60 * 1000).run();
}

// ---------------------------------------------------------------------------------------------
// Vecinos sin luz
// ---------------------------------------------------------------------------------------------

/** Con cuántos reportes (de conexiones distintas, en las últimas 3 horas) se avisa a quienes siguen el barrio. */
export const VECINOS_PARA_AVISAR = 3;

/**
 * Cuando varios vecinos reportan que no tienen luz en un barrio: los avisos para quienes lo siguen.
 * Como mucho uno por día y por barrio, así un corte largo no manda un aviso por cada reporte nuevo.
 */
export async function avisosDeVecinos(db: BaseDeDatos, barrio: string, ahora: number): Promise<{ telegram: Aviso[]; push: AvisoPush[] }> {
  const fila = await db.prepare('SELECT COUNT(*) AS cantidad FROM reportes WHERE barrio = ? AND creado > ?').bind(barrio, ahora - VIGENCIA).first();
  const cantidad = Number(fila?.cantidad ?? 0);
  if (cantidad < VECINOS_PARA_AVISAR) return { telegram: [], push: [] };
  const clave = `vecinos ${momentoEnCordoba(new Date(ahora)).fecha} ${barrio}`;
  const link = `${SITIO}/?barrio=${encodeURIComponent(barrio)}`;

  const chats = (await db
    .prepare('SELECT chat FROM suscripciones WHERE barrio = ? AND chat NOT IN (SELECT chat FROM avisados WHERE clave = ?)')
    .bind(barrio, clave).all()).results;
  const navegadores = (await db
    .prepare('SELECT endpoint, p256dh, auth FROM push_suscripciones WHERE barrio = ? AND endpoint NOT IN (SELECT endpoint FROM push_avisados WHERE clave = ?)')
    .bind(barrio, clave).all()).results;
  return {
    telegram: chats.map((c) => ({
      chat: Number(c.chat),
      clave,
      // Se aclara de dónde sale: no es un anuncio de EPEC, y puede ser una falla que EPEC todavía no sabe.
      texto: [
        `🔦 ${cantidad} vecinos de ${barrio} reportaron que no tienen luz`,
        '',
        'Lo avisan personas en el sitio, no es un anuncio de EPEC. Si te pasa lo mismo, reclamá al 0800 777 0000.',
        '',
        `Mapa: ${link}`,
      ].join('\n'),
    })),
    push: navegadores.map((n) => ({
      suscripcion: { endpoint: String(n.endpoint), keys: { p256dh: String(n.p256dh), auth: String(n.auth) } },
      clave,
      mensaje: {
        titulo: `🔦 Vecinos sin luz en ${barrio}`,
        cuerpo: `${cantidad} vecinos reportaron que no tienen luz. No es un anuncio de EPEC.`,
        url: `./?barrio=${encodeURIComponent(barrio)}`,
      },
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------------------------

// shortcut: Cloudflare gratis deja hacer ~50 pedidos a otros sitios por llamada (Telegram y push suman juntos).
// Si hay más avisos, los de cortes salen en la llamada de la hora siguiente y los de vecinos con el próximo
// reporte. Si algún día hay muchos suscriptos, mandarlos desde GitHub Actions.
export const MAXIMO_POR_VEZ = 40;

/**
 * Manda los avisos (primero Telegram, después push) y anota los que salieron para no repetirlos.
 * Si alguien bloqueó el bot o el navegador ya no existe, se borra su suscripción. Devuelve cuántos salieron.
 */
export async function mandarAvisos(
  db: BaseDeDatos,
  env: { TELEGRAM_TOKEN?: string; PUSH_CLAVE?: string },
  telegram: Aviso[],
  push: AvisoPush[],
): Promise<number> {
  let quedan = MAXIMO_POR_VEZ;
  let enviados = 0;
  for (const aviso of env.TELEGRAM_TOKEN ? telegram.slice(0, quedan) : []) {
    quedan--;
    const respuesta = await enviarMensaje(env.TELEGRAM_TOKEN!, aviso.chat, aviso.texto);
    if (respuesta.ok) {
      await marcarAvisado(db, aviso, Date.now());
      enviados++;
    } else if (respuesta.status === 403) {
      await olvidarChat(db, aviso.chat); // bloqueó al bot
    }
  }
  const clave = env.PUSH_CLAVE ? (JSON.parse(env.PUSH_CLAVE) as ClavePush) : null;
  for (const aviso of clave ? push.slice(0, quedan) : []) {
    quedan--;
    const respuesta = await enviarPush(aviso.suscripcion, aviso.mensaje, clave!, SITIO);
    if (respuesta.ok) {
      await marcarPushAvisado(db, aviso.suscripcion.endpoint, aviso.clave, Date.now());
      enviados++;
    } else if (respuesta.status === 404 || respuesta.status === 410) {
      await olvidarNavegador(db, aviso.suscripcion.endpoint); // la suscripción ya no existe
    }
  }
  return enviados;
}
