# ---- deps: install production dependencies ----
FROM node:18-alpine AS deps
WORKDIR /app
COPY package*.json ./
# install production dependencies only
RUN npm ci --only=production

# ---- builder: install dev deps & build (if you have a build step) ----
FROM node:18-alpine AS builder
WORKDIR /app
COPY . .
# copy deps from deps stage so builder can run build quickly
COPY --from=deps /app/node_modules ./node_modules
RUN npm ci
# If you have a build step (TypeScript / transpile), uncomment:
# RUN npm run build

# ---- runner: production image ----
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# copy prod node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
# copy built app (or source if no build)
COPY --from=builder /app . 

EXPOSE 6830
# optional non-root user
RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["npm", "start"]
