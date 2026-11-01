// El bot de Telegram. Acá está toda la lógica, sin nada de Telegram ni de
// Cloudflare: qué contestar a cada comando y a quién avisar de cada corte. Así se puede probar con tests.

import { etiquetaDia, lugaresDelCorte, type Corte } from '../web/estado.js';
import { estadisticas, limpiarReportes } from './admin.ts';
import {
  cancelarFalla, confirmarFallas, corregirLugares, DURACION, fallasPendientes, LINK_X, linksDeX, lugaresEnTexto, MAXIMO_LINKS,
  prepararFalla, terminarFallas, textoDePublicacion, type Falla,
} from './fallas.ts';
import { contarReportes, type BaseDeDatos } from './reportes.ts';

export const SITIO = 'https://tengo-luz.pages.dev';
const MAXIMO_BARRIOS = 10; // por chat, para que nadie llene la base

const AYUDA = `¡Hola! Soy el bot de ¿Tengo luz? ⚡
Te aviso cuando EPEC anuncia un corte programado en tus barrios de Córdoba capital o en tu localidad de la provincia (/barrio Villa María), y cuando varios vecinos reportan que se quedaron sin luz.

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
/limpiar Alberdi → borrar los reportes de un barrio

⚠️ Fallas que confirma EPEC:
Compartime los links de las publicaciones de EPEC en X (hasta ${MAXIMO_LINKS} en un mismo mensaje), o mandá /falla con el texto (por ejemplo, copiado de Facebook). Te muestro qué lugares reconocí y las publicás todas con /confirmar.
/fin_falla → sacar las fallas del mapa cuando vuelve la luz`;

const HORAS_FALLA = DURACION / (60 * 60 * 1000);
const recortar = (texto: string, largo: number) => (texto.length > largo ? `${texto.slice(0, largo - 1)}…` : texto);

/** Las fallas que esperan confirmación, numeradas, para que el admin las revise antes de publicarlas. */
function revisarFallas(pendientes: Falla[], avisos: string[] = []) {
  if (pendientes.length === 0) return [...avisos, 'No hay fallas esperando.'].join('\n');
  const listas = pendientes.filter((f) => f.lugares.length > 0).length;
  return [
    ...avisos,
    ...(avisos.length > 0 ? [''] : []),
    `⚠️ ${pendientes.length === 1 ? 'Falla para publicar' : `${pendientes.length} fallas para publicar`}:`,
    ...pendientes.flatMap((f, i) => [
      '',
      `${i + 1}. “${recortar(f.texto, 300)}”`,
      f.lugares.length > 0 ? `   📍 ${f.lugares.join(', ')}` : '   ❓ No reconocí barrios ni localidades del mapa',
    ]),
    '',
    ...(listas > 0 ? [`/confirmar → publicar ${listas === pendientes.length ? (listas === 1 ? 'la falla' : 'todas') : `las ${listas} que tienen lugares`} por ${HORAS_FALLA} horas y avisar a quienes siguen esos lugares`] : []),
    `/corregir ${pendientes.length > 1 ? '2 ' : ''}Alberdi, Centro → cambiar los lugares${pendientes.length > 1 ? ' de la 2' : ''}`,
    pendientes.length > 1 ? '/cancelar 2 → descartar la 2 (/cancelar solo: todas)' : '/cancelar → descartarla',
  ].join('\n');
}

