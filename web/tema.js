// Aplica el tema guardado (claro u oscuro) antes de dibujar la página, para que no "parpadee".
// Es un archivo aparte (y no un <script> dentro del HTML) porque la política de seguridad del sitio
// solo deja correr código que venga de archivos del propio sitio.
try {
  const tema = localStorage.getItem('tema');
  if (tema) document.documentElement.dataset.tema = tema;
} catch {
  // Sin almacenamiento (modo privado): se usa el tema del sistema.
}
