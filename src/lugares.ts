import { readFileSync, writeFileSync } from 'node:fs';

// Arma data/lugares.js: la lista de nombres de barrios y zonas del mapa. La usa el bot de Telegram
// para reconocer el barrio que le escriben, sin tener que cargar el mapa entero (1,3 MB).
// Es un módulo JS (no un .json) porque el wrangler que usa Cloudflare para armar las funciones no sabe
// importar JSON con la sintaxis que pide Node. Se regenera solo al correr `npm run barrios` o `npm run zonas`.

type Coleccion = { features: { properties: { nombre: string | null } }[] };

export function listarLugares(...colecciones: Coleccion[]): string[] {
  const nombres = colecciones.flatMap((c) => c.features.flatMap((f) => f.properties.nombre ?? []));
  return [...new Set(nombres)].sort((a, b) => a.localeCompare(b, 'es'));
}

export const leer = (archivo: string): Coleccion => JSON.parse(readFileSync(new URL(`../data/${archivo}`, import.meta.url), 'utf8'));

if (import.meta.main) {
  const lugares = listarLugares(leer('barrios.geojson'), leer('zonas.geojson'));
  const codigo = `// Generado por \`npm run lugares\` a partir de los mapas: no editar a mano.\nexport default ${JSON.stringify(lugares, null, 1)};\n`;
  writeFileSync(new URL('../data/lugares.js', import.meta.url), codigo);
  console.log(`📝 data/lugares.js: ${lugares.length} lugares`);
}
