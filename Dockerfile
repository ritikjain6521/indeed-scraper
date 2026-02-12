# Specify the base Docker image with Playwright and Chrome pre-installed.
FROM apify/actor-node-playwright-chrome:22 AS builder

# Set the working directory
WORKDIR /usr/src/app

# Switch to root to ensure we can set permissions on the working directory
USER root
RUN chown myuser:myuser /usr/src/app
USER myuser

# Copy just package.json and package-lock.json first to leverage Docker cache
COPY --chown=myuser:myuser package*.json ./

# Install all dependencies using npm ci
RUN npm ci --include=dev --audit=false

# Copy the rest of the source code
COPY --chown=myuser:myuser . ./

# Build the project (TypeScript to JavaScript)
RUN npm run build


# Create the final runtime image
FROM apify/actor-node-playwright-chrome:22

# Set the working directory
WORKDIR /usr/src/app

# Switch to root to ensure we can set permissions on the working directory
USER root
RUN chown myuser:myuser /usr/src/app
USER myuser

# Copy package.json
COPY --chown=myuser:myuser package*.json ./

# Install only production dependencies
# browsers are already in the base image, so we skip download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Installed NPM packages" \
    && rm -r ~/.npm

# Copy built JS files from the builder stage
COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

# Copy the remaining files (source code, schemas, etc.)
COPY --chown=myuser:myuser . ./

# Final verification that Playwright is ready (usually no-op on this image)
RUN npx playwright install chromium

# Start the Actor
CMD ["node", "dist/main.js"]
