import type { Mantenimiento } from '../mantenimiento.ts';

// Fuente temporal: las notas diarias de El Doce con los cortes programados que anuncia EPEC.
// Si algún día EPEC da acceso a sus datos, se reemplaza este archivo y el resto queda igual.

const SITEMAP = 'https://eldoce.tv/arc/outboundfeeds/news-sitemap/?outputType=xml';

// Nos identificamos para que El Doce sepa quién hace los pedidos y cómo contactarnos.
const HEADERS = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// Una hora como la escriben en las notas: "8", "8:30", "8.30" o "08:30".
const HORA = String.raw`\d{1,2}(?:[:.]\d{2})?`;
// Un renglón de corte: guion opcional, uno o más rangos ("De 8 a 12:30", "De 6 a 7.30 y de 14 a 17 hs"), dos puntos y la zona.
const CORTE = new RegExp(String.raw`^[-–—•]?\s*(De ${HORA} a ${HORA}(?: y de ${HORA} a ${HORA})*)(?: ?hs\.?)?\s*:\s*(.+)$`, 'i');
// Para detectar renglones que parecen un corte aunque no tengan el formato esperado.
const PARECE_CORTE = new RegExp(String.raw`\bde ${HORA} a ${HORA}`, 'i');

export type ResultadoNota = {
  mantenimientos: Mantenimiento[];
  noReconocidas: string[]; // renglones de capital que parecen cortes pero no entendimos, para revisarlos a mano
};

export async function descargar(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.text();
}

/** Devuelve los links a las notas de cortes de luz que figuran en el sitemap de noticias (las más nuevas primero). */
export async function buscarNotas(): Promise<string[]> {
  const xml = await descargar(SITEMAP);
  return [...xml.matchAll(/<loc>([^<]*\/cortes-de-luz-de-epec[^<]*)<\/loc>/g)].map((m) => m[1]);
}

/**
 * Extrae los cortes de Córdoba capital de una nota de El Doce.
 *
 * El formato del HTML cambia de un día a otro (listas, párrafos con guion, "Córdoba" o "Córdoba capital"),
 * así que convertimos la nota en renglones de texto y la recorremos así:
 * un título de ciudad abre una sección, y cada renglón "De HH a HH: zona" dentro de la de capital es un corte.
 */
export function parsearNota(html: string, url: string): ResultadoNota {
  const fecha = fechaDeLosCortes(html, url);
  const renglones = renglonesDelCuerpo(html);

  const mantenimientos: Mantenimiento[] = [];
  const noReconocidas: string[] = [];
  let cortesEnLaNota = 0;
  let enCapital = false;

  for (const renglon of renglones) {
    const corte = leerCorte(renglon);
    if (corte) cortesEnLaNota += corte.rangos.length;

    if (/^C[oó]rdoba(?: capital)?$/i.test(renglon)) {
      enCapital = true;
    } else if (enCapital && corte) {
      for (const [desde, hasta] of corte.rangos) {
        mantenimientos.push({ fecha, desde, hasta, zona: corte.zona, afectacion: afectacion(corte.zona), fuente: url });
      }
    } else if (enCapital && PARECE_CORTE.test(renglon)) {
      noReconocidas.push(renglon);
    } else if (enCapital) {
      enCapital = false; // cualquier otro renglón (otra ciudad, el pie de la nota) cierra la sección
    }
  }

  // Si la nota no tiene ni un corte reconocible, seguro cambió el formato: mejor fallar que guardar "no hay cortes".
  if (cortesEnLaNota === 0) throw new Error(`No reconocí ningún corte en ${url}; ¿cambió el formato de la nota?`);
  return { mantenimientos, noReconocidas };
}

/** "-De 6 a 7.30 y de 14 a 17: Barrio Argentino." → rangos [["06:00","07:30"],["14:00","17:00"]] y la zona. */
function leerCorte(renglon: string): { rangos: [string, string][]; zona: string } | null {
  const m = renglon.match(CORTE);
  if (!m) return null;
  const rangos = [...m[1].matchAll(new RegExp(`(${HORA}) a (${HORA})`, 'gi'))].map(
    ([, desde, hasta]) => [hora(desde), hora(hasta)] as [string, string],
  );
  return { rangos, zona: m[2].trim() };
}

function afectacion(zona: string): Mantenimiento['afectacion'] {
  const parcial = /en forma parcial/i.test(zona);
  const total = /en forma total/i.test(zona);
  if (parcial === total) return null; // no lo dice, o dice las dos cosas para distintos barrios
  return parcial ? 'parcial' : 'total';
}

/** La fecha de los cortes es la primera que aparece después del título, sin contar la fecha de publicación. */
function fechaDeLosCortes(html: string, url: string): string {
  const publicada = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!publicada) throw new Error(`No encontré la fecha de publicación en el link ${url}`);
  const inicio = html.indexOf('</h1>');
  if (inicio < 0) throw new Error(`No encontré el título de la nota ${url}`);

  const cuerpo = html.slice(inicio).replace(/<time[\s\S]*?<\/time>/g, '');
  const m = cuerpo.match(new RegExp(`(\\d{1,2}) de (${MESES.join('|')})`, 'i'));
  if (!m) throw new Error(`No encontré la fecha de los cortes en ${url}`);

  const [anioPub, mesPub, diaPub] = publicada.slice(1).map(Number);
  const dia = Number(m[1]);
  const mes = MESES.indexOf(m[2].toLowerCase()) + 1;
  // Una nota de fines de diciembre puede anunciar cortes de enero del año siguiente.
  const anio = mes < mesPub ? anioPub + 1 : anioPub;

  // Control de cordura: los cortes se anuncian para los días siguientes a la nota, no para el pasado.
  const dias = (Date.UTC(anio, mes - 1, dia) - Date.UTC(anioPub, mesPub - 1, diaPub)) / 86_400_000;
  if (dias < 0 || dias > 7) throw new Error(`La fecha ${dia}/${mes} no tiene sentido para una nota del ${diaPub}/${mesPub} (${url})`);

  return `${anio}-${dos(mes)}-${dos(dia)}`;
}

/** Convierte el HTML de la nota (desde el título) en renglones de texto, uno por párrafo, ítem o título. */
function renglonesDelCuerpo(html: string): string[] {
  const cuerpo = html
    .slice(html.indexOf('</h1>'))
    .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(p|li|ul|ol|h\d|div|br|main|section|article|figcaption)\b[^>]*>/gi, '\n');
  return cuerpo.split('\n').map(textoPlano).filter(Boolean);
}

function hora(texto: string): string {
  const [h, m = '00'] = texto.split(/[:.]/);
  return `${dos(Number(h))}:${m}`;
}

function dos(n: number): string {
  return String(n).padStart(2, '0');
}

function textoPlano(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
