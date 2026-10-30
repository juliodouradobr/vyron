/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configuração compatível com Tauri 2: porta fixa, sem limpar o terminal, alvo do WebView2.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome110',
    sourcemap: false,
  },
  // O AudioWorklet de ruído é empacotado como módulo ES (worklets carregam módulos, não scripts clássicos).
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
