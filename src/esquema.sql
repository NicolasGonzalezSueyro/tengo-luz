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
