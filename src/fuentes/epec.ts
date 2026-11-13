// Los cortes programados de EPEC (hoy, mañana y pasado). Un servicio externo los manda a /api/cortes-epec como una
// foto completa cada media hora; acá se validan, se guardan en D1 y se pasan al formato del lector (src/lector.ts).
// Si esta fuente deja de llegar, el lector vuelve a las notas de El Doce (src/fuentes/eldoce.ts).

import { afectacion } from './eldoce.ts';
import { CAPITAL, type Mantenimiento } from '../mantenimiento.ts';
import type { BaseDeDatos } from '../reportes.ts';

/** El link que se muestra como fuente de estos cortes. */
export const FUENTE_EPEC = 'https://www.epec.com.ar/actualidad/trabajos-mejoras';

export type CorteEpec = {
  id: string;
  fecha: string; // DD/MM/AAAA
  horaDesde: string; // HH:MM
  horaHasta: string;
  zona: string;
  localidad: string; // en mayúsculas y sin tildes: "CORDOBA" es capital
  motivoResumido?: string;
  codLocalidad?: number;
  estado?: string; // "P": programado
};

const MAXIMO = 300;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const DIA = 24 * 60 * 60 * 1000;
/** "13/11/2026" → milisegundos (al mediodía UTC), o NaN si ese día no existe ("99/99/2026", "31/02/2026"). */
function momentoDe(fecha: string): number {
  const [dia, mes, anio] = fecha.split('/').map(Number);
  const momento = Date.UTC(anio, mes - 1, dia, 12);
  const d = new Date(momento);
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? momento : NaN;
}

/**
 * Valida lo que llega: un array (o { cortes: [...] }) de hasta 300 cortes, con fechas que existan y no estén a más de
 * 60 días de hoy (una fecha del año 2099 quedaba para siempre como "un día que viene"). Devuelve los cortes o el motivo
 * del rechazo.
 */
export function cortesValidos(datos: unknown, ahora = Date.now()): CorteEpec[] | string {
  const lista = Array.isArray(datos) ? datos : (datos as { cortes?: unknown } | null)?.cortes;
  if (!Array.isArray(lista)) return 'Se espera un array de cortes';
  if (lista.length > MAXIMO) return `Mandá como mucho ${MAXIMO} cortes`;
  const texto = (v: unknown, maximo: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= maximo;
  const cortes: CorteEpec[] = [];
  for (const [i, valor] of lista.entries()) {
    const c = valor as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return `Corte ${i + 1}: no es un objeto`;
    const id = typeof c.id === 'number' ? String(c.id) : c.id;
    if (!texto(id, 40)) return `Corte ${i + 1}: falta el id`;
    if (typeof c.fecha !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(c.fecha)) return `Corte ${i + 1}: la fecha tiene que ser DD/MM/AAAA`;
    if (!(Math.abs(momentoDe(c.fecha) - ahora) <= 60 * DIA)) return `Corte ${i + 1}: la fecha ${c.fecha} no existe o está a más de 60 días de hoy`;
    if (typeof c.horaDesde !== 'string' || !HORA.test(c.horaDesde) || typeof c.horaHasta !== 'string' || !HORA.test(c.horaHasta)) {
      return `Corte ${i + 1}: el horario tiene que ser HH:MM`;
    }
    if (!texto(c.zona, 3000)) return `Corte ${i + 1}: falta la zona`;
    if (!texto(c.localidad, 100)) return `Corte ${i + 1}: falta la localidad`;
    cortes.push({
      id, fecha: c.fecha, horaDesde: c.horaDesde, horaHasta: c.horaHasta, zona: c.zona.trim(), localidad: c.localidad.trim(),
      ...(texto(c.motivoResumido, 200) ? { motivoResumido: c.motivoResumido } : {}),
      ...(typeof c.codLocalidad === 'number' ? { codLocalidad: c.codLocalidad } : {}),
      ...(texto(c.estado, 5) ? { estado: c.estado } : {}),
    });
  }
  return cortes;
}

// La última foto se guarda entera en una fila: cada envío trae todo lo publicado, así que reemplaza al anterior.
const listas = new WeakSet<BaseDeDatos>(); // la tabla se crea sola la primera vez (una vez por base)
async function prepararTabla(db: BaseDeDatos) {
  if (listas.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS fuente_epec (clave TEXT PRIMARY KEY, datos TEXT NOT NULL, recibido INTEGER NOT NULL)').bind().run();
  listas.add(db);
}

export async function guardarFoto(db: BaseDeDatos, cortes: CorteEpec[], ahora: number) {
  await prepararTabla(db);
  await db.prepare('INSERT OR REPLACE INTO fuente_epec (clave, datos, recibido) VALUES (?, ?, ?)').bind('ultima', JSON.stringify(cortes), ahora).run();
}

const MINUTOS_PARA_CONFIRMAR = 20;
/**
 * Guarda la foto que llegó, salvo que sea sospechosa: si se quedó sin más de la mitad de los cortes que todavía no
 * terminaron y que tenía la anterior (o llegó vacía), lo más probable es que el servicio que la manda haya leído mal
 * la página. Una foto así queda "en espera" y no reemplaza a la anterior; si la siguiente (al menos 20 minutos
 * después) también viene así, se acepta: entonces sí, EPEC sacó esos cortes. Sin esto, una lista vacía borraba del
 * mapa los cortes de tres días. `momento`: fecha (AAAA-MM-DD) y hora (HH:MM) de Córdoba.
 * Devuelve qué hizo; "en espera" es la primera vez (para avisarle al admin una sola vez).
 */
export async function recibirFoto(
  db: BaseDeDatos, cortes: CorteEpec[], ahora: number, momento: { fecha: string; hora: string },
): Promise<'guardada' | 'en espera' | 'sigue en espera'> {
  await prepararTabla(db);
  const sinTerminar = (c: CorteEpec) => {
    const fecha = c.fecha.split('/').reverse().join('-');
    return fecha > momento.fecha || (fecha === momento.fecha && c.horaHasta > momento.hora);
  };
  const antes = ((await leerFoto(db))?.cortes ?? []).filter(sinTerminar);
  const quedan = new Set(cortes.map((c) => c.id));
  const sospechosa = antes.length >= 2 && antes.filter((c) => quedan.has(c.id)).length < antes.length / 2;
  if (sospechosa) {
    const espera = await db.prepare('SELECT recibido FROM fuente_epec WHERE clave = ?').bind('espera').first();
    if (!espera) {
      await db.prepare('INSERT OR REPLACE INTO fuente_epec (clave, datos, recibido) VALUES (?, ?, ?)').bind('espera', '', ahora).run();
      return 'en espera';
    }
    if (ahora - Number(espera.recibido) < MINUTOS_PARA_CONFIRMAR * 60_000) return 'sigue en espera';
  }
  await db.prepare('DELETE FROM fuente_epec WHERE clave = ?').bind('espera').run();
  await guardarFoto(db, cortes, ahora);
  return 'guardada';
}

/**
 * El robot de GitHub corre cada media hora en teoría, pero GitHub posterga los horarios (en la práctica, cada 4 a 8
 * horas). Cuando la foto de EPEC es distinta de la última con la que se pidió una corrida, se le pide que corra ya,
 * como mucho una vez cada 10 minutos. Un cambio que llega antes de los 10 minutos se pide con el envío siguiente.
 */
export async function pedirQueCorraElRobot(db: BaseDeDatos, cortes: CorteEpec[], token: string, ahora: number): Promise<'pedido' | 'sin cambios' | 'hace poco' | 'fallo'> {
  await prepararTabla(db);
  const datos = JSON.stringify(cortes);
  const ultimo = await db.prepare('SELECT datos, recibido FROM fuente_epec WHERE clave = ?').bind('disparo').first();
  if (ultimo?.datos === datos) return 'sin cambios';
  if (ultimo && ahora - Number(ultimo.recibido) < 10 * 60 * 1000) return 'hace poco';
  await db.prepare('INSERT OR REPLACE INTO fuente_epec (clave, datos, recibido) VALUES (?, ?, ?)').bind('disparo', datos, ahora).run();
  const respuesta = await fetch('https://api.github.com/repos/NicolasGonzalezSueyro/tengo-luz/actions/workflows/actualizar.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tengo-luz' },
    body: JSON.stringify({ ref: 'main' }),
  }).catch(() => null);
  return respuesta?.ok ? 'pedido' : 'fallo';
}

