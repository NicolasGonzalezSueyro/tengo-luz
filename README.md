# ¿Tengo luz?

Mapa de cortes y mantenimientos de luz por barrio en Córdoba capital.

**🌐 [tengo-luz.pages.dev](https://tengo-luz.pages.dev)**

> Proyecto personal, **no oficial**. No tiene relación con EPEC.

## Estado

✅ Publicado y actualizándose solo cada hora, con reportes de vecinos. Próximo: alertas por Telegram.

## La página

Un mapa de Córdoba con los barrios pintados según los cortes programados del día elegido:

- 🟡 Barrios con corte programado; 🟠 los que tienen un corte **en curso ahora** laten y brillan.
- 🔴 **Vecinos sin luz:** cualquiera puede tocar "No tengo luz" en su barrio. Si no hay un corte anunciado en curso, el barrio se pinta de rojo con la cantidad de reportes de las últimas 3 horas.
- 📣 **Ayuda para reclamar a EPEC:** WhatsApp con el mensaje ya escrito, el formulario oficial, el texto para copiar y el 0800. La página nunca manda reclamos por su cuenta.
- 🟫 **Zonas aproximadas** (contorno marrón punteado) para los cortes que EPEC describe por una ruta en vez de por barrios.
- ☰ Menú con "¿Cómo funciona?", modo claro/oscuro y accesos para reclamar a EPEC.
- 📍 **Mi ubicación:** con el GPS encuentra tu barrio. La ubicación se usa solo en tu navegador, no se envía a ningún lado.
- 🔎 Buscador de barrios (no importan las tildes) y botones por día con la cantidad de cortes.
- 🗂️ Ficha de cada barrio: cortes del día, próximo y último corte.
- 🌙 Modo claro y oscuro (sigue al sistema y recuerda tu elección).
- 📱 En el celular, el mapa ocupa toda la pantalla y la lista es un panel que se desliza desde abajo.

Está hecha con HTML, CSS y JavaScript sin frameworks, y [Leaflet](https://leafletjs.com) para el mapa. La lógica (estados, días, en qué barrio cae un punto) está en [`web/estado.js`](web/estado.js), con tests.

## Cómo funcionan los datos

1. `src/fuentes/eldoce.ts` busca en el sitemap de noticias de [El Doce](https://eldoce.tv) las notas diarias con los cortes programados que anuncia EPEC.
2. De cada nota toma solo la sección de Córdoba capital y convierte cada renglón (`De 8 a 12:30: barrios La Favela y Villa Urquiza.`) en un dato ordenado.
3. `src/barrios.ts` convierte la zona en barrios del mapa: normaliza los nombres (tildes, "Sud"/"Sur", "Loteo") y usa la tabla [`data/alias-barrios.json`](data/alias-barrios.json) para los que EPEC escribe distinto. Lo que no reconoce queda en `sinUbicar`.
4. `src/lector.ts` junta todo y lo guarda en [`data/mantenimientos.json`](data/mantenimientos.json), que funciona como historial.

El mapa de barrios ([`data/barrios.geojson`](data/barrios.geojson)) se arma con `npm run barrios`:

- **485 polígonos oficiales** de la capa de barrios de la Municipalidad de Córdoba.
- **~320 puntos** de OpenStreetMap para lugares que la Municipalidad no tiene (asentamientos, loteos nuevos). Solo se sabe dónde quedan, no su forma.
- Los nombres municipales vienen en mayúsculas y sin tildes; si OSM tiene el mismo barrio, se usa su nombre ("Argüello").

### Zonas aproximadas

Algunos anuncios no nombran barrios sino una ruta ("zona rural sobre Ruta Nacional 9 hacia el norte", "Camino 60 Cuadras desde el Km 13"). Para esos, [`data/zonas.geojson`](data/zonas.geojson) tiene un corredor de unos 450 m a cada lado del tramo de la ruta, armado con el trazado de OpenStreetMap (`npm run zonas`). Cada zona tiene una expresión regular que reconoce el texto del anuncio. No es el límite real del corte, que EPEC no publica: es una referencia visual.

### La tabla de alias

Cada alias dice "cuando la nota dice X, en el mapa es Y". Solo se agregan con evidencia: ubicando el lugar en un mapa y comprobando que cae dentro del polígono asignado. Por ejemplo, la plaza "B° Parque Horizonte" queda dentro del barrio oficial **Horizonte**.

Un alias en `null` marca un nombre que **no se debe ubicar** automáticamente: es ambiguo o queda fuera de la ciudad (ej.: "Loteo Santa Mónica", que EPEC lista con capital pero está en Calamuchita).

## Reportes de vecinos

La única parte con servidor, y también gratis:

- [`functions/api/reportes.ts`](functions/api/reportes.ts) es una **Cloudflare Pages Function**: Cloudflare la convierte en la dirección `/api/reportes`. `GET` devuelve cuántos reportes tiene cada barrio en las últimas 3 horas y `POST` suma uno.
- Los reportes se guardan en **Cloudflare D1**, una base SQLite. La tabla está en [`src/esquema.sql`](src/esquema.sql).
- La lógica está en [`src/reportes.ts`](src/reportes.ts), con tests que usan un SQLite en memoria ([`src/base-local.ts`](src/base-local.ts)). `npm run dev` usa esa misma base para probar sin internet.

**Privacidad y abuso.** No se guarda la IP. Se guarda una "huella": el hash SHA-256 de la IP junto con una clave secreta y la fecha, así que cambia todos los días. Con la huella se limita a un reporte por barrio cada 3 horas y a 5 barrios por hora por persona. Los reportes se borran al día siguiente.

## Cómo se mantiene al día

Sin servidores ni ninguna compu prendida:

1. **GitHub Actions** ([`actualizar.yml`](.github/workflows/actualizar.yml)) corre cada hora en una máquina Ubuntu: instala, corre los tests y ejecuta el lector. Si hay cortes nuevos, hace un commit con los datos.
2. Ese commit dispara a **Cloudflare Pages**, que ejecuta `npm run build` y publica la carpeta `dist/`.
3. Además, [`tests.yml`](.github/workflows/tests.yml) corre los tests y el chequeo de tipos en cada push.

## Usarlo

Requiere Node.js 24 o más nuevo.

```bash
npm install
npm run dev        # abre la página en http://localhost:4321
npm run build      # arma la carpeta dist/ que se publica
npm test           # corre los tests
npm run lector     # actualiza data/mantenimientos.json
npm run barrios    # vuelve a descargar los límites de barrios (casi nunca hace falta)
npm run zonas      # vuelve a armar las zonas aproximadas sobre rutas
```

## Fuente de los datos

- **Cortes:** notas públicas de El Doce, que replican los anuncios de EPEC. Cada corte guarda el link a la nota de origen.
- **Barrios:** capa pública de barrios de la [Municipalidad de Córdoba](https://cordoba.maps.arcgis.com/home/item.html?id=60f4e6cbb6ee47e88679a76a5b763326) (ArcGIS), complementada con datos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) bajo licencia ODbL.
