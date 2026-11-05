import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { armarConPiezas } from './revisar-contornos.ts';

// Una cuadra de ~100 m de lado (en Córdoba, 0,001° ≈ 95 m de longitud y 111 m de latitud).
const manzana = (lon: number, lat: number) => turf.polygon([[[lon, lat], [lon + 0.0009, lat], [lon + 0.0009, lat + 0.0008], [lon, lat + 0.0008], [lon, lat]]]);

test('armarConPiezas junta las manzanas que caen en la referencia, con la calle del medio adentro', () => {
  const referencia = turf.polygon([[[-64.2724, -31.3784], [-64.2700, -31.3784], [-64.2700, -31.3772], [-64.2724, -31.3772], [-64.2724, -31.3784]]]);
  const piezas = [manzana(-64.2722, -31.3782), manzana(-64.27115, -31.3782), manzana(-64.2650, -31.3782)]; // la última queda afuera
  const area = armarConPiezas(referencia, piezas);
  assert.ok(area);
  assert.equal(area.geometry.type, 'Polygon'); // las dos manzanas, unidas por la calle
  assert.ok(!turf.booleanPointInPolygon([-64.2646, -31.3778], area)); // la de afuera no entra
});

test('armarConPiezas no inventa: si las piezas no cubren ni la mitad de la referencia, devuelve null', () => {
  const grande = turf.polygon([[[-64.30, -31.40], [-64.26, -31.40], [-64.26, -31.36], [-64.30, -31.36], [-64.30, -31.40]]]);
  assert.equal(armarConPiezas(grande, [manzana(-64.28, -31.38)]), null);
  assert.equal(armarConPiezas(grande, []), null);
});
