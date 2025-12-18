# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=23.11.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
# Copy patches directory before install so patch-package can apply them
COPY patches ./patches
RUN npm ci --include=dev --ignore-scripts
# postinstall script will automatically run patch-package, but verify it worked
RUN npx patch-package

# Copy application code
COPY . .

# Build application
RUN npm run build

# Remove development dependencies for smaller production image
# Keep patch-package available for future installs if needed
RUN npm prune --omit=dev


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Copy bazaar cache file to ensure it's available at startup
# This provides an initial cache so the MCP tool works immediately
COPY --from=build /app/bazaar-resources.json /app/bazaar-resources.json

# Start the server by default, this can be overwritten at runtime
EXPOSE 3232
CMD [ "npm", "run", "start" ]
