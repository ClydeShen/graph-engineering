# MemexOS all-components image — Node 22 single base (TD-M, ADR-48).
# One image, four commands: gateway / workers / control-plane / iii engine.
# Build context is the repo root: docker build -f deploy/Dockerfile .

FROM node:22-slim

# iii engine binary (event bus) + curl for healthchecks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates jq \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://install.iii.dev/iii/main/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Workspace install. package.json files first would cache better, but npm
# workspaces need every package manifest — repo is small, correctness wins.
COPY . .
RUN npm ci

# Default command: gateway. docker-compose.yml overrides per service.
ENV MEMEX_BIND=0.0.0.0
EXPOSE 3000
CMD ["node", "--import", "tsx/esm", "packages/gateway/src/index.ts"]
