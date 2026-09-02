FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /app/private && chown node:node /app/private
USER node
ENV NODE_ENV=production PORT=3000 AUTH_DB_PATH=/app/private/auth.sqlite
EXPOSE 3000
CMD ["node", "src/server.mjs"]
