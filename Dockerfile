# ---- Build Stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# Copy frontend package files
COPY apas-frontend/package*.json ./apas-frontend/

# Install dependencies
RUN cd apas-frontend && npm install

# Copy the rest of the frontend source
COPY apas-frontend ./apas-frontend

# Build the Next.js app (this will create .next)
RUN cd apas-frontend && npm run build

# ---- Runtime Stage ----
FROM node:22-alpine

WORKDIR /app

# Copy built files from builder
COPY --from=builder /app/apas-frontend/.next ./.next
COPY --from=builder /app/apas-frontend/public ./public
COPY --from=builder /app/apas-frontend/package.json ./package.json
COPY --from=builder /app/apas-frontend/node_modules ./node_modules

# Expose the port Next.js runs on
EXPOSE 3000

# Start the server
CMD ["npm", "start"]