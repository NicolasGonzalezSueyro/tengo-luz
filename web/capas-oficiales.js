// @ts-check
// Las capas oficiales de barrios que publica el geoportal de la Provincia (Mapas Córdoba, IDECOR) para algunos
// municipios: capa del servicio WFS y campo con el nombre. Las usan src/barrios-interior.ts (para armar el mapa) y el
// editor de contornos del panel de admin (para buscar un barrio).

/** @type {Record<string, { capa: string, campo: string }>} */
export const BARRIOS_OFICIALES = {
  'Anisacate': { capa: 'anisacate_barrios', campo: 'nombre' },
  'Colonia Caroya': { capa: 'ccaroya_barrios', campo: 'nombre' },
  'Corralito': { capa: 'corralito_barrios', campo: 'nombre' },
  'Cosquín': { capa: 'cosquin_barrios', campo: 'nombre' },
  'Cruz Alta': { capa: 'cruzalta_barrios', campo: 'name' },
  'Hernando': { capa: 'hernando_barrios', campo: 'nombre' },
  'Jesús María': { capa: 'Jesus_Maria_Barrios', campo: 'barrios' },
  'La Falda': { capa: 'barrios_lf', campo: 'nombre_bar' },
  'Morteros': { capa: 'mteros_barrios', campo: 'name' },
  'Río Cuarto': { capa: 'riocuarto_vecinales', campo: 'nombre' },
  'Salsipuedes': { capa: 'barrios_salsipuedes', campo: 'nombre' },
  'Unquillo': { capa: 'unq_barrios', campo: 'nombre' },
  'Villa Allende': { capa: 'va_barrios', campo: 'nombre' },
  'Villa Giardino': { capa: 'Villa_Giardino_Barrios', campo: 'nombre' },
  'Villa María': { capa: 'vm_barrios', campo: 'nombre' },
};

/** Los loteos aprobados y autorizados de la Municipalidad de Córdoba (capital): nombre oficial y de fantasía. */
export const LOTEOS_CAPITAL = [
  { capa: 'loteos_muni_aprobados', campos: ['nombre', 'nombfant'] },
  { capa: 'loteos_muni_autorizados', campos: ['nombre', 'nombfant'] },
];
