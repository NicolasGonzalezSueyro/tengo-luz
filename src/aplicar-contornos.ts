import { readFile, writeFile } from 'node:fs/promises';
import { SITIO } from './bot.ts';
import { aplicarContornos, aplicarPedido, ARCHIVO_MANUALES, ARCHIVOS, leerManuales, type ContornoManual, type Destino } from './contornos.ts';
import type { PedidoGuardado } from './contornos-admin.ts';
import { escribirLugares } from './lugares.ts';

// Lo corre el robot de GitHub (contornos.yml) cuando el admin cambia un contorno en /admin-contornos:
//   node src/aplicar-contornos.ts            → trae los cambios pendientes, los aplica a los mapas y anota sus números
//   node src/aplicar-contornos.ts confirmar  → después de publicar, le avisa al sitio que ya están (salen de la lista)
// Necesita SECRETO_BOT (el mismo de Cloudflare). Sin cambios pendientes, no toca nada.

const APLICADOS = '.contornos-aplicados.json'; // entre los dos pasos (no se sube: está en .gitignore)
const autorizacion = { Authorization: `Bearer ${process.env.SECRETO_BOT}` };
const sitio = process.env.SITIO ?? SITIO;

type Coleccion = { features: { properties: Record<string, unknown> & { nombre?: string | null }; geometry: unknown }[] };

/** Aplica los pedidos a los mapas (en memoria) y devuelve qué hizo con cada uno. Exportado para los tests. */
export function aplicarTodos(pedidos: PedidoGuardado[], manualesAntes: ContornoManual[], mapas: Record<Destino, Coleccion>) {
  let manuales = manualesAntes;
  const mensajes: string[] = [];
  for (const p of pedidos) {
    const resultado = aplicarPedido(manuales, mapas[p.destino], p);
    manuales = resultado.manuales;
    mensajes.push(resultado.mensaje);
  }
  // Las correcciones (las de antes y las nuevas) se vuelven a aplicar sobre los mapas, como en cualquier regeneración.
  for (const destino of Object.keys(mapas) as Destino[]) aplicarContornos(mapas[destino], destino, [...leerManuales('data/contornos-revisados.geojson'), ...manuales]);
  return { manuales, mensajes };
}

if (import.meta.main) {
  if (!process.env.SECRETO_BOT) throw new Error('Falta SECRETO_BOT');
  if (process.argv[2] === 'confirmar') {
    const ids = JSON.parse(await readFile(APLICADOS, 'utf8').catch(() => '[]')) as number[];
    if (ids.length > 0) {
      const res = await fetch(`${sitio}/api/contornos`, { method: 'POST', headers: { ...autorizacion, 'Content-Type': 'application/json' }, body: JSON.stringify({ aplicados: ids }) });
      if (!res.ok) throw new Error(`/api/contornos respondió ${res.status}`);
      console.log(`✅ ${(await res.json()).sacados} cambios marcados como publicados.`);
    }
  } else {
    const res = await fetch(`${sitio}/api/contornos`, { headers: autorizacion, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`/api/contornos respondió ${res.status}`);
    const pedidos = (await res.json()) as PedidoGuardado[];
    if (pedidos.length === 0) {
      console.log('No hay cambios de contornos pendientes.');
    } else {
      const leer = async (d: Destino) => JSON.parse(await readFile(ARCHIVOS[d], 'utf8')) as Coleccion;
      const mapas = { barrios: await leer('barrios'), zonas: await leer('zonas'), interior: await leer('interior') };
      const { manuales, mensajes } = aplicarTodos(pedidos, leerManuales(), mapas);
      await writeFile(ARCHIVO_MANUALES, JSON.stringify({ type: 'FeatureCollection', features: manuales }) + '\n');
      // Mismo formato que escriben los demás scripts (zonas, con sangría; los otros, en una línea).
      await writeFile(ARCHIVOS.barrios, JSON.stringify(mapas.barrios) + '\n');
      await writeFile(ARCHIVOS.zonas, JSON.stringify(mapas.zonas, null, 1) + '\n');
      await writeFile(ARCHIVOS.interior, JSON.stringify(mapas.interior) + '\n');
      escribirLugares(); // el bot y los reportes reconocen los lugares nuevos (y ya no los borrados)
      await writeFile(APLICADOS, JSON.stringify(pedidos.map((p) => p.id)));
      console.log(`✏️  ${pedidos.length} cambios de contornos:\n   ${mensajes.join('\n   ')}`);
    }
  }
}
