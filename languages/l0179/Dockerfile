FROM node:22-alpine

WORKDIR /usr/src/app

# Install dependencies (workspace-aware) from lockfile.
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/api/package*.json ./packages/api/
COPY packages/view/package*.json ./packages/view/
COPY packages/integrations/learnosity/package*.json ./packages/integrations/learnosity/
RUN npm ci

# Build: core (tsc) + static assets + view library/embed + the Learnosity bundles, assembled
# into packages/api/static. Every workspace's manifest must be copied above, or npm ci skips
# that workspace's dependencies and the build fails on the first import it cannot resolve.
COPY . .
RUN npm run build

# Drop devDependencies for the runtime image (the language server runs compiled JS).
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 50179

CMD ["npm", "start"]
