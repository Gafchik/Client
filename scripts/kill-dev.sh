#!/usr/bin/env sh
# Чистим зависшие dev-процессы проекта перед стартом, чтобы повторный
# `npm run start` не падал с EADDRINUSE: зомби `tsx watch`/vite из прошлого
# запуска могут всё ещё слушать порты 3010 (API) и 5173 (web).
#
# Убиваем строго по слушающим портам — это точечно и не задевает чужие
# процессы (PHPStorm, VS Code, другие проекты).
for port in 3010 5173; do
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[dev:kill] killing listeners on $port: $pids"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
done
exit 0
