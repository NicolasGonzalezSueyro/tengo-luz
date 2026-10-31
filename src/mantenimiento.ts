/** Cómo se llama Córdoba capital en el campo `localidad` (los cortes viejos, de antes de ampliar, no lo tienen). */
export const CAPITAL = 'Córdoba';

/** Un corte de luz programado, tal como lo guardamos en data/mantenimientos.json. */
export type Mantenimiento = {
  localidad: string; // CAPITAL, o el título de la sección de la nota ("Villa Carlos Paz", "Otras localidades"…)
  fecha: string; // AAAA-MM-DD
  desde: string; // HH:MM
  hasta: string; // HH:MM
  zona: string; // texto original, ej: "Barrio Argüello, en forma parcial."
  afectacion: 'parcial' | 'total' | null;
  fuente: string; // link a la nota de donde salió el dato
};

/**
 * Junta los mantenimientos ya guardados con los recién leídos.
 * Si llegó información nueva de un día, reemplaza la vieja de ese día (por si la nota se corrigió).
 */
export function unir(anteriores: Mantenimiento[], nuevos: Mantenimiento[]): Mantenimiento[] {
  const fechasNuevas = new Set(nuevos.map((m) => m.fecha));
  const porClave = new Map<string, Mantenimiento>();
  for (const m of [...anteriores.filter((m) => !fechasNuevas.has(m.fecha)), ...nuevos]) {
    porClave.set(`${m.localidad}|${m.fecha}|${m.desde}|${m.hasta}|${m.zona}`, m);
  }
  return [...porClave.values()].sort(
    (a, b) => a.fecha.localeCompare(b.fecha) || a.desde.localeCompare(b.desde) || a.zona.localeCompare(b.zona),
  );
}
