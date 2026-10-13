# One image, two commands: the web app (default) and the worker (`npm run worker`).
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

FROM base AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Full tree incl. dev deps: the worker and migrations run through tsx / prisma.
COPY --from=build /app ./
RUN mkdir -p /app/uploads
EXPOSE 3000
# The app container applies pending migrations on start; the worker waits for the app's healthcheck.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
