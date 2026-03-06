import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@scenes': path.resolve(__dirname, 'game/scenes'),
      '@systems': path.resolve(__dirname, 'game/core/systems'),
      '@services': path.resolve(__dirname, 'game/core/services'),
      '@data': path.resolve(__dirname, 'game/core/data'),
      '@entities': path.resolve(__dirname, 'game/core/entities'),
      '@assets': path.resolve(__dirname, 'game/assets'),
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
});
