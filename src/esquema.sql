-- Tablas de la base D1. Se crean pegando este archivo en la consola de D1 (si ya existen, no pasa nada).
-- No se guarda la IP: "huella" es un código que sale de la IP + una clave secreta + el día, y cambia cada día.
CREATE TABLE IF NOT EXISTS reportes (
  id INTEGER PRIMARY KEY,
  barrio TEXT NOT NULL,
  creado INTEGER NOT NULL, -- milisegundos desde 1970 (Date.now())
  huella TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reportes_creado ON reportes (creado);

-- Bot de Telegram: quién quiere avisos de qué barrio, y qué avisos ya se mandaron (para no repetirlos).
CREATE TABLE IF NOT EXISTS suscripciones (
  chat INTEGER NOT NULL, -- el número de chat de Telegram
  barrio TEXT NOT NULL,
  creado INTEGER NOT NULL,
  PRIMARY KEY (chat, barrio)
);
CREATE TABLE IF NOT EXISTS avisados (
  chat INTEGER NOT NULL,
  clave TEXT NOT NULL, -- identifica el corte: fecha, horario y zona
  creado INTEGER NOT NULL,
  PRIMARY KEY (chat, clave)
);

-- Notificaciones push: qué navegador quiere avisos de qué barrio, y qué avisos ya se mandaron.
-- "endpoint" es la dirección anónima que da el navegador; p256dh y auth son sus claves para cifrar el aviso.
CREATE TABLE IF NOT EXISTS push_suscripciones (
  endpoint TEXT NOT NULL,
  barrio TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  creado INTEGER NOT NULL,
  PRIMARY KEY (endpoint, barrio)
);
CREATE TABLE IF NOT EXISTS push_avisados (
  endpoint TEXT NOT NULL,
  clave TEXT NOT NULL,
  creado INTEGER NOT NULL,
  PRIMARY KEY (endpoint, clave)
);

-- Fallas no programadas que EPEC confirmó en sus redes y el admin cargó desde el bot (src/fallas.ts).
-- confirmada = 0: esperando /confirmar; 1: publicada; -1: aviso de "volvió el servicio" ya recibido (solo para no repetirlo).
-- "hasta": cuándo deja de mostrarse en el mapa.
CREATE TABLE IF NOT EXISTS fallas (
  id INTEGER PRIMARY KEY,
  lugares TEXT NOT NULL, -- lista JSON de barrios y localidades del mapa
  texto TEXT NOT NULL,
  fuente TEXT NOT NULL, -- link a la publicación ('' si se pegó el texto)
  creado INTEGER NOT NULL,
  hasta INTEGER NOT NULL,
  confirmada INTEGER NOT NULL DEFAULT 0,
  sector TEXT -- si EPEC describe calles: el área exacta como lista JSON de [longitud, latitud] (la arma el robot)
);
-- Si la tabla ya existía de antes (sin la columna "sector"), agregarla una sola vez en la consola de D1:
--   ALTER TABLE fallas ADD COLUMN sector TEXT;
