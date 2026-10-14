# syntax=docker/dockerfile:1

# Production image for a DigitalOcean Droplet (or any Docker host).
#   docker build -t resume-formatter .
#   docker build --target migrator -t resume-formatter-migrator .   # runs `prisma migrate deploy`

ARG NODE_VERSION=24-alpine

# ---- deps: install all dependencies (dev deps are needed to build) ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
# Prisma schema/config are needed by the `postinstall` client generation.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

# ---- builder: compile the Next.js standalone server ------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
# NEXT_PUBLIC_* values are inlined into the client bundle at build time.
ARG NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---- migrator: one-off container that applies database migrations ----------
FROM deps AS migrator
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- runner: minimal runtime image ----------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Server-only secrets (DATABASE_URL, AUTH_SECRET, ...) are provided at runtime
# via `docker run --env-file` — never baked into the image.
CMD ["node", "server.js"]
