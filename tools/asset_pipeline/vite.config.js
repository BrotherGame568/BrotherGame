import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: 4174,
        open: true,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:4185',
                changeOrigin: true,
            },
        },
    },
    preview: {
        port: 4174,
    },
    build: {
        target: 'es2020',
        outDir: 'dist',
    },
});
