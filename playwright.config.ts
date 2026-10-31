import { defineConfig, devices } from '@playwright/test';

// Tests de punta a punta (`npm run e2e`): un navegador de verdad abre la página servida por `npm run dev`,
// toca botones y revisa lo que se ve, como lo haría una persona. Corren en una compu y en un celular simulados.

export default defineConfig({
  testDir: 'e2e',
  // Uno a la vez: comparten el servidor de prueba (y su base en memoria, donde cada conexión reporta una sola vez).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4399',
    trace: 'retain-on-failure', // si algo falla, queda una "grabación" paso a paso para ver qué pasó
  },
  projects: [
    { name: 'compu', use: { ...devices['Desktop Chrome'] } },
    { name: 'celular', use: { ...devices['Pixel 7'] } },
  ],
  // Un servidor propio, en otro puerto y siempre nuevo: así la base de prueba arranca vacía en cada corrida
  // (y no choca con un `npm run dev` que esté abierto).
  webServer: {
    command: 'node src/servidor.ts',
    env: { PUERTO: '4399' },
    url: 'http://127.0.0.1:4399',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
