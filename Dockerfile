FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy backend source
COPY backend/ ./

# Copy frontend files to be served by Express
COPY frontend/ ./public/

# Expose ports for HTTP and WebSocket
EXPOSE 3000 8765

# Start the server
CMD ["npm", "start"]
