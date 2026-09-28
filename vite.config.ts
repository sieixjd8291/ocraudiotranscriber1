import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
    },
    build: {
      // Emit source maps for first-party bundles so production minified code can
      // be mapped back to original source in browser DevTools (Lighthouse BP).
      sourcemap: true,
      // Inject <link rel="modulepreload"> for the entry chunk + its imports, and
      // preload dynamically-imported chunks at runtime. This collapses the deep
      // waterfall where dependency chunks are only discovered after their parent
      // module finishes loading. The legacy polyfill is skipped (modern browsers
      // support modulepreload natively); browsers without it still work, they
      // just fall back to normal module fetching.
      modulePreload: { polyfill: false },
      rollupOptions: {
        output: {
          // Consolidate large vendor deps into stable, cacheable chunks so the
          // browser isn't chaining 15+ tiny sequentially-discovered modules.
          // App code stays split via the React.lazy() boundaries in App.tsx.
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            const m = id.match(/[\\/]node_modules[\\/](?:@([^\\/]+)[\\/])?([^\\/]+)/);
            if (!m) return;
            const [, scope, name] = m;
            if (scope === 'ffmpeg') return 'ffmpeg';                       // @ffmpeg/*
            if (scope === 'google' && name === 'genai') return 'genai';
            if (['react-syntax-highlighter', 'refractor', 'prismjs', 'lowlight'].includes(name)) return 'syntax';
            if (name === 'recharts' || name.startsWith('d3-') || name === 'victory-vendor') return 'charts';
            if (name === 'motion') return 'motion';
            if (name === 'lucide-react') return 'icons';
            if (name === 'sonner') return 'sonner';
            if (['react', 'react-dom', 'scheduler'].includes(name)) return 'react-vendor';
          },
        }
      }
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
