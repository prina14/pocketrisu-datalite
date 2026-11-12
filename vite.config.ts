import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs';
import { precompressedAssets } from './scripts/precompress-assets.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// https://vitejs.dev/config/
export default defineConfig(({command, mode}) => {
  return {
    define: {
      '__APP_VERSION__': JSON.stringify(pkg.version),
    },
    plugins: [
      precompressedAssets(),
      {
        name: 'inline-startup-layout',
        transformIndexHtml(html) {
          const css = readFileSync('./src/styles/startup-shell.css', 'utf8');
          return html.replace('<!-- startup-style -->', `<style>${css}</style>`)
            .replace('<!-- startup-layout -->', readFileSync('./src/etc/startup-layout.html', 'utf8'))
            .replace('<!-- startup-presentation -->', `<script>${readFileSync('./src/ts/startupPresentation.js', 'utf8').replace(/^export /gm, '').replace(/\b__APP_VERSION__\b/g, JSON.stringify(pkg.version))}\napplyStartupPresentation(document.getElementById('preloading'));</script>`);
        },
      },
      svelte({
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          // disable a11y warnings
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
      command === 'build' ? strip({
        include: '**/*.(mjs|js|svelte|ts)',
        functions: ['console.log', 'console.debug', 'console.table', 'assert.*'],
      }) : null
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      // hmr: false,
    },
    // to make use of `TAURI_ENV_DEBUG` and other env variables
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      target:'baseline-widely-available',
      // don't minify for debug builds
      minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
      // produce sourcemaps for debug builds
      sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
      chunkSizeWarningLimit: 2000,
    },
    
    optimizeDeps:{
      exclude: [
        "@browsermt/bergamot-translator"
      ],
      needsInterop:[
        "@mlc-ai/web-tokenizers"
      ]
    },

    resolve:{
      alias:{
        'src':'/src',
        '$lib':'/src/lib',
      }
    },
    worker: {
      format: 'es'
    }
}
});
