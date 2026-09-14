# Security

Please report a vulnerability privately to security@thedploy.com, not in a public issue. Say what you found,
how to reproduce it, and which version you ran (`npx thedeployer-mcp --version`). We aim to reply within
three working days.

This package is a bridge: it sends MCP messages from your AI coding tool to The Deployer's hosted server at
`https://app.thedploy.com/api/v1/mcp`. Reports about that server, or about The Deployer itself, are welcome
at the same address.

## What the bridge promises

- Your API key goes only in the `Authorization` header of HTTPS requests to that endpoint. It never appears
  in logs, error messages, the command line or the URL.
- It has no dependencies.
- It doesn't follow redirects, and it refuses plain `http://` except to this computer.

## Supported versions

Only the latest release gets fixes.
