import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nombreWikimapia } from './comparar-wikimapia.ts';

test('nombreWikimapia saca los agregados de Wikimapia para comparar con nuestros nombres', () => {
  assert.equal(nombreWikimapia('Las Terrazas - Valle Escondido'), 'Las Terrazas');
  assert.equal(nombreWikimapia('El Remanso (Valle Escondido)'), 'El Remanso');
  assert.equal(nombreWikimapia('Barrio Los Aromas - Valle Escondido'), 'Los Aromas');
  assert.equal(nombreWikimapia('Country La Reserva'), 'La Reserva');
});
