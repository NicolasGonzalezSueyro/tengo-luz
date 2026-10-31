import { SITIO } from './bot.ts';

// Para que el robot de GitHub te avise por Telegram cuando algo anda mal (llama a /api/alerta).
// Necesita SECRETO_BOT; sin él (por ejemplo, en tu compu) solo muestra las alertas en pantalla.
// También se puede usar a mano: node src/alertar.ts "texto" "detalle opcional"

/** Llama a una función de /api del sitio con el secreto del bot. */
export async function llamarApi(ruta: string, cuerpo: unknown): Promise<any> {
  const respuesta = await fetch(`${process.env.SITIO ?? SITIO}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SECRETO_BOT}` },
    body: JSON.stringify(cuerpo),
  });
  if (!respuesta.ok) throw new Error(`${ruta} respondió ${respuesta.status}: ${await respuesta.text()}`);
  return respuesta.json();
}

export async function alertar(texto: string, detalle?: string) {
  console.warn(`🛠️  ${texto}${detalle ? `\n   ${detalle}` : ''}`);
  if (!process.env.SECRETO_BOT) return;
  // Si falla el aviso, solo queda anotado: nunca tiene que impedir que se guarden los cortes.
  try {
    const { enviada } = await llamarApi('/api/alerta', { texto, detalle });
    console.warn(enviada ? '   → avisado por Telegram' : '   → ya se había avisado hoy');
  } catch (error) {
    console.warn(`   → no pude avisar por Telegram: ${(error as Error).message}`);
  }
}

if (import.meta.main) {
  const [texto, detalle] = process.argv.slice(2);
  if (!texto) throw new Error('Uso: node src/alertar.ts "texto" "detalle opcional"');
  await alertar(texto, detalle);
}
