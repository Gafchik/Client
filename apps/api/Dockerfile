FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api ./apps/api
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/tsconfig.build.json ./apps/api/tsconfig.build.json
COPY apps/api/src ./apps/api/src
RUN npm run build -w apps/api

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# git нужен серверному getGitContext(): API сам выполняет `git log`/`git status`
# в папке проекта и вкладывает результат в промпт агентов. Без этого слабые
# модели «имитируют» git-команды созданием файлов git_log_output.txt и не
# удаляют их — репозиторий клиента засоряется. С git в образе контекст идёт
# реально, и junk-фильтр + промпты держат репо чистым.
RUN apk add --no-cache git
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
CMD ["node", "apps/api/dist/main.js"]

FROM node:24-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
# git нужен серверному getGitContext() (см. комментарий в runner-стадии).
RUN apk add --no-cache git
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src
CMD ["npm", "run", "start:dev", "-w", "apps/api"]
