FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app/backend

# Dependencies first, so source changes don't reinstall them
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Same layout as the repo: server.js reads ../shared and serves ./public
WORKDIR /app
COPY shared/ ./shared/
COPY backend/ ./backend/
COPY frontend/ ./backend/public/

WORKDIR /app/backend
USER node
EXPOSE 3000 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO /dev/null http://127.0.0.1:3000/ || exit 1
# node directly (not npm start) so docker stop's SIGTERM reaches the server
CMD ["node", "server.js"]
