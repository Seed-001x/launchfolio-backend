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
# Migrations, then the watchlist indexer (backgrounded), then the API.
# All in one container to stay on the free tier; indexer resumes from
# its checkpoint after sleep/wake.
CMD ["sh", "-c", "node src/db/migrate.js && (node src/indexer/watch.js &) && node src/api/server.js"]
