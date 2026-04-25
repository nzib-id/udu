import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:4247',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:4247',
      },
    },
  },
  preview: {
    port: 4246,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
