// @ts-check
// La página de estadísticas: dibuja los números de estadisticas.js como tarjetas y gráficos de barras.
// Las barras son HTML común (sin librerías de gráficos): cada fila tiene su nombre y su valor escritos,
// así se leen sin leyenda, con lector de pantalla y en cualquier tamaño de pantalla.

import { h } from './dom.js';
import { fechaLarga } from './estado.js';
import { estadisticas } from './estadisticas.js';
import { completarIconos, icono } from './iconos.js';

/** @typedef {import('./estado.js').Corte} Corte */

const contenedor = /** @type {HTMLElement} */ (document.getElementById('estadisticas'));
completarIconos();

/** "1 h 30 min", "45 min", "3 h". @param {number} total minutos */
function duracion(total) {
  const horas = Math.floor(total / 60);
  const minutos = Math.round(total % 60);
  return [horas && `${horas} h`, minutos && `${minutos} min`].filter(Boolean).join(' ') || '0 min';
}

/** Para las tarjetas grandes, que tienen poco ancho: "3:45 h", o "45 min" si es menos de una hora. @param {number} total */
function duracionCorta(total) {
  const horas = Math.floor(total / 60);
  const minutos = Math.round(total % 60);
  return horas ? `${horas}:${String(minutos).padStart(2, '0')} h` : `${minutos} min`;
}

/** @param {number | string} numero @param {string} texto */
const dato = (numero, texto) => h('div', { class: 'dato' }, h('strong', {}, String(numero)), h('span', {}, texto));

/**
 * Un gráfico de barras horizontales. Cada barra mide su valor contra el máximo; el número va escrito al lado.
 * @param {string} titulo @param {Parameters<typeof icono>[0]} nombreIcono
 * @param {{ nombre: string, valor: number, texto: string, detalle: string, enlace?: string }[]} filas
 */
function grafico(titulo, nombreIcono, filas) {
  const maximo = Math.max(1, ...filas.map((f) => f.valor));
  return h('section', { class: 'tarjeta-admin' },
    h('h2', {}, icono(nombreIcono), titulo),
    h('ul', { class: 'barras', 'aria-label': titulo },
      ...filas.map((f) => h('li', { class: 'barra-fila', title: f.detalle },
        f.enlace ? h('a', { class: 'barra-nombre', href: f.enlace }, f.nombre) : h('span', { class: 'barra-nombre' }, f.nombre),
        // Con valor 0 no hay barra (ni siquiera una rayita): la pista queda vacía.
        h('span', { class: 'barra-pista', 'aria-hidden': 'true' },
          f.valor > 0 && h('span', { class: 'barra-relleno', style: `width:${(f.valor / maximo) * 100}%` })),
        h('span', { class: 'barra-valor' }, f.texto),
      )),
    ),
  );
}

/** @param {number} n @param {string} singular @param {string} plural */
const cantidad = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

try {
  const respuesta = await fetch('data/mantenimientos.json');
  if (!respuesta.ok) throw new Error(`data/mantenimientos.json respondió ${respuesta.status}`);
  const e = estadisticas(/** @type {Corte[]} */ (await respuesta.json()));
  if (e.desde) /** @type {HTMLElement} */ (document.getElementById('periodo')).textContent = `Desde el ${fechaLarga(e.desde)}`;

  contenedor.replaceChildren(
    h('div', { class: 'datos' },
      dato(e.cortes, 'cortes anunciados'),
      dato(e.horas, 'horas de corte en total'),
      dato(e.lugaresAfectados, 'barrios y localidades afectados'),
      dato(duracionCorta(e.duracionMediana), 'dura un corte típico'),
    ),
    e.dias < 14 ? h('div', { class: 'aviso' }, icono('info'),
      h('p', {}, `Recién empezamos a juntar datos (${cantidad(e.dias, 'día', 'días')}): los números van a ser más representativos con el tiempo.`)) : '',
    grafico('Barrios y localidades con más cortes', 'pin', e.masAfectados.map((l) => ({
      nombre: l.nombre,
      valor: l.cortes,
      texto: cantidad(l.cortes, 'corte', 'cortes'),
      detalle: `${l.nombre}: ${cantidad(l.cortes, 'corte', 'cortes')}, ${duracion(l.minutos)} en total`,
      enlace: `./?barrio=${encodeURIComponent(l.nombre)}`,
    }))),
    grafico('Cortes por día de la semana', 'calendario', e.porDia.map((d) => ({
      nombre: d.nombre, valor: d.cortes, texto: String(d.cortes), detalle: `${d.nombre}: ${cantidad(d.cortes, 'corte', 'cortes')}`,
    }))),
    grafico('¿A qué hora empiezan?', 'reloj', e.porFranja.map((f) => ({
      nombre: f.nombre, valor: f.cortes, texto: String(f.cortes), detalle: `${f.nombre}: ${cantidad(f.cortes, 'corte', 'cortes')}`,
    }))),
    h('p', { class: 'nota' },
      `De todos los cortes, ${cantidad(e.totales, 'fue', 'fueron')} en forma total y ${e.granCordoba} en el interior de la provincia. `,
      'Cada horario anunciado cuenta como un corte. Son los cortes programados que anunció EPEC (no incluye fallas). Sitio no oficial.'),
  );
} catch (error) {
  contenedor.replaceChildren(h('p', { class: 'error' }, 'No se pudieron cargar los datos. Probá recargar la página.'));
  throw error;
}
