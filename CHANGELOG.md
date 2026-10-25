# Changelog

## 0.2.0 (2026-10-25)

- The hosted server now lets an agent take a project from code to live and run it: `guide` (The Deployer's
  playbooks for agents), `account`, `project` (one project in depth, with the exact next step),
  `create_project`, `set_env` (values go in and never come back), `launch` (shows the plan and its cost,
  launches only with `confirm`), `deployment` (progress, and for a failed one what to fix), `diagnose`
  (read-only checks on a live server), and `api_catalog`, `api_schema` and `api` for everything else:
  domains, scaling, schedules, databases, access, environments, blueprints, servers and adoption.
- Changes need a key made with **Operate** access. Keys made before keep exactly what they could do.
- Prompts (`deploy_this_repo`, `fix_my_deployment`, `make_it_deployable`) and the playbooks as resources.
- The bridge waits up to 200 seconds for an answer by default (was 120): proposing hosting plans can take a while.

## 0.1.1 (2026-09-14)

- Every request gets an answer. A refused key, a reply that isn't JSON-RPC, a timeout or a connection
  failure comes back as an error for that request, in the server's own words when it sent some, instead of
  leaving your editor waiting.
- The key is checked when the bridge starts and is never repeated in messages or logs. Error text names only
  the endpoint's origin.
- `THEDEPLOYER_MCP_URL` must use `https://` (plain `http://` only for this computer), can't contain a user
  name or password, and redirects aren't followed.
- A line that isn't a message no longer stops the bridge, a failed `initialize` no longer silences the
  session, and `notifications/cancelled` stops the request it names.
- Large answers arrive in full before the process exits.
- `THEDEPLOYER_TIMEOUT_MS` must be a whole number from 1000 to 600000.
- The README shows how to keep your key out of files you commit, and how to work through a proxy or a
  company certificate.

## 0.1.0 (2026-09-14)

- First release: a stdio bridge to The Deployer's hosted MCP server, with `check_repo`, `plan_deploy`,
  `status`, `logs`, `redeploy` and `request_done_for_you`.
