FROM oven/bun:1.4.0 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
FROM oven/bun:1.4.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun
ENV HOST=0.0.0.0 PORT=3000 PATCH_DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["bun", "src/index.ts"]
