# Self-hosted AgentPassport indexer (Envio HyperIndex v3). Used by docker-compose.yml.
FROM node:24-slim

# psql lets HyperIndex dump/restore its effect cache.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /envio-indexer
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY config.yaml schema.graphql tsconfig.json envio-env.d.ts ./
COPY src ./src
RUN npx envio codegen

ENV ENVIO_TUI=false
CMD ["npx", "envio", "start"]
