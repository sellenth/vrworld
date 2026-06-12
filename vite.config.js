import { defineConfig } from "vite";

// __BUILD_ID__ changes on every build/dev-start. The PartyKit server uses it to
// tell already-connected peers to reload when a newer version is deployed.
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString()),
  },
  server: { host: true },
});
