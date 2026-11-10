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
  const aliasArchivo = new URL('../data/alias-interior.json', import.meta.url);
  const alias: Record<string, string | null> = existsSync(aliasArchivo) ? JSON.parse(readFileSync(aliasArchivo, 'utf8')) : {};
  // Más los nombres de los barrios repetidos que se juntaron ("Tejas 4 (Malagueño)" → "Country Tejas Cuatro (Malagueño)").
  const interior = existsSync(new URL('../data/barrios-interior.geojson', import.meta.url)) ? leer('barrios-interior.geojson') : { features: [] };
  for (const f of interior.features as { properties: { nombre: string; localidad?: string; alias?: string[] } }[]) {
    for (const a of f.properties.alias ?? []) alias[`${a} (${f.properties.localidad})`] ??= f.properties.nombre;
  }
  const codigo = `// Generado por \`npm run lugares\` a partir de los mapas: no editar a mano.\nexport default ${JSON.stringify(lugares, null, 1)};\n`
    + `\n// Las que son localidades del interior (el resto son barrios y zonas de capital).\nexport const localidades = ${JSON.stringify(localidades, null, 1)};\n`
    + `\n// Cómo escribe EPEC algunos barrios del interior que en el mapa tienen otro nombre (data/alias-interior.json).\n`
    + `/** @type {Record<string, string | null>} */\nexport const alias = ${JSON.stringify(alias, null, 1)};\n`;
  writeFileSync(new URL('../data/lugares.js', import.meta.url), codigo);
  console.log(`📝 data/lugares.js: ${lugares.length} lugares, ${localidades.length} localidades`);
}

if (import.meta.main) escribirLugares();
