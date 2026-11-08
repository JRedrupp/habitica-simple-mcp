# habitica-simple-mcp

**Use Habitica from Claude on your phone. No local install, deploys in about 2 minutes.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JRedrupp/habitica-simple-mcp)

[![CI](https://github.com/JRedrupp/habitica-simple-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/JRedrupp/habitica-simple-mcp/actions/workflows/ci.yml)

A single-file [MCP](https://modelcontextprotocol.io) server for [Habitica](https://habitica.com), written as a dependency-free Cloudflare Worker. Everything lives in [`worker.js`](worker.js): paste it into the Cloudflare dashboard and you have a remote MCP server for Claude (or any MCP client that supports remote HTTP servers).

## Tools

| Tool                                    | Description                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `get_stats`                             | Player stats (HP, MP, XP, gold, level, class)                                      |
| `get_today`                             | One-call overview: dailies due, overdue and soon-due to-dos, HP and damage status. |
| `list_tasks`                            | List habits, dailies, to-dos and rewards                                           |
| `get_task`                              | Fetch one task                                                                     |
| `get_task_history`                      | Score history of a habit or daily                                                  |
| `create_task`                           | Create a habit, daily, to-do or reward                                             |
| `create_tasks`                          | Create up to 50 tasks in one call                                                  |
| `find_task`                             | Find tasks by title, notes or checklist                                            |
| `update_task`                           | Edit a task; replace or reorder its checklist                                      |
| `score_task`                            | Complete / score a task (up or down)                                               |
| `move_task`                             | Reorder a task                                                                     |
| `delete_task`                           | Delete a task                                                                      |
| `checklist_item`                        | Add, edit or remove checklist items                                                |
| `score_checklist_item`                  | Tick a checklist item                                                              |
| `list_tags` / `create_tag` / `tag_task` | Manage tags                                                                        |
| `set_sleep`                             | Pause or resume damage (inn)                                                       |
| `buy_health_potion`                     | Buy a health potion                                                                |
| `cast_spell`                            | Cast a class skill                                                                 |

Task responses are slimmed down to the useful fields, since the raw Habitica task object is very large.

## Setup

1. Click the **Deploy to Cloudflare** button above (it will ask for the three secrets in step 2), or in the Cloudflare dashboard go to **Workers & Pages → Create → Create Worker**, then **Edit code** and paste in the contents of `worker.js`. Deploy.
2. Under **Settings → Variables and Secrets** add three secrets:

   | Name                 | Value                                                                      |
   | -------------------- | -------------------------------------------------------------------------- |
   | `HABITICA_USER_ID`   | Your User ID from Habitica → Settings → Site Data → API                    |
   | `HABITICA_API_TOKEN` | Your API token from the same page                                          |
   | `MCP_SECRET`         | A long random string (at least 24 characters), e.g. `openssl rand -hex 24` |

   Optionally set `HABITICA_API_BASE` to point at a different Habitica API (defaults to `https://habitica.com/api/v3`).

   Temporary Habitica errors are retried inside the server (up to 3 times with backoff). `429` is always retried and honors `Retry-After`; `5xx` and network errors are retried for everything except `POST`, to avoid double-scoring or duplicate creates. `HABITICA_RETRY_BASE_MS` (default `500`) sets the base delay.

   Habitica API reference: [habitica.com/apidoc](https://habitica.com/apidoc/) (source of the doc blocks: [`tasks.js`](https://github.com/HabitRPG/habitica/blob/develop/website/server/controllers/api-v3/tasks.js)).

3. Your MCP endpoint is:

   ```
   https://<worker>.<subdomain>.workers.dev/mcp/<MCP_SECRET>
   ```

4. Add it to your client as a remote MCP server. With Claude Code:

   ```
   claude mcp add --transport http habitica https://<worker>.<subdomain>.workers.dev/mcp/<MCP_SECRET>
   ```

   In Claude.ai, add it as a custom connector using the same URL.

Prefer the CLI? `npx wrangler deploy` works too, using the included `wrangler.toml`, with `npx wrangler secret put <NAME>` for each secret.

## Security

- The secret in the URL is the only authentication, so treat the full URL like a password. Anyone with it can act on your Habitica account.
- Requests with a wrong or missing secret get a `404`, and secrets shorter than 24 characters are rejected outright.
- The server is stateless and only accepts `POST` (MCP streamable HTTP, JSON mode).

## Local testing

```sh
npx wrangler dev
curl -s localhost:8787/mcp/$MCP_SECRET \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Put the three variables in a `.dev.vars` file (git-ignored) for local runs.

## Development

```sh
npm install
npm test            # node:test suite, Habitica is mocked
npm run format      # prettier
npm run check       # syntax check
```

CI runs formatting, the syntax check and the tests on Node 20 and 22.

## License

[MIT](LICENSE)
