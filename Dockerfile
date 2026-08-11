# syntax=docker/dockerfile:1
FROM node:20-slim

WORKDIR /app

# Install standard CA certs and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Optional BuildKit secret mount for injecting engine binaries in custom deployments
ARG ENGINES_S3_URI=""
RUN --mount=type=secret,id=aws_credentials \
    if [ -z "$ENGINES_S3_URI" ]; then \
      echo "ENGINES_S3_URI build arg not set -- building standard gateway deployment."; \
      exit 0; \
    fi; \
    if [ ! -f /run/secrets/aws_credentials ]; then \
      echo "ENGINES_S3_URI is set but no aws_credentials secret was supplied to this build -- building standard deployment."; \
      exit 0; \
    fi; \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" >/dev/null 2>&1 \
      && unzip -q awscliv2.zip \
      && ./aws/install \
      && rm -rf aws awscliv2.zip || { echo "aws-cli install skipped"; }; \
    . /run/secrets/aws_credentials; \
    mkdir -p engines; \
    aws s3 sync "$ENGINES_S3_URI" engines/ || { echo "aws s3 sync failed -- building without engine coverage."; rm -rf engines; exit 0; }; \
    node -e "for (const n of Object.values(require('./mcp_wrapper.js').ENGINE_NAMES)) console.log(n)" > /tmp/engine_names.txt; \
    while IFS= read -r name; do chmod +x "engines/$name" 2>/dev/null || true; done < /tmp/engine_names.txt; \
    ls -la engines/ || true

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "mcp_wrapper.js", "--sse"]

