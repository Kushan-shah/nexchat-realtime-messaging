# ---- Base Node ----
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/

# ---- Dependencies ----
FROM base AS dependencies
RUN npm ci
RUN npx prisma generate

# ---- Development ----
FROM dependencies AS development
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]

# ---- Build (Production) ----
FROM dependencies AS build
COPY src ./src
# Add any build steps here if needed (e.g. JS compilation)

# ---- Production ----
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/prisma ./prisma

# Add a non-root user for security
RUN addgroup -g 1001 -S nodeuser && adduser -u 1001 -S nodeuser -G nodeuser
USER nodeuser

EXPOSE 3000
CMD ["npm", "start"]