/** "2 Alberdi, Centro" → la falla número 2 y el resto del texto. Sin número, solo vale si hay una sola esperando. */
function elegirPendiente(pendientes: Falla[], argumento: string): { falla?: Falla; resto: string; error?: string } {
  const numero = argumento.match(/^(\d+)\b\s*(.*)$/s);
  if (numero) {
    const falla = pendientes[Number(numero[1]) - 1];
    return falla ? { falla, resto: numero[2] } : { resto: '', error: `No hay una falla número ${numero[1]} esperando.` };
  }
  if (pendientes.length > 1) return { resto: argumento, error: 'Hay varias fallas esperando: decime el número, por ejemplo /corregir 2 Alberdi, Centro' };
  return { falla: pendientes[0], resto: argumento };
}

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
  {
    lugares, esAdmin, ahora = Date.now(), avisarFalla,
  }: { lugares: string[]; esAdmin: boolean; ahora?: number; avisarFalla?: (falla: Falla) => Promise<void> },
): Promise<string> {
  // El admin compartió el link de una publicación de X sin comando: es una falla para cargar.
  if (esAdmin && !texto.trim().startsWith('/') && LINK_X.test(texto)) texto = `/falla ${texto}`;
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
    switch (comando) {
      case '/estado': {
        const e = await estadisticas(db, ahora);
        return [
          '📊 Estado',
          `Personas con avisos: ${e.personas}`,
          `Barrios seguidos: ${e.barriosSeguidos}`,
          `Celulares con notificaciones: ${e.notificaciones}`,
          `Avisos mandados (últimos 30 días): ${e.avisos}`,
          `Barrios con reportes ahora: ${Object.keys(e.reportes).length}`,
          `Panel completo: ${SITIO}/admin`,
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
          const cuantos = await limpiarReportes(db);
          return `🧹 Borré ${cuantos} ${cuantos === 1 ? 'reporte' : 'reportes'}. En un minuto el mapa deja de mostrar barrios en rojo.`;
        }
        const [barrio] = buscarLugar(Object.keys(await contarReportes(db, ahora)), argumento);
        if (!barrio) return `No hay reportes de "${argumento}". Mirá cuáles hay con /reportes`;
        await limpiarReportes(db, barrio);
        return `🧹 Borré los reportes de ${barrio}.`;
      }

      case '/falla': {
        if (!argumento) return `Compartime los links de las publicaciones de EPEC en X (hasta ${MAXIMO_LINKS} juntos), o mandá /falla con el texto (por ejemplo, copiado de Facebook).`;
        const links = linksDeX(argumento);
        const avisos: string[] = [];
        if (links.length > MAXIMO_LINKS) avisos.push(`Recibí ${links.length} links: leí los primeros ${MAXIMO_LINKS}. Mandame el resto en otro mensaje.`);
        if (links.length === 0) {
          await prepararFalla(db, { texto: argumento, fuente: null, lugares: lugaresEnTexto(lugares, argumento) }, ahora);
        }
        for (const link of links.slice(0, MAXIMO_LINKS)) {
          const publicacion = await textoDePublicacion(link);
          if (!publicacion) {
            avisos.push(`No pude leer ${link}: copiá su texto y mandalo con /falla delante.`);
            continue;
          }
          await prepararFalla(db, { texto: publicacion.texto, fuente: link, lugares: lugaresEnTexto(lugares, publicacion.texto) }, ahora);
        }
        return revisarFallas(await fallasPendientes(db), avisos);
      }

      case '/corregir': {
        const pendientes = await fallasPendientes(db);
        if (pendientes.length === 0) return 'No hay ninguna falla esperando. Empezá compartiendo el link o con /falla.';
        const { falla, resto, error } = elegirPendiente(pendientes, argumento);
        if (error || !falla) return error ?? 'No hay ninguna falla esperando.';
        if (!resto) return 'Escribí los lugares separados por comas, por ejemplo /corregir Alberdi, Centro';
        const pedidos = resto.split(/,|\s+y\s+/).map((p) => p.trim()).filter(Boolean);
        const elegidos = pedidos.map((p) => buscarLugar(lugares, p));
        const dudosos = pedidos.filter((_, i) => elegidos[i].length !== 1);
        if (dudosos.length > 0) return `No encontré un único lugar para: ${dudosos.join(', ')}. Probá con el nombre completo.`;
        await corregirLugares(db, falla.id, [...new Set(elegidos.map(([l]) => l))]);
        return revisarFallas(await fallasPendientes(db));
      }

      case '/confirmar': {
        const pendientes = await fallasPendientes(db);
        if (pendientes.length === 0) return 'No hay ninguna falla esperando confirmación.';
        const publicadas = await confirmarFallas(db, ahora);
        if (publicadas.length === 0) return 'Primero decime los lugares con /corregir Alberdi, Centro';
        for (const falla of publicadas) await avisarFalla?.(falla);
        const lugaresPublicados = [...new Set(publicadas.flatMap((f) => f.lugares))];
        const quedan = pendientes.length - publicadas.length;
        return [
          `✅ ${publicadas.length === 1 ? 'Publicada' : `Publiqué ${publicadas.length} fallas`}: ${lugaresPublicados.join(', ')} ya se ven en el mapa como falla confirmada por ${HORAS_FALLA} horas. Estoy avisando a quienes siguen esos lugares.`,
          ...(quedan > 0 ? ['', `Quedan ${quedan} sin lugares: corregilas con /corregir o descartalas con /cancelar.`] : []),
          '',
          'Cuando vuelva la luz: /fin_falla',
        ].join('\n');
      }

      case '/cancelar': {
        if (!argumento) {
          await cancelarFalla(db);
          return 'Listo, descarté las fallas que estaban esperando.';
        }
        const { falla, error } = elegirPendiente(await fallasPendientes(db), argumento);
        if (error || !falla) return error ?? 'No hay ninguna falla esperando.';
        await cancelarFalla(db, falla.id);
        return revisarFallas(await fallasPendientes(db), ['Listo, la descarté.']);
      }

      case '/fin_falla': {
        const cuantas = await terminarFallas(db, ahora);
        return cuantas > 0
          ? `✅ Saqué ${cuantas === 1 ? 'la falla' : `${cuantas} fallas`} del mapa. En un minuto deja de verse.`
          : 'No hay fallas publicadas ahora.';
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

/**
 * Lo común a Telegram y a las notificaciones push: para cada corte de hoy en adelante, un aviso por destino
 * (un chat, o un navegador) con sus barrios que toca ese corte, salvo que ya se le haya avisado.
 * Un solo aviso aunque siga dos barrios del mismo corte.
 */
export function agruparAvisos<D extends string | number>(
  suscripciones: { destino: D; barrio: string }[],
  yaAvisados: Set<string>, // "destino|clave"
  cortes: Corte[],
  hoy: string,
): { destino: D; clave: string; corte: Corte; barrios: string[] }[] {
  const avisos = [];
  for (const corte of cortes.filter((c) => c.fecha >= hoy)) {
    const clave = claveDelCorte(corte);
    const lugares = lugaresDelCorte(corte);
    const porDestino = new Map<D, string[]>();
    for (const { destino, barrio } of suscripciones) {
      if (lugares.includes(barrio)) porDestino.set(destino, [...(porDestino.get(destino) ?? []), barrio]);
    }
    for (const [destino, barrios] of porDestino) {
      if (!yaAvisados.has(`${destino}|${clave}`)) avisos.push({ destino, clave, corte, barrios });
    }
  }
  return avisos;
}

/** Los avisos de Telegram que faltan mandar. */
export async function avisosPendientes(db: BaseDeDatos, cortes: Corte[], hoy: string): Promise<Aviso[]> {
  if (!cortes.some((c) => c.fecha >= hoy)) return [];
  const suscripciones = (await db.prepare('SELECT chat, barrio FROM suscripciones').bind().all()).results;
  const yaAvisados = new Set(
    (await db.prepare('SELECT chat, clave FROM avisados').bind().all()).results.map((r) => `${r.chat}|${r.clave}`),
  );
  return agruparAvisos(suscripciones.map((s) => ({ destino: Number(s.chat), barrio: String(s.barrio) })), yaAvisados, cortes, hoy)
    .map(({ destino, clave, corte, barrios }) => ({ chat: destino, clave, texto: textoDelAviso(corte, barrios, hoy) }));
}

export async function yaAvisado(db: BaseDeDatos, aviso: Pick<Aviso, 'chat' | 'clave'>): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS si FROM avisados WHERE chat = ? AND clave = ?').bind(aviso.chat, aviso.clave).first()) !== null;
}

export async function marcarAvisado(db: BaseDeDatos, aviso: Pick<Aviso, 'chat' | 'clave'>, ahora: number) {
  await db.prepare('INSERT OR IGNORE INTO avisados (chat, clave, creado) VALUES (?, ?, ?)').bind(aviso.chat, aviso.clave, ahora).run();
  // Los cortes viejos ya no se avisan: no hace falta recordarlos.
  await db.prepare('DELETE FROM avisados WHERE creado < ?').bind(ahora - 30 * 24 * 60 * 60 * 1000).run();
}

/** Si alguien bloqueó el bot, Telegram no deja mandarle más mensajes: borramos sus suscripciones. */
export async function olvidarChat(db: BaseDeDatos, chat: number) {
  await db.prepare('DELETE FROM suscripciones WHERE chat = ?').bind(chat).run();
}
