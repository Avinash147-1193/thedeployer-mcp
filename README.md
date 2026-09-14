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

**Claude Code**

```sh
claude mcp add --transport http thedeployer https://app.thedploy.com/api/v1/mcp --header "Authorization: Bearer dpl_your_key"
```

**Cursor**, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in one project):

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

**VS Code**, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "thedeployer": {
      "type": "http",
      "url": "https://app.thedploy.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer dpl_your_key" }
    }
  }
}
```

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

**Tools that start a local command** (Cline, Windsurf and others). This package; needs Node.js 18 or newer:

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

## What a key can and can't do

A key can check repositories, read your projects' status and deployment logs, and redeploy a live project.
It can't see or change your cloud or git credentials, your environment variables, your billing or your
account, and it can't create more keys. The Deployer stores only a hash of it. Revoke a key on the Profile
page at any time; use one key per tool or machine, so you can revoke one without touching the rest.

Tool answers come from your repositories and deployments. Treat them like any other text your agent reads.

## How this package works

`index.mjs` is a bridge with no dependencies. It reads MCP messages from stdin, sends each one to The
Deployer's hosted endpoint over HTTPS with your key, and writes the answers to stdout. The tools run on The
Deployer, so this package doesn't change when they do.

| Variable | Meaning |
|---|---|
| `THEDEPLOYER_API_KEY` | Your personal API key. Without it, only `check_repo` works |
| `THEDEPLOYER_MCP_URL` | The endpoint, if not `https://app.thedploy.com/api/v1/mcp` |
| `THEDEPLOYER_TIMEOUT_MS` | How long to wait for one answer, in milliseconds (default 120000) |

```sh
npm test
```

## License

MIT
