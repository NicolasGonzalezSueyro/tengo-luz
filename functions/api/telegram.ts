import lugares from '../../data/lugares.js';
import { responder } from '../../src/bot.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';

// Telegram llama a esta dirección (/api/telegram) cada vez que alguien le escribe al bot ("webhook").
// La respuesta va en la misma contestación, así que para responder no hace falta el token del bot.
// SECRETO_BOT: Telegram lo manda en un encabezado; así sabemos que el pedido viene de Telegram y no de cualquiera.
// TELEGRAM_ADMIN: tu número de chat. Solo ese chat puede usar los comandos de admin.

type Contexto = { request: Request; env: { DB: BaseDeDatos; SECRETO_BOT?: string; TELEGRAM_ADMIN?: string } };
type Mensaje = { message?: { chat?: { id?: unknown }; text?: unknown } };

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.SECRETO_BOT || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SECRETO_BOT) {
    return new Response('No autorizado', { status: 401 });
  }
  const { message } = ((await request.json().catch(() => null)) ?? {}) as Mensaje;
  const chat = message?.chat?.id;
  // Fotos, stickers, mensajes editados, etc.: no hay nada que contestar.
  if (typeof chat !== 'number' || typeof message?.text !== 'string') return new Response(null, { status: 200 });

  const texto = await responder(env.DB, chat, message.text, { lugares, esAdmin: String(chat) === env.TELEGRAM_ADMIN });
  return Response.json({ method: 'sendMessage', chat_id: chat, text: texto, link_preview_options: { is_disabled: true } });
}
