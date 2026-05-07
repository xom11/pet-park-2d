import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Owner has a pre-existing SSH tunnel on localhost:5173 (per CLAUDE.md), so we
// bind to 5174 to avoid the conflict. Override with `vite --port` if needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
  },
});
