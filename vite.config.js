import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  worker: {
    format: "es",
  },
  build: {
    outDir: "public/build",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: "public/app.js",
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
