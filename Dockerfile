FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# vendor/ holds the patched libsignal that package.json installs from, so it must exist before npm install
COPY package*.json ./
COPY vendor ./vendor
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .

# Keep these on a persistent volume or you will have to re-link after every deploy:
#   /app/session  (WhatsApp login)   /app/data  (sudo list, sticker commands, timers, menu image)
VOLUME ["/app/session", "/app/data"]

EXPOSE 3000
CMD ["node", "index.js"]
