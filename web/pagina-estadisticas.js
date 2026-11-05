// @ts-check
// La página de estadísticas: dibuja los números de estadisticas.js como tarjetas y gráficos de barras.
// Las barras son HTML común (sin librerías de gráficos): cada fila tiene su nombre y su valor escritos,
// así se leen sin leyenda, con lector de pantalla y en cualquier tamaño de pantalla.

import { h } from './dom.js';
import { fechaLarga } from './estado.js';
import { estadisticas, estadisticasFallas } from './estadisticas.js';
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

/**
 * Las barras de "barrios con más cortes" (o fallas), con link a cada uno en el mapa.
 * @param {{ nombre: string, cortes: number, minutos: number }[]} lugares @param {[string, string]} [unidad]
 */
const barrasDeLugares = (lugares, [singular, plural] = ['corte', 'cortes']) => lugares.map((l) => ({
  nombre: l.nombre,
  valor: l.cortes,
  texto: cantidad(l.cortes, singular, plural),
  detalle: `${l.nombre}: ${cantidad(l.cortes, singular, plural)}, ${duracion(l.minutos)} en total`,
  enlace: `./?barrio=${encodeURIComponent(l.nombre)}`,
}));

/** @param {{ nombre: string, cortes: number }[]} franjas */
const barrasDeFranjas = (franjas) => franjas.map((f) => ({
  nombre: f.nombre, valor: f.cortes, texto: String(f.cortes), detalle: `${f.nombre}: ${cantidad(f.cortes, 'corte', 'cortes')}`,
}));

/** @param {string} nombreIcono @param {string} titulo @param {string} bajada */
const encabezado = (nombreIcono, titulo, bajada) => h('header', { class: 'seccion-estadisticas' },
  h('h2', {}, icono(/** @type {Parameters<typeof icono>[0]} */ (nombreIcono)), titulo), h('p', {}, bajada));

/** Los cortes repentinos: las fallas que EPEC confirmó en sus redes. @param {ReturnType<typeof estadisticasFallas>} f */
function seccionFallas(f) {
  if (f.cortes === 0) {
    return [h('div', { class: 'aviso' }, icono('info'), h('p', {}, 'Todavía no hay fallas registradas. Aparecen acá cuando EPEC confirma un corte no programado en sus redes.'))];
  }
  return [
    h('div', { class: 'datos' },
      dato(f.cortes, 'fallas confirmadas'),
      dato(f.horas, 'horas sin luz en total'),
      dato(f.lugaresAfectados, 'barrios y localidades afectados'),
      dato(duracionCorta(f.duracionMediana), 'dura una falla típica'),
    ),
    grafico('Barrios y localidades con más fallas', 'pin', barrasDeLugares(f.masAfectados, ['falla', 'fallas'])),
    grafico('¿A qué hora pasan?', 'reloj', barrasDeFranjas(f.porFranja)),
  ];
}

try {
  const [respuesta, respuestaFallas] = await Promise.all([fetch('data/mantenimientos.json'), fetch('api/fallas?historial').catch(() => null)]);
  if (!respuesta.ok) throw new Error(`data/mantenimientos.json respondió ${respuesta.status}`);
  const e = estadisticas(/** @type {Corte[]} */ (await respuesta.json()));
  // Si la base de fallas no responde, la página igual muestra los trabajos programados.
  const fallas = respuestaFallas?.ok ? estadisticasFallas(await respuestaFallas.json()) : null;
  if (e.desde) /** @type {HTMLElement} */ (document.getElementById('periodo')).textContent = `Desde el ${fechaLarga(e.desde)}`;

  contenedor.replaceChildren(
    encabezado('calendario', 'Trabajos programados', 'Los cortes que EPEC anuncia con anticipación por mantenimiento y obras.'),
    h('div', { class: 'datos' },
      dato(e.cortes, 'cortes anunciados'),
      dato(e.horas, 'horas de corte en total'),
      dato(e.lugaresAfectados, 'barrios y localidades afectados'),
      dato(duracionCorta(e.duracionMediana), 'dura un corte típico'),
    ),
    e.dias < 14 ? h('div', { class: 'aviso' }, icono('info'),
      h('p', {}, `Recién empezamos a juntar datos (${cantidad(e.dias, 'día', 'días')}): los números van a ser más representativos con el tiempo.`)) : '',
    grafico('Barrios y localidades con más cortes', 'pin', barrasDeLugares(e.masAfectados)),
    grafico('Cortes por día de la semana', 'calendario', e.porDia.map((d) => ({
      nombre: d.nombre, valor: d.cortes, texto: String(d.cortes), detalle: `${d.nombre}: ${cantidad(d.cortes, 'corte', 'cortes')}`,
    }))),
    grafico('¿A qué hora empiezan?', 'reloj', barrasDeFranjas(e.porFranja)),
    h('p', { class: 'nota' },
      `De todos los cortes, ${cantidad(e.totales, 'fue', 'fueron')} en forma total y ${e.granCordoba} en el interior de la provincia. `,
      'Cada horario anunciado cuenta como un corte.'),
    encabezado('alerta', 'Cortes repentinos', 'Las fallas no programadas que EPEC confirma en sus redes (los últimos 90 días).'),
    ...(fallas ? seccionFallas(fallas) : [h('p', { class: 'nota' }, 'No se pudieron cargar las fallas. Probá recargar la página.')]),
    h('p', { class: 'nota' }, 'Sitio no oficial, sin relación con EPEC.'),
  );
} catch (error) {
  contenedor.replaceChildren(h('p', { class: 'error' }, 'No se pudieron cargar los datos. Probá recargar la página.'));
  throw error;
}
