FROM node:22-alpine

WORKDIR /usr/src/app

# Install dependencies (workspace-aware) from lockfile. Every workspace's manifest must be
# copied here, or npm ci skips that workspace's dependencies.
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/api/package*.json ./packages/api/
COPY packages/view/package*.json ./packages/view/
RUN npm ci

# Build: core (tsc) + static assets + api + view library/embed, assembled into packages/api/static.
COPY . .
RUN npm run build

# Drop devDependencies for the runtime image (the language server runs compiled JS).
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 50014

CMD ["npm", "start"]
