FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server/*.mjs ./
COPY --chown=node:node game-backend-contract.json ./
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
