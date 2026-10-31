// El bot de Telegram. Acá está toda la lógica, sin nada de Telegram ni de
// Cloudflare: qué contestar a cada comando y a quién avisar de cada corte. Así se puede probar con tests.

import { etiquetaDia, lugaresDelCorte, type Corte } from '../web/estado.js';
import { contarReportes, type BaseDeDatos } from './reportes.ts';

export const SITIO = 'https://tengo-luz.pages.dev';
const MAXIMO_BARRIOS = 10; // por chat, para que nadie llene la base

const AYUDA = `¡Hola! Soy el bot de ¿Tengo luz? ⚡
Te aviso cuando EPEC anuncia un corte programado en tus barrios de Córdoba capital.

/barrio Alberdi → recibir avisos de Alberdi
/mis_barrios → ver tus barrios
/borrar Alberdi → dejar de recibir avisos de Alberdi
/borrar todo → dejar de recibir todos los avisos

Mapa: ${SITIO}
Sitio no oficial, sin relación con EPEC.`;

const AYUDA_ADMIN = `

👑 Comandos de admin:
/estado → números del sitio y del bot
/reportes → barrios con reportes de vecinos
/limpiar → borrar todos los reportes de vecinos
/limpiar Alberdi → borrar los reportes de un barrio`;

/** Para comparar nombres sin importar tildes, mayúsculas ni espacios de más. */
const simplificar = (texto: string) =>
  texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Los lugares que coinciden con lo que escribió la persona: el exacto si lo hay, si no todos los que lo contienen. */
export function buscarLugar(lugares: string[], texto: string): string[] {
  const buscado = simplificar(texto);
  if (!buscado) return [];
  const exacto = lugares.find((l) => simplificar(l) === buscado);
  return exacto ? [exacto] : lugares.filter((l) => simplificar(l).includes(buscado));
}

const lista = (nombres: string[]) => nombres.map((n) => `• ${n}`).join('\n');

/** Qué contestarle a un mensaje. */
export async function responder(
  db: BaseDeDatos,
  chat: number,
  texto: string,
  { lugares, esAdmin, ahora = Date.now() }: { lugares: string[]; esAdmin: boolean; ahora?: number },
): Promise<string> {
  const [primera = '', ...resto] = texto.trim().split(/\s+/);
  // En grupos, Telegram manda los comandos como "/barrio@NombreDelBot".
  const comando = primera.toLowerCase().replace(/@\w+$/, '');
  const argumento = resto.join(' ');
  const misBarrios = async () =>
    (await db.prepare('SELECT barrio FROM suscripciones WHERE chat = ? ORDER BY barrio').bind(chat).all()).results.map((r) => String(r.barrio));

  switch (comando) {
    case '/start':
    case '/ayuda':
    case '/help':
      return `${AYUDA}${esAdmin ? AYUDA_ADMIN : ''}`;

    // No figura en la ayuda: sirve para saber qué número poner en TELEGRAM_ADMIN.
    case '/mi_id':
      return `Tu número de chat es ${chat}.`;

    case '/barrio': {
      if (!argumento) return 'Escribí el barrio después del comando. Por ejemplo: /barrio Alberdi';
      const opciones = buscarLugar(lugares, argumento);
      if (opciones.length === 0) return `No encontré "${argumento}". Probá con otro nombre, o buscalo en el mapa: ${SITIO}`;
      if (opciones.length > 1) {
        const primeras = opciones.slice(0, 10);
        return `Encontré ${opciones.length} lugares. Mandá /barrio con el nombre completo:\n${lista(primeras)}${opciones.length > 10 ? '\n…' : ''}`;
      }
      const [barrio] = opciones;
      const actuales = await misBarrios();
      if (actuales.includes(barrio)) return `Ya te aviso de ${barrio}.`;
      if (actuales.length >= MAXIMO_BARRIOS) return `Podés seguir hasta ${MAXIMO_BARRIOS} barrios. Borrá alguno con /borrar.`;
      await db.prepare('INSERT INTO suscripciones (chat, barrio, creado) VALUES (?, ?, ?)').bind(chat, barrio, ahora).run();
      return `Listo ✅ Te aviso cuando anuncien un corte en ${barrio}.`;
    }

    case '/mis_barrios': {
      const actuales = await misBarrios();
      return actuales.length > 0
        ? `Te aviso de estos barrios:\n${lista(actuales)}`
        : 'Todavía no seguís ningún barrio. Probá con /barrio Alberdi';
    }

    case '/borrar': {
      if (!argumento) return 'Escribí qué barrio borrar, por ejemplo /borrar Alberdi, o /borrar todo.';
      if (simplificar(argumento) === 'todo') {
        await db.prepare('DELETE FROM suscripciones WHERE chat = ?').bind(chat).run();
        return 'Listo, no te mando más avisos. Si querés volver: /barrio y el nombre.';
      }
      const [barrio] = buscarLugar(await misBarrios(), argumento);
      if (!barrio) return `No seguís "${argumento}". Mirá tus barrios con /mis_barrios`;
      await db.prepare('DELETE FROM suscripciones WHERE chat = ? AND barrio = ?').bind(chat, barrio).run();
      return `Listo, ya no te aviso de ${barrio}.`;
    }
  }

  if (esAdmin) {
    const numero = async (sql: string) => Number((await db.prepare(sql).bind().first())?.n ?? 0);
    switch (comando) {
      case '/estado': {
        const reportes = await contarReportes(db, ahora);
        return [
          '📊 Estado',
          `Personas con avisos: ${await numero('SELECT COUNT(DISTINCT chat) AS n FROM suscripciones')}`,
          `Barrios seguidos: ${await numero('SELECT COUNT(*) AS n FROM suscripciones')}`,
          `Avisos mandados (últimos 30 días): ${await numero('SELECT COUNT(*) AS n FROM avisados')}`,
          `Barrios con reportes ahora: ${Object.keys(reportes).length}`,
        ].join('\n');
      }

      case '/reportes': {
        const reportes = Object.entries(await contarReportes(db, ahora)).sort((a, b) => b[1].cantidad - a[1].cantidad);
        return reportes.length > 0
          ? `🔴 Reportes de las últimas 3 horas:\n${lista(reportes.map(([b, r]) => `${b}: ${r.cantidad}`))}`
          : 'No hay reportes de vecinos en las últimas 3 horas.';
      }

      case '/limpiar': {
        if (!argumento) {
          const cuantos = await numero('SELECT COUNT(*) AS n FROM reportes');
          await db.prepare('DELETE FROM reportes').bind().run();
          return `🧹 Borré ${cuantos} ${cuantos === 1 ? 'reporte' : 'reportes'}. En un minuto el mapa deja de mostrar barrios en rojo.`;
        }
        const [barrio] = buscarLugar(Object.keys(await contarReportes(db, ahora)), argumento);
        if (!barrio) return `No hay reportes de "${argumento}". Mirá cuáles hay con /reportes`;
        await db.prepare('DELETE FROM reportes WHERE barrio = ?').bind(barrio).run();
        return `🧹 Borré los reportes de ${barrio}.`;
      }
    }
  }

  return 'No entendí ese mensaje. Mandá /ayuda para ver lo que puedo hacer.';
}

