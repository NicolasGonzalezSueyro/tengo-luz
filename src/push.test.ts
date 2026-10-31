import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aBase64url, cifrar, clavePublicaDe, deBase64url, firmaVapid, generarClave, suscripcionValida } from './push.ts';

test('cifrar da exactamente el resultado del ejemplo oficial del RFC 8291 (apéndice A)', async () => {
  // Claves y sal del ejemplo del estándar: si el resultado coincide byte por byte, el cifrado es correcto.
  const servidorPublica = deBase64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const efimera = {
    publicKey: await crypto.subtle.importKey('raw', servidorPublica, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    privateKey: await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256',
      x: aBase64url(servidorPublica.slice(1, 33)), y: aBase64url(servidorPublica.slice(33)),
      d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
  };
  const suscripcion = {
    endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
    keys: {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
  };
  const cuerpo = await cifrar('When I grow up, I want to be a watermelon', suscripcion, { sal: deBase64url('DGv6ra1nlYgDCS1FRnbzlw'), efimera });
  assert.equal(
    aBase64url(cuerpo),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('firmaVapid arma un JWT ES256 que se verifica con nuestra clave pública', async () => {
  const clave = await generarClave();
  const encabezado = await firmaVapid('https://fcm.googleapis.com/fcm/send/abc', clave, 'https://tengo-luz.pages.dev', Date.UTC(2026, 9, 31));
  const [, jwt, k] = encabezado.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
  assert.equal(k, clavePublicaDe(clave));
  const [cabecera, datos, firma] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(deBase64url(datos))), {
    aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 9, 31) / 1000 + 12 * 3600, sub: 'https://tengo-luz.pages.dev',
  });
  const publica = await crypto.subtle.importKey('raw', deBase64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valida = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publica, deBase64url(firma), new TextEncoder().encode(`${cabecera}.${datos}`));
  assert.equal(valida, true);
});

test('suscripcionValida acepta solo servicios de push conocidos y claves del tamaño correcto', () => {
  const keys = { p256dh: aBase64url(new Uint8Array(65)), auth: aBase64url(new Uint8Array(16)) };
  assert.equal(suscripcionValida({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }), true);
  assert.equal(suscripcionValida({ endpoint: 'https://web.push.apple.com/abc', keys }), true);
  assert.equal(suscripcionValida({ endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=abc', keys }), true);
  assert.equal(suscripcionValida({ endpoint: 'https://mi-servidor.com/robar', keys }), false); // no es un servicio de push
  assert.equal(suscripcionValida({ endpoint: 'http://fcm.googleapis.com/x', keys }), false);
  assert.equal(suscripcionValida({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'corta' } }), false);
  assert.equal(suscripcionValida(null), false);
});
