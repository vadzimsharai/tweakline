FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server.mjs store.mjs cli.mjs mcp.mjs protocol.mjs instructions.md build.mjs ./
COPY server ./server
RUN node build.mjs

FROM node:22-alpine
WORKDIR /app
# No package.json in /app, so the CommonJS bundle keeps the name compose.yml and the skill run.
COPY --from=build /app/dist/tweakline.cjs ./tweakline.js
RUN mkdir -p /data && chown node:node /data
USER node
ENTRYPOINT ["node", "tweakline.js"]
