import { marcarAvisado, yaAvisado } from '../../src/bot.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { claveCorrecta } from '../../src/seguridad.ts';
import { enviarMensaje } from '../../src/telegram.ts';
import { momentoEnCordoba } from '../../web/estado.js';

// El robot de GitHub llama a /api/alerta cuando algo anda mal (src/alertar.ts), y esta función te lo
// cuenta por Telegram a vos (TELEGRAM_ADMIN). Cada alerta llega como mucho una vez por día, así un
// problema que dura varias horas no te manda un mensaje por hora.
//   POST { "texto": "qué pasó", "detalle": "link o datos extra (opcional)" }

type Contexto = {
  request: Request;
  env: { DB: BaseDeDatos; SECRETO_BOT?: string; TELEGRAM_TOKEN?: string; TELEGRAM_ADMIN?: string };
};

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.SECRETO_BOT || !(await claveCorrecta(request, env.SECRETO_BOT))) {
    return new Response('No autorizado', { status: 401 });
  }
  // Quien llega acá ya probó tener el secreto, así que le contamos el motivo exacto de cualquier falla.
  const fallar = (motivo: string) => Response.json({ error: motivo }, { status: 500 });
  if (!env.TELEGRAM_TOKEN) return fallar('Falta la variable TELEGRAM_TOKEN en Cloudflare');
  if (!/^-?\d+$/.test(env.TELEGRAM_ADMIN?.trim() ?? '')) {
    return fallar('Falta TELEGRAM_ADMIN en Cloudflare, o no es un número (mandale /mi_id al bot para saber el tuyo)');
  }
  const datos = (await request.json().catch(() => null)) as { texto?: unknown; detalle?: unknown } | null;
  const texto = typeof datos?.texto === 'string' ? datos.texto.trim().slice(0, 1000) : '';
  if (!texto) return Response.json({ error: 'Falta el texto' }, { status: 400 });
  const detalle = typeof datos?.detalle === 'string' ? `\n\n${datos.detalle.slice(0, 1000)}` : '';

  try {
    // La clave no incluye el detalle (que suele ser un link distinto en cada corrida): así se repite una vez por día.
    const alerta = { chat: Number(env.TELEGRAM_ADMIN), clave: `alerta ${momentoEnCordoba().fecha} ${texto}` };
    if (await yaAvisado(env.DB, alerta)) return Response.json({ enviada: false });
    const respuesta = await enviarMensaje(env.TELEGRAM_TOKEN, alerta.chat, `🛠️ ${texto}${detalle}`);
    // Telegram explica el problema en "description" (ej.: "Bad Request: chat not found"). Nunca incluye el token.
    if (!respuesta.ok) return fallar(`Telegram respondió ${respuesta.status}: ${(await respuesta.text()).slice(0, 300)}`);
    await marcarAvisado(env.DB, alerta, Date.now());
    return Response.json({ enviada: true });
  } catch (error) {
    return fallar(`Error de la base de datos o de la red: ${(error as Error).message}`);
  }
}
