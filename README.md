# ¿Tengo luz?

Mapa de cortes y mantenimientos de luz por barrio en Córdoba capital.

> Proyecto personal, **no oficial**. No tiene relación con EPEC.

## Estado

🚧 En desarrollo — Fase 1: lector de cortes programados.

## Cómo funciona (por ahora)

1. `src/fuentes/eldoce.ts` busca en el sitemap de noticias de [El Doce](https://eldoce.tv) las notas diarias con los cortes programados que anuncia EPEC.
2. De cada nota toma solo la sección de Córdoba capital y convierte cada renglón (`De 8 a 12:30: barrios La Favela y Villa Urquiza.`) en un dato ordenado.
3. `src/lector.ts` junta todo y lo guarda en [`data/mantenimientos.json`](data/mantenimientos.json), que funciona como historial.

## Usarlo

Requiere Node.js 24 o más nuevo.

```bash
npm install
npm test           # corre los tests
npm run lector     # actualiza data/mantenimientos.json
```

## Fuente de los datos

Los datos salen de las notas públicas de El Doce, que replican los anuncios de EPEC. Cada corte guarda el link a la nota de origen.
