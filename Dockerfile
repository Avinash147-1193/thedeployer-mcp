# The Deployer's MCP server, for registries and sandboxes that run a server from a container.
# The server is a stdio bridge with no dependencies: it forwards MCP messages to The Deployer's hosted endpoint.
# Introspection (initialize, tools/list) works without a key; the other tools need THEDEPLOYER_API_KEY.
FROM node:22-alpine

WORKDIR /app
COPY package.json index.mjs README.md LICENSE ./

# Never runs as root: the bridge only reads stdin, writes stdout and calls one HTTPS endpoint.
USER node

ENV THEDEPLOYER_MCP_URL="https://app.thedploy.com/api/v1/mcp"

ENTRYPOINT ["node", "/app/index.mjs"]
