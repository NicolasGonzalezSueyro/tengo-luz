# ¿Tengo luz?

Mapa de cortes y mantenimientos de luz por barrio en Córdoba capital.

> Proyecto personal, **no oficial**. No tiene relación con EPEC.

## Estado

🚧 En desarrollo — Fase 2: del texto al barrio.

## Cómo funciona (por ahora)

1. `src/fuentes/eldoce.ts` busca en el sitemap de noticias de [El Doce](https://eldoce.tv) las notas diarias con los cortes programados que anuncia EPEC.
2. De cada nota toma solo la sección de Córdoba capital y convierte cada renglón (`De 8 a 12:30: barrios La Favela y Villa Urquiza.`) en un dato ordenado.
3. `src/barrios.ts` convierte la zona en barrios del mapa: normaliza los nombres (tildes, "Sud"/"Sur", "Loteo") y usa la tabla [`data/alias-barrios.json`](data/alias-barrios.json) para los que EPEC escribe distinto. Lo que no reconoce queda en `sinUbicar`.
4. `src/lector.ts` junta todo y lo guarda en [`data/mantenimientos.json`](data/mantenimientos.json), que funciona como historial.

El mapa de barrios ([`data/barrios.geojson`](data/barrios.geojson)) se arma con `npm run barrios`:

- **485 polígonos oficiales** de la capa de barrios de la Municipalidad de Córdoba.
- **~320 puntos** de OpenStreetMap para lugares que la Municipalidad no tiene (asentamientos, loteos nuevos). Solo se sabe dónde quedan, no su forma.
- Los nombres municipales vienen en mayúsculas y sin tildes; si OSM tiene el mismo barrio, se usa su nombre ("Argüello").

### La tabla de alias

Cada alias dice "cuando la nota dice X, en el mapa es Y". Solo se agregan con evidencia: ubicando el lugar en un mapa y comprobando que cae dentro del polígono asignado. Por ejemplo, la plaza "B° Parque Horizonte" queda dentro del barrio oficial **Horizonte**.

Un alias en `null` marca un nombre que **no se debe ubicar** automáticamente: es ambiguo o queda fuera de la ciudad (ej.: "Loteo Santa Mónica", que EPEC lista con capital pero está en Calamuchita).

## Usarlo

Requiere Node.js 24 o más nuevo.

```bash
npm install
npm test           # corre los tests
npm run lector     # actualiza data/mantenimientos.json
npm run barrios    # vuelve a descargar los límites de barrios (casi nunca hace falta)
```

## Fuente de los datos

- **Cortes:** notas públicas de El Doce, que replican los anuncios de EPEC. Cada corte guarda el link a la nota de origen.
- **Barrios:** capa pública de barrios de la [Municipalidad de Córdoba](https://cordoba.maps.arcgis.com/home/item.html?id=60f4e6cbb6ee47e88679a76a5b763326) (ArcGIS), complementada con datos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) bajo licencia ODbL.
