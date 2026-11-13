# DDALLANG 백엔드 이미지. 컨테이너가 시작될 때 마이그레이션을 적용한 뒤 서버를 띄운다.
FROM node:22-slim AS build
RUN npm install -g pnpm@12.18.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm db:generate && pnpm build

FROM node:22-slim
# Prisma 마이그레이션 엔진이 openssl을 쓴다.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json ./
# NODE_ENV, DATABASE_URL, CURSOR_KEY, CORS_ORIGINS 등은 호스팅의 환경변수로 넣는다(이미지에 넣지 않는다).
EXPOSE 3001
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
