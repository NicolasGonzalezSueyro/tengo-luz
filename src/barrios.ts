// Convierte la "zona" de un corte (texto libre) en barrios del mapa.
//
// Ejemplo: "Barrios Los Paraísos, San Martín Anexo y Alta Córdoba, en forma parcial."
//   → barrios: ["Los Paraísos", "Alta Córdoba"], sinUbicar: ["san martin anexo"]
//
// 1. Se saca "en forma parcial/total" y se corta la parte descriptiva ("comprendido por calle...", "entre...").
// 2. Lo que queda se separa por comas y por " y ".
// 3. Cada pedazo se normaliza (sin tildes, minúsculas, "Sud" = "Sur", sin "Barrio"/"Loteo") y se busca
//    en los nombres del mapa o en la tabla de alias. Lo que no se encuentra queda en sinUbicar.
// 4. Aparte, si el texto menciona una ruta conocida ("zona rural sobre Ruta Nacional 9 hacia el norte"),
//    se asocia a una zona aproximada de data/zonas.geojson.

export type Ubicacion = {
  barrios: string[]; // nombres tal cual figuran en data/barrios.geojson
  zonas: string[]; // zonas aproximadas de data/zonas.geojson
  sinUbicar: string[]; // pedazos de texto que no pudimos asociar a un barrio ni a una zona (normalizados)
  // Localidades del interior donde se cortan solo algunos barrios o un sector: se dibuja su contorno, sin pintarla.
  parciales?: string[];
};

/** Una zona aproximada: su nombre y la expresión regular que reconoce el texto del anuncio. */
// "ruta": corredor sobre una ruta de capital. "localidad": el límite de una localidad (src/localidades.ts).
export type ZonaAproximada = { nombre: string; patron: string; tipo?: 'ruta' | 'localidad' };

// Palabras que marcan que empieza una descripción por calles o sectores, no un nombre de barrio.
const DESCRIPCION = /\b(comprendid[oa]s?|entre|sobre|desde|hasta|calles?|area|sector|zona|frente|altura)\b/;

/** Si un texto sin ubicar es una descripción de calles ("entre calles X y Y") y no el nombre de un barrio. */
export const esDescripcion = (texto: string) => DESCRIPCION.test(texto);

export type Punto = [number, number]; // [longitud, latitud], como en GeoJSON

/** Centro aproximado de un barrio o zona: el punto mismo, o el promedio de los vértices del contorno. */
export function centro(geometria: { type: string; coordinates: unknown }): Punto {
  if (geometria.type === 'Point') return geometria.coordinates as Punto;
  const vertices = (geometria.coordinates as unknown[]).flat(geometria.type === 'MultiPolygon' ? 2 : 1) as Punto[];
  const [lon, lat] = vertices.reduce(([x, y], [a, b]) => [x + a, y + b], [0, 0]);
  return [lon / vertices.length, lat / vertices.length];
}

/** Distancia en km entre dos puntos sobre la Tierra (fórmula de haversine). */
export function distanciaKm([lon1, lat1]: Punto, [lon2, lat2]: Punto): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * EPEC anuncia los cortes por línea eléctrica, así que los barrios de un mismo corte quedan cerca entre sí.
 * Si dos están a más de `maximoKm`, seguramente un nombre repetido ("Los Manantiales") se ubicó en el lugar equivocado.
 * Devuelve el par más alejado, o null si está todo bien.
 */
export function lugaresSeparados(lugares: string[], centros: Map<string, Punto>, maximoKm = 8) {
  let peor: { a: string; b: string; km: number } | null = null;
  for (const [i, a] of lugares.entries()) {
    for (const b of lugares.slice(i + 1)) {
      const [pa, pb] = [centros.get(a), centros.get(b)];
      if (!pa || !pb) continue;
      const km = distanciaKm(pa, pb);
      if (km > maximoKm && km > (peor?.km ?? 0)) peor = { a, b, km };
    }
  }
  return peor;
}

/** Pedazos hechos solo de conectores ("en el", que queda de "en el perímetro comprendido por…"): no son barrios. */
export const SOLO_CONECTORES = /^((en|el|la|las|los|lo|de|del|y|e|a|al|con|por|para|sobre)\s*)+$/i;
const SOLO_NUMERO = /^(\d+|[ivx]+)( ?(ra|da|ta|ma|a|o|°|º|ª))?( secci[oó]n)?$/i;
const NUMERO_AL_FINAL = /\s+(\d+|[ivx]+)( ?(ra|da|ta|ma|a|o|°|º|ª))?( secci[oó]n)?$/i;
/**
 * "Loteo Terranostra I y II", "Parque Liceo 1ª, 2ª y 3ª sección": un número suelto es el mismo nombre que el pedazo
 * anterior con otro número ("Loteo Terranostra II"). Sin esto, "II" quedaba como un barrio desconocido.
 */
export function completarNumeros(pedazos: string[]): string[] {
  let anterior = '';
  return pedazos.map((pedazo) => {
    const texto = pedazo.trim();
    if (anterior && SOLO_NUMERO.test(texto)) return `${anterior.replace(NUMERO_AL_FINAL, '')} ${texto}`;
    if (texto) anterior = texto;
    return pedazo;
  });
}

