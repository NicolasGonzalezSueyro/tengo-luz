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
};

/** Una zona aproximada: su nombre y la expresión regular que reconoce el texto del anuncio. */
export type ZonaAproximada = { nombre: string; patron: string };

// Palabras que marcan que empieza una descripción por calles o sectores, no un nombre de barrio.
const DESCRIPCION = /\b(comprendid[oa]s?|entre|sobre|desde|hasta|calles?|area|sector|zona|frente|altura)\b/;

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
export function crearUbicador(nombres: string[], alias: Record<string, string | null>, zonasAproximadas: ZonaAproximada[] = []) {
  const zonasConPatron = zonasAproximadas.map((z) => ({ nombre: z.nombre, patron: new RegExp(z.patron) }));
  const indice = new Map(nombres.map((n) => [normalizar(n), n]));
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

    for (const pedazo of texto.split(/,| y /)) {
      const nombre = normalizar(pedazo);
      if (!nombre) continue;
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
