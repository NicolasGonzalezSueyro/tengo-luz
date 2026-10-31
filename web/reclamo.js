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

/** @param {DatosReclamo} d */
export function textoDelReclamo(d) {
  const desde = d.desde ? ` (${d.desde.toLowerCase()})` : '';
  return [
    'Hola, quiero hacer un reclamo técnico.',
    `Problema: ${PROBLEMAS[d.problema] ?? d.problema}${desde}.`,
    d.vecinos && 'Mis vecinos tampoco tienen luz.',
    `N° de contrato: ${d.contrato.trim()}`,
    `Dirección: ${d.direccion.trim()}, barrio ${d.barrio.trim()}, Córdoba capital`,
    d.nombre.trim() && `Nombre: ${d.nombre.trim()}`,
    d.telefono.trim() && `Teléfono de contacto: ${d.telefono.trim()}`,
    d.comentario.trim() && `Comentario: ${d.comentario.trim()}`,
  ].filter(Boolean).join('\n');
}

/** Link que abre WhatsApp con el mensaje ya escrito, listo para que la persona lo mande. @param {string} numero @param {string} texto */
export const linkWhatsApp = (numero, texto) => `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