/** Minúsculas, sin tildes ni símbolos y con espacios simples. */
function limpiar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tildes
    .toLowerCase()
    .replace(/[°º.ª]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * La forma con la que comparamos nombres. Unifica las distintas maneras de escribir el mismo barrio
 * que vimos en las notas, en OpenStreetMap y en la Municipalidad:
 * "San Lorenzo Sud" = "SAN LORENZO (S)", "Maipú 2ª Sección" = "MAIPU 2A SECCION",
 * "Altos de San Martín" = "ALTOS SAN MARTIN", "Doctor Remo Copello" = "DR REMO COPELLO".
 */
export function normalizar(nombre: string): string {
  return limpiar(nombre.replace(/\(s\)/gi, ' sur ').replace(/\(n\)/gi, ' norte '))
    .replace(/\b(\d+)a\b/g, '$1') // "2a seccion" → "2 seccion"
    .replace(/\bsud\b/g, 'sur')
    .replace(/\banexa\b/g, 'anexo')
    .replace(/\bdr\b/g, 'doctor')
    .replace(/\bgral\b/g, 'general')
    .replace(/\b(de|del)\b/g, '') // "Altos de San Martín" = "Altos San Martín"
    .replace(/\s+/g, ' ')
    .trim()
    // Sin "Barrio", "B°" o "Loteo" adelante. Puede haber varios ("Barrios Loteo Mutual Docente") o quedar solo.
    .replace(/^((barrios?|b|bo|loteo)( |$))+/, '');
}

/**
 * Prepara el buscador una sola vez: nombres del mapa y alias, indexados por su forma normalizada.
 * Un alias en null marca un nombre ambiguo: no se ubica solo aunque coincida con algo del mapa.
 */
/**
 * Un barrio de capital que se llama igual que una localidad ("San Francisco", "Deán Funes") pasa a ser
 * "San Francisco (Córdoba)", como los barrios del interior: si no, la página los confunde y al tocar el barrio va
 * al pueblo. El ubicador lo sigue encontrando como "San Francisco". Devuelve cuántos cambió.
 */
export function separarDeLocalidades(barrios: { properties: { nombre: string | null } }[], localidades: Set<string>): number {
  const repetidos = barrios.filter((f) => f.properties.nombre && localidades.has(f.properties.nombre));
  for (const f of repetidos) f.properties.nombre = `${f.properties.nombre} (Córdoba)`;
  return repetidos.length;
}

export function crearUbicador(nombres: string[], alias: Record<string, string | null>, zonasAproximadas: ZonaAproximada[] = []) {
  const zonasConPatron = zonasAproximadas.map((z) => ({ nombre: z.nombre, patron: new RegExp(z.patron) }));
  // "San Francisco (Córdoba)" es el barrio de capital que se llama igual que una localidad: EPEC escribe "San Francisco".
  const indice = new Map(nombres.map((n) => [normalizar(n.replace(/ \(Córdoba\)$/, '')), n]));
  for (const [otroNombre, nombreDelMapa] of Object.entries(alias)) {
    if (nombreDelMapa === null) {
      indice.delete(normalizar(otroNombre));
      continue;
    }
    if (!nombres.includes(nombreDelMapa)) throw new Error(`El alias "${otroNombre}" apunta a "${nombreDelMapa}", que no está en el mapa`);
    indice.set(normalizar(otroNombre), nombreDelMapa);
  }
  // Nombres que el separador partiría mal porque tienen " y " o palabras como "zona" ("Villa Cornú Zona Este").
  // Se buscan tal cual aparecen en el texto limpio (con "de"), por eso guardamos esa forma.
  const especiales = nombres
    .map((n) => [limpiar(n).replace(/^((barrios?|b|bo|loteo) )+/, ''), n] as const)
    .filter(([texto]) => texto.includes(' y ') || DESCRIPCION.test(texto));

  return function ubicar(zona: string): Ubicacion {
    const barrios = new Set<string>();
    const sinUbicar: string[] = [];

    // Limpiamos cada pedazo entre comas por separado para no perder las comas.
    let texto = ` ${zona.replace(/en forma (parcial|total)/gi, '').split(',').map(limpiar).join(' , ')} `;

    for (const [enElTexto, nombreDelMapa] of especiales) {
      if (texto.includes(` ${enElTexto} `)) {
        barrios.add(nombreDelMapa);
        texto = texto.replace(` ${enElTexto} `, ' , ');
      }
    }

    const corte = texto.search(DESCRIPCION);
    if (corte >= 0) {
      const descripcion = texto.slice(corte).replace(/[ ,]+/g, ' ').trim();
      if (descripcion) sinUbicar.push(descripcion);
      texto = texto.slice(0, corte);
    }

    for (const pedazo of completarNumeros(texto.split(/,| y | e (?=h?i)/))) {
      const nombre = normalizar(pedazo);
      if (!nombre || SOLO_CONECTORES.test(pedazo.trim())) continue;
      const delMapa = indice.get(nombre);
      if (delMapa) barrios.add(delMapa);
      else sinUbicar.push(nombre);
    }

    // Zonas aproximadas: se busca en todo el texto, y lo que reconocen deja de figurar como "sin ubicar".
    const zonas = zonasConPatron.filter((z) => z.patron.test(normalizar(zona)));
    return {
      barrios: [...barrios],
      zonas: zonas.map((z) => z.nombre),
      sinUbicar: sinUbicar.filter((texto) => !zonas.some((z) => z.patron.test(normalizar(texto)))),
    };
  };
}
