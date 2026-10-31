# Momo server: text it on Telegram/WhatsApp, it does the errand.
#   docker compose up -d        (after `npm run setup` wrote .env)
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY skills ./skills
# Browsers in a shared path: installed as root, used by the unprivileged user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev --no-audit --no-fund \
    && node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "packages/cloud/src/main.ts"]
