FROM node:22-alpine

WORKDIR /usr/src/app

# Chromium + fonts for the headless render done by L0013's `snap` compiler. Use the system
# Chromium (Alpine's) rather than Puppeteer's bundled download (which is glibc-only).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Install dependencies (workspace-aware) from lockfile.
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/api/package*.json ./packages/api/
COPY packages/view/package*.json ./packages/view/
RUN npm ci

# Build: core (tsc) + static assets + view library/embed, assembled into packages/api/static.
COPY . .
RUN npm run build

# Drop devDependencies for the runtime image (the language server runs compiled JS).
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 50013

CMD ["npm", "start"]
