# syntax=docker/dockerfile:1
FROM node:20-slim

WORKDIR /app

# Install standard CA certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# lambda.js exports an AWS Lambda handler (event, context) -> response, with
# no listener of its own -- server.js is the adapter that binds $PORT and
# calls it per-request, so the container runs the same code path AWS does.
# (mcp_wrapper.js, the stdio entrypoint, is deliberately not in this repo --
# see .gitignore -- so it was never a valid CMD target here.)
CMD ["node", "server.js"]

