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
WORKDIR /app/lms-web
COPY lms-web/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/lms-web/dist ./dist
COPY lms-web/server ./server
COPY lms-web/scripts/reset-account.mjs ./scripts/reset-account.mjs
COPY lms-web/shared ./shared
COPY database.py /app/database.py
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "server/index.mjs"]
