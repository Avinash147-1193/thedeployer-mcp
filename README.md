# The Deployer MCP server

Use [The Deployer](https://thedploy.com) from Claude Code, Cursor, VS Code and other AI coding tools. Ask
whether a repository will deploy, plan a deploy, see where your projects stand, read the latest deployment
log, or put your latest code live, without leaving the editor.

The Deployer runs your app in your own DigitalOcean, AWS, Google Cloud or Azure account, so the cloud bills
you directly.

## Tools

| Tool | What it does | Key |
|---|---|---|
| `check_repo` | Will a public repository deploy? What it found, what's missing, and what it would cost on each cloud | Not needed |
| `plan_deploy` | The check, plus your connected accounts and projects, and the next step to take | Needed |
| `status` | Your projects, their live addresses and their latest deployment | Needed |
| `logs` | The latest deployment's log for a project, with secrets removed | Needed |
| `redeploy` | Pulls the latest code on a live project's branch and restarts it | Needed |
| `request_done_for_you` | Asks for a done-for-you Launch or Move; you finish the order in The Deployer | Needed |

To create a key, sign in to The Deployer, open **Profile**, and use **API keys and AI coding tools**. The
page also shows these setups with your key filled in.

## Setup

The hosted server needs nothing installed. Replace `dpl_your_key` with your key.

Keep the key out of files you commit. Put it in your user-level settings, or have your tool read it from
an environment variable or a prompt, as shown below for project files.

**Claude Code**, for all your projects (stored in `~/.claude.json`):

```sh
claude mcp add --transport http --scope user thedeployer https://app.thedploy.com/api/v1/mcp --header "Authorization: Bearer dpl_your_key"
```

To share the server in a project's `.mcp.json`, use `"Authorization": "Bearer ${THEDEPLOYER_API_KEY}"` as
the header. Claude Code fills it in from each person's `THEDEPLOYER_API_KEY` environment variable.

**Cursor**, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "thedeployer": {
      "url": "https://app.thedploy.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer dpl_your_key" }
    }
  }
}
```

In a project's `.cursor/mcp.json`, use `"Authorization": "Bearer ${env:THEDEPLOYER_API_KEY}"` instead, so
Cursor reads the key from your environment.

**VS Code**, in `.vscode/mcp.json`. VS Code asks for the key the first time and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "thedeployer-key", "description": "The Deployer API key", "password": true }
  ],
  "servers": {
    "thedeployer": {
      "type": "http",
      "url": "https://app.thedploy.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${input:thedeployer-key}" }
    }
  }
}
```

The same works in your user configuration (run **MCP: Open User Configuration**).

**Gemini CLI**, in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "thedeployer": {
      "httpUrl": "https://app.thedploy.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer dpl_your_key" }
    }
  }
}
```

**Tools that start a local command** (Cline, Windsurf and others) use this package, which needs Node.js 18
or newer. Add it to the tool's user-level MCP settings:

```json
{
  "mcpServers": {
    "thedeployer": {
      "command": "npx",
      "args": ["-y", "thedeployer-mcp"],
      "env": { "THEDEPLOYER_API_KEY": "dpl_your_key" }
    }
  }
}
```

If your tool's configuration looks different, its MCP documentation has the equivalent fields: a URL
with an `Authorization` header, or a command with an environment variable.

## Proxies and company networks

With the hosted server, your AI tool makes the connection, so its own proxy settings apply.

This package uses Node.js, which ignores `HTTPS_PROXY` unless you turn that on. Add `NODE_USE_ENV_PROXY`
next to it, which needs Node.js 22.21 or newer, or 24.0 or newer. (The `--use-env-proxy` flag does the
same from Node.js 22.21 or 24.5.) On older versions, this package can't go through a proxy.

If your network inspects HTTPS with its own certificate, set `NODE_EXTRA_CA_CERTS` to that certificate's
file (PEM):

```json
"env": {
  "THEDEPLOYER_API_KEY": "dpl_your_key",
  "HTTPS_PROXY": "http://proxy.example.com:8080",
  "NODE_USE_ENV_PROXY": "1",
  "NODE_EXTRA_CA_CERTS": "/path/to/company-ca.pem"
}
```

## What a key can and can't do

A key works only with The Deployer's MCP server, and only through its tools: `check_repo`,
`plan_deploy`, `status`, `logs` (with secrets removed), `redeploy` and `request_done_for_you`. It can't
touch your cloud or git credentials, your environment variables, your billing or your account settings, and
it can't create more keys. The Deployer stores only a hash of it. Revoke a key on the Profile page at any
time; use one key per tool or machine, so you can revoke one without touching the rest. Changing or
resetting your password revokes all your keys.

`redeploy` changes a live app. Keep your tool asking you before it runs `redeploy`, rather than approving
it automatically.

Tool answers come from your repositories and deployments. Treat them like any other text your agent reads.

## How this package works

`index.mjs` is a bridge with no dependencies. It reads MCP messages from stdin, sends each one to The
Deployer's hosted endpoint over HTTPS with your key, and writes the answers to stdout. The tools run on The
Deployer, so this package doesn't change when they do.

Every request gets an answer. When The Deployer refuses one or can't be reached, the answer is an error
that says why, such as a revoked key or a timeout. The bridge never follows redirects, and it never puts
your key anywhere but the `Authorization` header.

| Variable | Meaning |
|---|---|
| `THEDEPLOYER_API_KEY` | Your personal API key. Without it, only `check_repo` works |
| `THEDEPLOYER_MCP_URL` | The endpoint, if not `https://app.thedploy.com/api/v1/mcp`. It must use `https://`, except on this computer (`127.0.0.1`, `::1` or `localhost`) |
| `THEDEPLOYER_TIMEOUT_MS` | How long to wait for one answer, in milliseconds, from 1000 to 600000 (default 120000) |

```sh
npm test
```

## License

MIT