// ---------------------------------------------------------------------------------------------
// Avisos de cortes
// ---------------------------------------------------------------------------------------------

export type Aviso = { chat: number; clave: string; texto: string };

/** Identifica un corte. Si EPEC cambia el horario o la zona, es otro corte y se vuelve a avisar. */
const claveDelCorte = (c: Corte) => `${c.fecha} ${c.desde}-${c.hasta} ${c.zona}`;

function textoDelAviso(corte: Corte, barrios: string[], hoy: string) {
  const afectacion = corte.afectacion ? ` (${corte.afectacion})` : '';
  return [
    `⚡ Corte programado en ${barrios.join(', ')}`,
    `📅 ${etiquetaDia(corte.fecha, hoy)}`,
    `🕗 De ${corte.desde} a ${corte.hasta}${afectacion}`,
    `📍 ${corte.zona}`,
    '',
    `Mapa: ${SITIO}`,
  ].join('\n');
}

/** Los avisos que faltan mandar: un mensaje por persona y por corte de hoy en adelante en sus barrios. */
export async function avisosPendientes(db: BaseDeDatos, cortes: Corte[], hoy: string): Promise<Aviso[]> {
  const futuros = cortes.filter((c) => c.fecha >= hoy);
  if (futuros.length === 0) return [];
  const suscripciones = (await db.prepare('SELECT chat, barrio FROM suscripciones').bind().all()).results;
  const yaAvisados = new Set(
    (await db.prepare('SELECT chat, clave FROM avisados').bind().all()).results.map((r) => `${r.chat}|${r.clave}`),
  );
  const avisos: Aviso[] = [];
  for (const corte of futuros) {
    const clave = claveDelCorte(corte);
    const lugares = lugaresDelCorte(corte);
    // chat → sus barrios que toca este corte (un solo mensaje aunque siga dos barrios del mismo corte)
    const porChat = new Map<number, string[]>();
    for (const { chat, barrio } of suscripciones) {
      if (lugares.includes(String(barrio))) porChat.set(Number(chat), [...(porChat.get(Number(chat)) ?? []), String(barrio)]);
    }
    for (const [chat, barrios] of porChat) {
      if (!yaAvisados.has(`${chat}|${clave}`)) avisos.push({ chat, clave, texto: textoDelAviso(corte, barrios, hoy) });
    }
  }
  return avisos;
}

export async function marcarAvisado(db: BaseDeDatos, aviso: Aviso, ahora: number) {
  await db.prepare('INSERT OR IGNORE INTO avisados (chat, clave, creado) VALUES (?, ?, ?)').bind(aviso.chat, aviso.clave, ahora).run();
  // Los cortes viejos ya no se avisan: no hace falta recordarlos.
  await db.prepare('DELETE FROM avisados WHERE creado < ?').bind(ahora - 30 * 24 * 60 * 60 * 1000).run();
}

/** Si alguien bloqueó el bot, Telegram no deja mandarle más mensajes: borramos sus suscripciones. */
export async function olvidarChat(db: BaseDeDatos, chat: number) {
  await db.prepare('DELETE FROM suscripciones WHERE chat = ?').bind(chat).run();
}
