// @ts-check
// El panel de admin (/admin): los números del sitio y del bot, y borrar reportes de vecinos.
// Todo pasa por /api/admin con la clave ADMIN_CLAVE; sin ella, la API no muestra ni borra nada.

import { h } from './dom.js';
import { hace } from './estado.js';
import { completarIconos, icono } from './iconos.js';

/** @typedef {import('../src/admin.ts').Estadisticas} Estadisticas */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const formulario = /** @type {HTMLFormElement} */ ($('entrar'));
const campoClave = /** @type {HTMLInputElement} */ ($('clave'));
const panel = $('panel-admin');
const REPOSITORIO = 'https://github.com/NicolasGonzalezSueyro/tengo-luz';

// La clave se guarda en sessionStorage: se borra sola al cerrar la pestaña.
const GUARDADA = 'clave-admin';
let clave = '';
try {
  clave = sessionStorage.getItem(GUARDADA) ?? '';
} catch {
  // Sin almacenamiento: hay que poner la clave cada vez.
}

/** @param {string} valor */
function recordarClave(valor) {
  clave = valor;
  try {
    if (valor) sessionStorage.setItem(GUARDADA, valor);
    else sessionStorage.removeItem(GUARDADA);
  } catch {
    // No pasa nada: solo no se recuerda.
  }
}

/** @param {'GET' | 'POST'} metodo @param {object} [cuerpo] */
async function api(metodo, cuerpo) {
  const respuesta = await fetch('api/admin', {
    method: metodo,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${clave}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(datos.error ?? `El servidor respondió ${respuesta.status}`);
  return datos;
}

/** @param {string} [motivo] */
function salir(motivo = '') {
  recordarClave('');
  panel.hidden = true;
  formulario.hidden = false;
  $('salir').hidden = true;
  $('error').textContent = motivo;
  $('mensaje').textContent = '';
}

async function cargar() {
  try {
    mostrarPanel(/** @type {Estadisticas} */ (await api('GET')));
  } catch (error) {
    salir(/** @type {Error} */ (error).message);
  }
}

/** Manda una notificación de prueba a todos los celulares suscriptos. */
async function probarNotificaciones() {
  try {
    const { entregadas, total } = await api('POST', { accion: 'probar-notificaciones' });
    $('mensaje').textContent = total === 0
      ? 'Todavía no hay celulares suscriptos: tocá "Avisarme" en la ficha de un barrio desde tu celu.'
      : `🔔 Notificación de prueba: llegó a ${entregadas} de ${total}.`;
  } catch (error) {
    $('mensaje').textContent = `No se pudo mandar: ${/** @type {Error} */ (error).message}`;
  }
}

/** @param {string | undefined} [barrio] sin barrio: todos */
async function limpiar(barrio) {
  if (!confirm(barrio ? `¿Borrar los reportes de ${barrio}?` : '¿Borrar todos los reportes de vecinos?')) return;
  try {
    const { borrados } = await api('POST', { accion: 'limpiar', ...(barrio ? { barrio } : {}) });
    $('mensaje').textContent = `🧹 Borré ${borrados} ${borrados === 1 ? 'reporte' : 'reportes'}. El mapa se actualiza en menos de un minuto.`;
    await cargar();
  } catch (error) {
    $('mensaje').textContent = `No se pudo borrar: ${/** @type {Error} */ (error).message}`;
  }
}

/** @param {number} numero @param {string} texto */
const dato = (numero, texto) => h('div', { class: 'dato' }, h('strong', {}, String(numero)), h('span', {}, texto));

/** @param {number} n @param {string} singular @param {string} plural */
const cantidad = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

/** @param {Estadisticas} e */
function mostrarPanel(e) {
  const reportes = Object.entries(e.reportes).sort((a, b) => b[1].cantidad - a[1].cantidad);
  formulario.hidden = true;
  $('salir').hidden = false;
  $('error').textContent = '';
  panel.hidden = false;
  panel.replaceChildren(
    h('div', { class: 'datos' },
      dato(e.personas, 'personas con avisos'),
      dato(e.barriosSeguidos, 'barrios seguidos'),
      dato(e.notificaciones, 'celulares con notificaciones'),
      dato(e.avisos, 'avisos en 30 días'),
      dato(reportes.length, 'barrios con reportes'),
    ),
    h('section', { class: 'tarjeta-admin' },
      h('div', { class: 'titulo-seccion' },
        h('h2', {}, icono('alerta'), 'Reportes de vecinos'),
        reportes.length > 0 && h('button', { class: 'boton boton-peligro', type: 'button', onclick: () => limpiar() }, 'Borrar todos'),
      ),
      reportes.length === 0
        ? h('p', { class: 'nota' }, 'No hay reportes en las últimas 3 horas.')
        : h('ul', { class: 'lista-admin' }, ...reportes.map(([barrio, r]) => h('li', {},
          h('span', {}, h('strong', {}, barrio), ` · ${cantidad(r.cantidad, 'reporte', 'reportes')} · último ${hace(r.ultimo)}`),
          h('button', { class: 'boton boton-secundario', type: 'button', onclick: () => limpiar(barrio) }, 'Borrar'),
        ))),
    ),
    h('section', { class: 'tarjeta-admin' },
      h('div', { class: 'titulo-seccion' },
        h('h2', {}, icono('campana'), 'Notificaciones del navegador'),
        h('button', { class: 'boton boton-secundario', type: 'button', onclick: probarNotificaciones }, 'Mandar una de prueba'),
      ),
      h('p', { class: 'nota' }, cantidad(e.notificaciones, 'celular suscripto', 'celulares suscriptos'), '. La prueba les llega a todos: suscribite vos primero desde la ficha de un barrio.'),
    ),
    h('section', { class: 'tarjeta-admin' },
      h('h2', {}, icono('vecinos'), 'Barrios más seguidos en Telegram'),
      e.masSeguidos.length === 0
        ? h('p', { class: 'nota' }, 'Todavía nadie sigue barrios.')
        : h('ul', { class: 'lista-admin' }, ...e.masSeguidos.map((s) => h('li', {},
          h('strong', {}, s.barrio), h('span', {}, cantidad(s.personas, 'persona', 'personas')),
        ))),
    ),
    h('section', { class: 'tarjeta-admin' },
      h('h2', {}, icono('enlace'), 'Accesos rápidos'),
      h('ul', { class: 'accesos' },
        h('li', {}, h('a', { href: `${REPOSITORIO}/actions`, target: '_blank', rel: 'noopener' }, 'Robot que actualiza los cortes (GitHub Actions)')),
        h('li', {}, h('a', { href: 'data/mantenimientos.json', target: '_blank' }, 'Datos de cortes publicados')),
        h('li', {}, h('a', { href: 'https://dash.cloudflare.com', target: '_blank', rel: 'noopener' }, 'Cloudflare (hosting, base de datos y variables)')),
        h('li', {}, h('a', { href: './' }, 'Ir al mapa')),
      ),
    ),
    h('p', { class: 'nota' },
      `Actualizado a las ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} · `,
      h('button', { class: 'enlace-boton', type: 'button', onclick: cargar }, 'Actualizar ahora'),
    ),
  );
}

formulario.addEventListener('submit', (e) => {
  e.preventDefault();
  recordarClave(campoClave.value.trim());
  campoClave.value = '';
  cargar();
});
$('salir').addEventListener('click', () => salir());

completarIconos();
if (clave) cargar();
// Mientras el panel está abierto, los números se actualizan solos cada minuto.
setInterval(() => {
  if (!panel.hidden) cargar();
}, 60_000);
