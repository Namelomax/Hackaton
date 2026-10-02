# syntax=docker/dockerfile:1
#
# Образ веб-приложения Протоколера (Next.js).
#
# Собирать там, где есть интернет: `npm ci` и шрифты next/font/google
# скачиваются ПРИ СБОРКЕ. Готовый образ работает без выхода наружу — для
# закрытого контура его собирают снаружи и переносят через docker save/load
# (scripts/contour/bundle-images.sh, deploy/contour/README.md).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Внутри контейнера слушаем все интерфейсы; наружу порт публикует compose
# (по умолчанию только на 127.0.0.1 — см. WEB_PORT).
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
# Файлы, которые приложение читает с диска во время работы:
#   lib/docx-template/assets — корпоративный шаблон протокола (DOCX);
#   data — глоссарий терминов (lib/prompts/glossary.ts). Без него глоссарий
#   молча пропадал из промпта в контейнере.
COPY --from=builder /app/lib/docx-template/assets ./lib/docx-template/assets
COPY --from=builder /app/data ./data
USER nextjs
EXPOSE 3000
# /api/health/db: процесс жив И база доступна. Без БД приложение бесполезно,
# поэтому «healthy» без неё вводил бы в заблуждение.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/db').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node_modules/.bin/next start -H \"$HOSTNAME\" -p \"$PORT\""]
