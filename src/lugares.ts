import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Arma data/lugares.js: la lista de nombres de barrios y zonas del mapa. La usa el bot de Telegram
// para reconocer el barrio que le escriben, sin tener que cargar el mapa entero (1,3 MB).
// Es un módulo JS (no un .json) porque el wrangler que usa Cloudflare para armar las funciones no sabe
// importar JSON con la sintaxis que pide Node. Se regenera solo al correr `npm run barrios` o `npm run zonas`,
// y el lector la regenera cuando agrega una localidad nueva.

type Coleccion = { features: { properties: { nombre: string | null; tipo?: string } }[] };

export function listarLugares(...colecciones: Coleccion[]): string[] {
  const nombres = colecciones.flatMap((c) => c.features.flatMap((f) => f.properties.nombre ?? []));
  return [...new Set(nombres)].sort((a, b) => a.localeCompare(b, 'es'));
}

/** Las localidades del interior (no los barrios de capital): sirven para darse cuenta si un texto mezcla las dos cosas. */
export const listarLocalidades = (zonas: Coleccion) =>
  listarLugares({ features: zonas.features.filter((f) => f.properties.tipo === 'localidad') });

export const leer = (archivo: string): Coleccion => JSON.parse(readFileSync(new URL(`../data/${archivo}`, import.meta.url), 'utf8'));

/** Todos los mapas: barrios de capital, zonas y localidades, y barrios del interior (si ya se armaron). */
export const leerTodo = (): Coleccion[] => [
  leer('barrios.geojson'),
  leer('zonas.geojson'),
  ...(existsSync(new URL('../data/barrios-interior.geojson', import.meta.url)) ? [leer('barrios-interior.geojson')] : []),
];

export function escribirLugares() {
  const lugares = listarLugares(...leerTodo());
  const localidades = listarLocalidades(leer('zonas.geojson'));
  const codigo = `// Generado por \`npm run lugares\` a partir de los mapas: no editar a mano.\nexport default ${JSON.stringify(lugares, null, 1)};\n`
    + `\n// Las que son localidades del interior (el resto son barrios y zonas de capital).\nexport const localidades = ${JSON.stringify(localidades, null, 1)};\n`;
  writeFileSync(new URL('../data/lugares.js', import.meta.url), codigo);
  console.log(`📝 data/lugares.js: ${lugares.length} lugares, ${localidades.length} localidades`);
}

if (import.meta.main) escribirLugares();
