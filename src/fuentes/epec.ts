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

/** Valida lo que llega: un array (o { cortes: [...] }) de hasta 300 cortes. Devuelve los cortes o el motivo del rechazo. */
export function cortesValidos(datos: unknown): CorteEpec[] | string {
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