export async function leerFoto(db: BaseDeDatos): Promise<{ recibido: number; cortes: CorteEpec[] } | null> {
  await prepararTabla(db);
  const fila = await db.prepare('SELECT datos, recibido FROM fuente_epec WHERE clave = ?').bind('ultima').first();
  return fila ? { recibido: Number(fila.recibido), cortes: JSON.parse(String(fila.datos)) as CorteEpec[] } : null;
}

/** "VILLA DEL TOTORAL" → "Villa del Totoral". Capital ("CORDOBA") es Córdoba. */
export function nombreDeLocalidad(localidad: string): string {
  if (/^c[oó]rdoba( capital)?$/i.test(localidad.trim())) return CAPITAL;
  return localidad.trim().toLowerCase()
    .replace(/(^|\s)\p{L}/gu, (l) => l.toUpperCase())
    .replace(/ (De|Del|La|Las|Los|El|Y)(?= )/g, (p) => p.toLowerCase());
}

/** Los cortes de EPEC en el formato del lector. Los que no están "P" (programado) no se muestran. */
export function aMantenimientos(cortes: CorteEpec[]): Mantenimiento[] {
  return cortes.filter((c) => !c.estado || c.estado.toUpperCase() === 'P').map((c) => {
    const [dia, mes, anio] = c.fecha.split('/');
    return {
      localidad: nombreDeLocalidad(c.localidad), fecha: `${anio}-${mes}-${dia}`, desde: c.horaDesde, hasta: c.horaHasta,
      zona: c.zona, afectacion: afectacion(c.zona), fuente: FUENTE_EPEC,
    };
  });
}

/** Lee la última foto desde el sitio (el robot de GitHub). Sin la clave o sin respuesta, null: se usa El Doce. */
export async function leerCortesEpec(sitio = process.env.SITIO ?? 'https://tengo-luz.pages.dev', clave = process.env.EPEC_OFICIAL_KEY) {
  if (!clave) return null;
  const respuesta = await fetch(`${sitio}/api/cortes-epec`, { headers: { Authorization: `Bearer ${clave}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!respuesta?.ok) return null;
  return (await respuesta.json()) as { recibido: number; cortes: CorteEpec[] };
}
