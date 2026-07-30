# ---------- deps ----------
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Chromium comes from apt in the runner stage — skip Puppeteer's Chrome download.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./

RUN npm ci --omit=dev


# ---------- builder ----------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Chromium comes from apt in the runner stage — skip Puppeteer's Chrome download.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm ci

# If applicable:
# RUN npm run build


# ---------- runner ----------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV LIBREOFFICE_PATH=/usr/bin/soffice
# Puppeteer launches the apt-installed Chromium (no bundled Chrome in the image).
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        libreoffice-writer \
        fonts-liberation \
        fonts-dejavu \
        fonts-crosextra-carlito \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp && chmod 1777 /tmp

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app ./

RUN addgroup --system app && \
    adduser --system --ingroup app app

USER app

EXPOSE 6830

CMD ["npm", "start"]