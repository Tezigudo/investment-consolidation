import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const root = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, root, '');
  const webPort = Number(env.WEB_PORT ?? 5173);
  const apiPort = Number(env.API_PORT ?? 4000);

  return {
    plugins: [react()],
    envDir: root,
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
