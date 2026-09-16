FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=43110 DATABASE_PATH=/data/dia.sqlite
EXPOSE 43110
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:43110/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
