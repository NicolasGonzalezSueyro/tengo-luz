// Las suscripciones a notificaciones push y los avisos que les toca recibir (como el bot, pero en el navegador).
// El cifrado y el envío están en src/push.ts.

import { etiquetaDia, type Corte } from '../web/estado.js';
import { agruparAvisos } from './bot.ts';
import type { SuscripcionPush } from './push.ts';
import type { BaseDeDatos } from './reportes.ts';

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
