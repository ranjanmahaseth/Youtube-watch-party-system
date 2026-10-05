import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  /*
   * Vite inlines VITE_* variables at BUILD time, so a deployed bundle cannot be
   * re-pointed at a different backend without rebuilding. That makes a missing
   * value unfixable after the fact: the deploy would quietly ship
   * `http://localhost:5000` and every socket connection would fail with no
   * obvious cause. Fail here instead, loudly, while it is still cheap.
   */
  if (mode === 'production' && !env.VITE_SERVER_URL) {
    throw new Error(
      [
        'VITE_SERVER_URL is required for a production build.',
        '',
        'Set it to the public URL of the deployed backend, for example:',
        '  VITE_SERVER_URL=https://your-backend.onrender.com',
        '',
        'Locally it lives in client/.env.',
        'On Render set it as a BUILD-time environment variable (not runtime).',
      ].join('\n'),
    );
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
    },
  };
});


