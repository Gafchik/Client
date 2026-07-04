import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

// Vite-прокси ходит к локальному API. Порт берётся из VITE_API_PORT
// (дефолт 3010) — тот же порт, что и PORT в корневом .env для API.
// Так фронт и бек остаются синхронизированы без ручной правки двух мест.
export default defineConfig(({ mode }) => {
  // loadEnv читает .env из корня (process.cwd() = root монорепо)
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.VITE_API_PORT || env.PORT || "3010";
  const apiTarget = `http://localhost:${apiPort}`;

  return {
    plugins: [vue()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        // nginx стрипает /api (proxy_pass http://api:3000/;) и бекенд живёт
        // без префикса. В dev повторяем то же: rewrite убирает /api.
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/ws": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
        "/socket.io": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
