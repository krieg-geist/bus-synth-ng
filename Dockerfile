FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./backend/

# Install dependencies
WORKDIR /app/backend
RUN npm ci --only=production

# Go back to app root to copy files
WORKDIR /app

# Copy shared constants (maintains same relative structure as dev)
COPY shared/ ./shared/

# Copy backend source (maintains directory structure)
COPY backend/ ./backend/

# Copy frontend files to be served by Express (backend expects them in ./public relative to server.js)
COPY frontend/ ./backend/public/

# Expose ports for HTTP and WebSocket
EXPOSE 3000 8765

# Run from backend directory to maintain relative paths
WORKDIR /app/backend
CMD ["npm", "start"]
