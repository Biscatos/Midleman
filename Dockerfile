# Use official Bun image
FROM oven/bun:1 AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (if any)
RUN bun install --production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Expose the port
EXPOSE 3000

# Set environment (these will be overridden by docker-compose or runtime)
ENV PORT=3000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun run -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the application
CMD ["bun", "run", "src/index.ts"]
