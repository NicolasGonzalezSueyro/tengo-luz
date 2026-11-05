// Achica las fallas publicadas al sector exacto (npm run sectores-fallas). Lo corre el robot de GitHub.
//
// Una falla aparece al instante pintando sus barrios enteros. Si EPEC describe calles ("sector comprendido por
// calles X, Y y Z"), este programa arma el área exacta con OpenStreetMap (src/sectores.ts, igual que para los
// cortes programados) y se la manda al sitio, que pinta solo ese sector. En Cloudflare no se puede: no da tiempo de
// procesamiento para consultar OpenStreetMap.
// Necesita el secreto FALLAS_CLAVE (el mismo que en Cloudflare); sin él, no hace nada.

import { readFile } from 'node:fs/promises';
import { barrioEnPunto } from '../web/estado.js';
import { sectorDelCorte, type Caja } from './sectores.ts';

const SITIO = process.env.SITIO ?? 'https://tengo-luz.pages.dev';
const CLAVE = process.env.FALLAS_CLAVE;
type Lugar = { properties: { nombre: string | null; tipo?: string }; geometry: { type: string; coordinates: unknown } };

/** La caja [sur, oeste, norte, este] que encierra a todas las geometrías, agrandada `margen` grados. */
function cajaDe(lugares: Lugar[], margen: number): Caja {
  const puntos = lugares.flatMap((f) => (f.geometry.coordinates as unknown[]).flat(3) as number[]);
  const lons = puntos.filter((_, i) => i % 2 === 0);
  const lats = puntos.filter((_, i) => i % 2 === 1);
  return [Math.min(...lats) - margen, Math.min(...lons) - margen, Math.max(...lats) + margen, Math.max(...lons) + margen];
}

if (!CLAVE) {
  console.log('Sin FALLAS_CLAVE: no se arman los sectores de las fallas.');
} else {
  const autorizacion = { Authorization: `Bearer ${CLAVE}` };
  const res = await fetch(`${SITIO}/api/fallas?sin-sector`, { headers: autorizacion });
  if (!res.ok) throw new Error(`/api/fallas?sin-sector respondió ${res.status}`);
  const pendientes = (await res.json()) as { id: number; texto: string; lugares: string[] }[];
  console.log(`${pendientes.length} fallas esperan su sector.`);

  const leer = async (archivo: string) => ((JSON.parse(await readFile(archivo, 'utf8').catch(() => '{"features":[]}')) as { features: Lugar[] }).features);
  const capital = await leer('data/barrios.geojson');
  const delInterior = [...await leer('data/barrios-interior.geojson'), ...(await leer('data/zonas.geojson')).filter((z) => z.properties.tipo === 'localidad')];

  const sectores: { id: number; sector: [number, number][] }[] = [];
  for (const falla of pendientes) {
    const enCapital = capital.filter((f) => f.properties.nombre && falla.lugares.includes(f.properties.nombre));
    const enElInterior = delInterior.filter((f) => f.properties.nombre && falla.lugares.includes(f.properties.nombre));
    const zona = [...enCapital, ...enElInterior];
    if (zona.length === 0) continue;
    try {
      // Como en el lector: en capital las calles suelen ser el borde del barrio (se busca un poco más allá);
      // en el interior se exige que caigan dentro de los barrios o la localidad de la falla.
      const soloInterior = enCapital.length === 0;
      const sector = await sectorDelCorte(falla.texto, cajaDe(zona, soloInterior ? 0 : 0.004),
        soloInterior ? (p) => barrioEnPunto(zona as never, p) !== null : undefined);
      console.log(`Falla ${falla.id}: ${sector ? 'sector armado' : 'no se pudo armar (sigue pintando los barrios)'}`);
      if (sector) sectores.push({ id: falla.id, sector });
    } catch (error) {
      console.warn(`Falla ${falla.id}: sin conexión con OpenStreetMap (${(error as Error).message}); se reintenta la próxima vez.`);
    }
    await new Promise((listo) => setTimeout(listo, 2000)); // sin apurar a Overpass
  }

  if (sectores.length > 0) {
    const envio = await fetch(`${SITIO}/api/fallas`, {
      method: 'POST',
      headers: { ...autorizacion, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'sectores', sectores }),
    });
    if (!envio.ok) throw new Error(`Guardar los sectores respondió ${envio.status}: ${await envio.text()}`);
    console.log('Guardados:', await envio.text());
  }
}
