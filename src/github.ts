// Pedirle a GitHub que corra un robot (workflow) ya, sin esperar a su horario. Necesita el secreto GITHUB_TOKEN de
// Cloudflare (un token con permiso "Actions: write" sobre el repositorio). Si ya hay una corrida en marcha, GitHub
// deja una sola esperando (el robot tiene "concurrency"), así que pedirlo de más no amontona corridas.

export const REPOSITORIO = 'NicolasGonzalezSueyro/tengo-luz';

/** Devuelve true si GitHub aceptó el pedido. Nunca tira error: sin conexión, false. */
export async function correrRobot(token: string, workflow: string): Promise<boolean> {
  const respuesta = await fetch(`https://api.github.com/repos/${REPOSITORIO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tengo-luz' },
    body: JSON.stringify({ ref: 'main' }),
  }).catch(() => null);
  return Boolean(respuesta?.ok);
}
