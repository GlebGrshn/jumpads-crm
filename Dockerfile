FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node certs ./certs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production DB_PATH=/app/data/crm.sqlite
EXPOSE 3000
CMD ["node", "src/server.js"]
