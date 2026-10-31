/** Manda un mensaje de texto con el bot. Devuelve la respuesta de Telegram (403 = la persona bloqueó al bot). */
export function enviarMensaje(token: string, chat: number, texto: string): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, link_preview_options: { is_disabled: true } }),
  });
}
