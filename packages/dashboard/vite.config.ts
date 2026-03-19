import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:7891",
        changeOrigin: true,
      },
      "/terminal": {
        target: "ws://localhost:7891",
        ws: true,
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:7891",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split React core into its own chunk
          if (id.includes("/node_modules/react/") ||
              id.includes("/node_modules/react-dom/") ||
              id.includes("/node_modules/react-router-dom/")) {
            return "vendor-react";
          }

          // Split Mantine UI library into its own chunk
          if (id.includes("/node_modules/@mantine/")) {
            return "vendor-mantine";
          }

          // Split xterm.js terminal library into its own chunk
          if (id.includes("/node_modules/@xterm/")) {
            return "vendor-xterm";
          }

          // Split react-mosaic window manager into its own chunk
          if (id.includes("/node_modules/react-mosaic-component/")) {
            return "vendor-mosaic";
          }

          // Split markdown rendering libraries into their own chunk
          if (id.includes("/node_modules/marked/") || id.includes("/node_modules/dompurify/")) {
            return "vendor-markdown";
          }

          // Split Monaco editor into its own chunk
          if (id.includes("/node_modules/@monaco-editor/")) {
            return "vendor-monaco";
          }
        },
      },
    },
  },
});
