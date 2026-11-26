// Dev UI for the RFQ demo (port 18890). /api and /hooks go to the demo backend (server/node-host.mjs, port 18891),
// which holds the HIOBuy API key. Nothing key-related is configured or bundled here.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.DEMO_BACKEND_ORIGIN ?? "http://127.0.0.1:18891";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    host: "127.0.0.1", port: 18890, strictPort: true,
    proxy: { "/api": { target: backend }, "/hooks": { target: backend }, "/health": { target: backend } },
  },
  preview: { host: "127.0.0.1", port: 18890, strictPort: true },
  build: { outDir: "dist", sourcemap: false },
});
