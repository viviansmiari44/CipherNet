# ---- Build Stage ----
FROM node:22-alpine AS builder

# Declare build arguments for all required env vars
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG SUPABASE_SERVICE_ROLE_KEY
ARG VAULT_ENCRYPTION_PASSWORD
# Add any other env vars your app needs during build (e.g., NEXT_PUBLIC_APP_URL)

# Set them as environment variables for the build
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
ENV VAULT_ENCRYPTION_PASSWORD=$VAULT_ENCRYPTION_PASSWORD

WORKDIR /app

# Copy package files and install dependencies
COPY apas-frontend/package*.json ./apas-frontend/
RUN cd apas-frontend && npm install

# Copy the rest of the frontend source
COPY apas-frontend ./apas-frontend

# Build the Next.js app (this requires the env vars above)
RUN cd apas-frontend && npm run build

# ---- Runtime Stage ----
FROM node:22-alpine

WORKDIR /app

# Copy built files and dependencies from the builder
COPY --from=builder /app/apas-frontend/.next ./.next
COPY --from=builder /app/apas-frontend/public ./public
COPY --from=builder /app/apas-frontend/package.json ./package.json
COPY --from=builder /app/apas-frontend/node_modules ./node_modules

# (Optional) Set runtime env vars – they are also needed by the server
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
ENV VAULT_ENCRYPTION_PASSWORD=$VAULT_ENCRYPTION_PASSWORD

EXPOSE 3000
CMD ["npm", "start"]