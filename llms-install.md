# Installing The Deployer MCP server (for AI agents such as Cline)

The Deployer is a hosted MCP server. Nothing needs to be built or cloned.

## Option 1: sign in (recommended, no key)

Add a remote server with this address and transport:

- URL: `https://app.thedploy.com/mcp`
- Transport: streamable HTTP

For Cline, add this to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "thedeployer": {
      "type": "streamableHttp",
      "url": "https://app.thedploy.com/mcp"
    }
  }
}
```

The first time a tool needs the account, the client opens The Deployer in the browser: the person signs in (or
signs up free) and approves. `check_repo` and `guide` work before signing in.

## Option 2: a local command with an API key

For clients that can't sign in. Needs Node.js 18 or later.

1. The person creates an API key on their Profile page at https://portal.thedploy.com (choose **Operate** to let the
   agent set up and launch projects). Ask them to paste it into the settings file themselves; never put it in a file
   that is committed to git.
2. Add:

```json
{
  "mcpServers": {
    "thedeployer": {
      "command": "npx",
      "args": ["-y", "thedeployer-mcp"],
      "env": { "THEDEPLOYER_API_KEY": "dpl_..." }
    }
  }
}
```

## Check it works

Call the `guide` tool (no account needed), then `account` once signed in.
