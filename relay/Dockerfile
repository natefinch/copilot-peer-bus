FROM node:22-alpine
WORKDIR /app
COPY relay/server.mjs ./server.mjs
ENV PORT=7777 HOST=0.0.0.0
EXPOSE 7777
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7777/healthz || exit 1
CMD ["node", "server.mjs"]
