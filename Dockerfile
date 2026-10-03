FROM node:20-slim
WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev

# Copy the rest of the service.
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The API server. Run the indexer as a separate worker/container:
#   node src/indexer/pump.js
# Migrations run first on every boot (idempotent via schema_migrations),
# so the schema is always present — including after free-tier sleep/wake.
CMD ["sh", "-c", "node src/db/migrate.js && node src/api/server.js"]
