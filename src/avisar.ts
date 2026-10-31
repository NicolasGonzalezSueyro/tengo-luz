import { readFileSync } from 'node:fs';
import { momentoEnCordoba, type Corte } from '../web/estado.js';
import { SITIO } from './bot.ts';

// Lo corre GitHub Actions después del lector (`npm run avisar`): le pasa a /api/avisar los cortes de hoy en
// adelante para que el bot avise a quienes siguen esos barrios. Se puede llamar varias veces: nunca repite un aviso.
// Necesita SECRETO_BOT, el mismo texto secreto que está en Cloudflare.

const secreto = process.env.SECRETO_BOT;
if (!secreto) {
  console.log('Sin SECRETO_BOT: no se mandan avisos por Telegram.');
  process.exit(0);
}

const hoy = momentoEnCordoba().fecha;
const cortes = (JSON.parse(readFileSync(new URL('../data/mantenimientos.json', import.meta.url), 'utf8')) as Corte[])
  .filter((c) => c.fecha >= hoy);
const respuesta = await fetch(`${process.env.SITIO ?? SITIO}/api/avisar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secreto}` },
  body: JSON.stringify(cortes),
});
if (!respuesta.ok) throw new Error(`/api/avisar respondió ${respuesta.status}: ${await respuesta.text()}`);
const { enviados, pendientes } = await respuesta.json();
console.log(`📨 ${enviados} avisos enviados por Telegram${pendientes > 0 ? `, ${pendientes} quedan para la próxima hora` : ''}.`);
