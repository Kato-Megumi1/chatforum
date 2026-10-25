# Stage 1: Build backend
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS backend-builder
RUN apk add --no-cache openssl
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY backend/ ./
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev --legacy-peer-deps

# Stage 2: Build frontend
FROM ${NODE_IMAGE} AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ ./
RUN npm run build

# Stage 3: Final production image
FROM ${NODE_IMAGE}
RUN apk add --no-cache nginx supervisor openssl font-noto-cjk

# Backend
WORKDIR /app/backend
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=backend-builder /app/backend/node_modules ./node_modules
COPY --from=backend-builder /app/backend/package.json ./
COPY --from=backend-builder /app/backend/prisma ./prisma
COPY --from=backend-builder /app/backend/monitor-public ./monitor-public

# Frontend - served by nginx
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# Nginx config
COPY docker/nginx.conf /etc/nginx/http.d/default.conf

# Supervisor config
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Novel source, uploads and vectors are runtime volumes, never image layers.

# Create uploads directory
RUN mkdir -p /app/backend/uploads/avatars

# Custom entrypoint
COPY backend/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 80
CMD ["/app/entrypoint.sh"]
