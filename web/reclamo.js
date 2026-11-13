// @ts-check
// El texto del reclamo a EPEC que arma el formulario de la página. Todo pasa en el navegador:
// los datos solo viajan dentro del link de WhatsApp, y el mensaje lo manda la misma persona.

/**
 * @typedef {{
 *   problema: string, desde: string, vecinos: boolean, contrato: string, direccion: string,
 *   barrio: string, nombre: string, telefono: string, comentario: string
 * }} DatosReclamo
 */

/** @type {Record<string, string>} */
export const PROBLEMAS = {
  'sin-luz': 'No tengo luz en toda la casa',
  parcial: 'Tengo luz solo en una parte de la casa',
  baja: 'Baja tensión: la luz anda débil o parpadea',
  peligro: 'Cables caídos, chispas o un poste dañado',
};

export const DESDE = ['Recién', 'Hace menos de 1 hora', 'Hace entre 1 y 3 horas', 'Hace más de 3 horas', 'Desde ayer o antes'];

/**
 * Dónde queda el lugar del reclamo: "barrio Alberdi, Córdoba capital", "barrio Centro, Villa María" (los barrios del
 * interior se llaman "Centro (Villa María)") o "La Calera" si lo elegido es la localidad entera.
 * @param {string} barrio @param {(nombre: string) => boolean} [esLocalidad]
 */
export function lugarDelReclamo(barrio, esLocalidad = () => false) {
  const nombre = barrio.trim();
  const delInterior = nombre.match(/^(.+) \((.+)\)$/);
  if (delInterior) return delInterior[2] === 'Córdoba' ? `barrio ${delInterior[1]}, Córdoba capital` : `barrio ${delInterior[1]}, ${delInterior[2]}`;
  return esLocalidad(nombre) ? nombre : `barrio ${nombre}, Córdoba capital`;
}

/** @param {DatosReclamo} d @param {(nombre: string) => boolean} [esLocalidad] */
export function textoDelReclamo(d, esLocalidad) {
  const desde = d.desde ? ` (${d.desde.toLowerCase()})` : '';
  return [
    'Hola, quiero hacer un reclamo técnico.',
    `Problema: ${PROBLEMAS[d.problema] ?? d.problema}${desde}.`,
    d.vecinos && 'Mis vecinos tampoco tienen luz.',
    `N° de contrato: ${d.contrato.trim()}`,
    `Dirección: ${d.direccion.trim()}, ${lugarDelReclamo(d.barrio, esLocalidad)}`,
    d.nombre.trim() && `Nombre: ${d.nombre.trim()}`,
    d.telefono.trim() && `Teléfono de contacto: ${d.telefono.trim()}`,
    d.comentario.trim() && `Comentario: ${d.comentario.trim()}`,
  ].filter(Boolean).join('\n');
}

/** Link que abre WhatsApp con el mensaje ya escrito, listo para que la persona lo mande. @param {string} numero @param {string} texto */
export const linkWhatsApp = (numero, texto) => `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
