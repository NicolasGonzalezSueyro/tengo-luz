// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkWhatsApp, textoDelReclamo } from './reclamo.js';

const datos = {
  problema: 'sin-luz', desde: 'Hace entre 1 y 3 horas', vecinos: true, contrato: ' 1234567 ', direccion: 'Duarte Quirós 1500',
  barrio: 'Alberdi', nombre: 'Ana', telefono: '351 555 1234', comentario: '',
};

test('textoDelReclamo arma el mensaje con todos los datos', () => {
  assert.equal(textoDelReclamo(datos), [
    'Hola, quiero hacer un reclamo técnico.',
    'Problema: No tengo luz en toda la casa (hace entre 1 y 3 horas).',
    'Mis vecinos tampoco tienen luz.',
    'N° de contrato: 1234567',
    'Dirección: Duarte Quirós 1500, barrio Alberdi, Córdoba capital',
    'Nombre: Ana',
    'Teléfono de contacto: 351 555 1234',
  ].join('\n'));
});

test('textoDelReclamo saltea lo que no se completó', () => {
  const texto = textoDelReclamo({ ...datos, desde: '', vecinos: false, nombre: ' ', telefono: '', comentario: 'Se escuchó una explosión' });
  assert.match(texto, /Problema: No tengo luz en toda la casa\.\n/);
  assert.doesNotMatch(texto, /vecinos|Nombre|Teléfono/);
  assert.match(texto, /Comentario: Se escuchó una explosión$/);
});

test('linkWhatsApp codifica el texto para el link', () => {
  assert.equal(linkWhatsApp('5493512004343', 'Hola, ¿todo bien?\nSí'), 'https://wa.me/5493512004343?text=Hola%2C%20%C2%BFtodo%20bien%3F%0AS%C3%AD');
});
