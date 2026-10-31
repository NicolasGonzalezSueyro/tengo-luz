-- Tabla de reportes de vecinos ("No tengo luz"). Se crea una sola vez, pegando esto en la consola de D1.
-- No se guarda la IP: "huella" es un código que sale de la IP + una clave secreta + el día, y cambia cada día.
CREATE TABLE IF NOT EXISTS reportes (
  id INTEGER PRIMARY KEY,
  barrio TEXT NOT NULL,
  creado INTEGER NOT NULL, -- milisegundos desde 1970 (Date.now())
  huella TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reportes_creado ON reportes (creado);
