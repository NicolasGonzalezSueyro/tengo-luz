import { SITIO } from './bot.ts';

// Le dice a Telegram dónde está el bot y qué comandos mostrar en el menú. Se corre una sola vez
// (y de nuevo solo si cambia la dirección del sitio) con `npm run bot`, que lee el token del archivo .env.
// El .env nunca se sube a GitHub (está en .gitignore).

const { TELEGRAM_TOKEN: token, SECRETO_BOT: secreto } = process.env;
if (!token || !secreto) throw new Error('Faltan TELEGRAM_TOKEN y SECRETO_BOT en el archivo .env');

async function telegram(metodo: string, datos: object) {
  const respuesta = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datos),
  });
  const { ok, description } = await respuesta.json();
  if (!ok) throw new Error(`${metodo}: ${description}`);
  console.log(`✅ ${metodo}`);
}

await telegram('setWebhook', {
  url: `${SITIO}/api/telegram`,
  secret_token: secreto,
  allowed_updates: ['message'],
  drop_pending_updates: true,
});
await telegram('setMyCommands', {
  commands: [
    { command: 'barrio', description: 'Recibir avisos de un barrio' },
    { command: 'mis_barrios', description: 'Ver tus barrios' },
    { command: 'borrar', description: 'Dejar de recibir avisos' },
    { command: 'ayuda', description: 'Cómo usar el bot' },
  ],
});
await telegram('setMyDescription', {
  description: 'Te aviso cuando EPEC anuncia un corte de luz programado en tus barrios de Córdoba capital. Sitio no oficial.',
});
console.log(`Listo: el bot responde desde ${SITIO}/api/telegram`);
