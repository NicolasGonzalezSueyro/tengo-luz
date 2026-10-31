// @ts-check

/** @typedef {Node | string | null | false | undefined} Hijo */

/**
 * Crea un elemento del DOM. Todo el texto entra como texto (nunca como HTML), así nada que venga
 * de las notas o de los reportes puede inyectar código en la página.
 * @param {string} etiqueta
 * @param {Record<string, string | ((e: Event) => void)>} [atributos]
 * @param {...Hijo} hijos
 */
export function h(etiqueta, atributos = {}, ...hijos) {
  const el = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) {
    if (typeof valor === 'function') el.addEventListener(clave.replace(/^on/, ''), valor);
    else el.setAttribute(clave, valor);
  }
  for (const hijo of hijos) if (hijo) el.append(hijo);
  return el;
}
