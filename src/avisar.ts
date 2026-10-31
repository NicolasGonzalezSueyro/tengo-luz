import { readFileSync } from 'node:fs';
import { momentoEnCordoba, type Corte } from '../web/estado.js';
import { llamarApi } from './alertar.ts';

// Lo corre GitHub Actions después del lector (`npm run avisar`): le pasa a /api/avisar los cortes de hoy en
// adelante para que el bot avise a quienes siguen esos barrios. Se puede llamar varias veces: nunca repite un aviso.
// Necesita SECRETO_BOT, el mismo texto secreto que está en Cloudflare.

if (!process.env.SECRETO_BOT) {
  console.log('Sin SECRETO_BOT: no se mandan avisos por Telegram.');
  process.exit(0);
}

const hoy = momentoEnCordoba().fecha;
const cortes = (JSON.parse(readFileSync(new URL('../data/mantenimientos.json', import.meta.url), 'utf8')) as Corte[])
  .filter((c) => c.fecha >= hoy);
const { enviados, pendientes } = await llamarApi('/api/avisar', cortes);
console.log(`📨 ${enviados} avisos enviados por Telegram${pendientes > 0 ? `, ${pendientes} quedan para la próxima hora` : ''}.`);
