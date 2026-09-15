FROM node:24-alpine AS build
WORKDIR /app/lms-web
COPY lms-web/package*.json ./
RUN npm ci
COPY lms-web/index.html lms-web/tsconfig*.json lms-web/vite.config.ts ./
COPY lms-web/src ./src
COPY lms-web/shared ./shared
COPY lms-web/public ./public
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
COPY lms-web/server/requirements-storage.txt /tmp/requirements-storage.txt
RUN apk add --no-cache python3 py3-pip && python3 -m venv /opt/storage-venv && /opt/storage-venv/bin/pip install --no-cache-dir -r /tmp/requirements-storage.txt
ENV PYTHON_EXECUTABLE=/opt/storage-venv/bin/python
WORKDIR /app/lms-web
COPY lms-web/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/lms-web/dist ./dist
COPY lms-web/server ./server
COPY lms-web/scripts/reset-account.mjs ./scripts/reset-account.mjs
COPY lms-web/shared ./shared
COPY database.py /app/database.py
COPY config.py storage_codec.py /app/
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "server/index.mjs"]
