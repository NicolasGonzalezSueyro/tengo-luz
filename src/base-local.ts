import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { BaseDeDatos } from './reportes.ts';

/** Una base SQLite en memoria que imita a D1 de Cloudflare, para los tests y `npm run dev`. Se borra al cerrar. */
export function baseLocal(): BaseDeDatos {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('esquema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const consulta = db.prepare(sql);
      return {
        bind: (...valores: SQLInputValue[]) => ({
          all: async () => ({ results: consulta.all(...valores) }),
          first: async () => consulta.get(...valores) ?? null,
          run: async () => consulta.run(...valores),
        }),
      };
    },
  };
}
