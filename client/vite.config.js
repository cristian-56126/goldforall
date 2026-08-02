import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expone en la red local (celular: http://IP-del-PC:5310)
    port: 5310,
    // Falla si el puerto está ocupado en vez de saltar a otro: si Vite
    // cambiara de puerto, el origen dejaría de coincidir con CORS_ORIGINS.
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4310',
    },
  },
});
