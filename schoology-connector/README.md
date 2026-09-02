# Personal Schoology connector — read-only pilot

This service lets ChatGPT read selected Schoology classes through the same
OAuth 1.0 API authentication used by Khan Grader. ChatGPT authenticates to this
service separately, using OAuth authorization code + PKCE and a new connector
password. Google browser sign-in is not needed for Schoology API calls.

The code is prepared and tested with simulated Schoology responses. It has not
been deployed, connected to ChatGPT, or tested with real Schoology credentials.
No live student data or credentials are included in this repository.

## What is ready

- `check_connection`: verify teacher identity and configured class IDs.
- `list_classes`: read only the configured Schoology sections.
- `get_roster`: read active students and enrollment IDs, with pagination.
- `list_assignments`: read assignment IDs, titles, due dates, and maximum points.
- `get_assignment_grades`: read saved grades for one specified assignment.

There are no grade-write or assignment-create tools in this pilot. The next
stage is to verify the live class/assignment/student mapping, then add a separate
reviewed grade-write operation with read-back verification. This is not yet the
complete weekly Khan-to-Schoology automation.

## Hosting requirements

Use a single Node.js 24 process or the included Docker image, behind HTTPS.
This package has no third-party npm dependencies. A normal Docker web service
such as Render can run it. It is not a Vercel serverless-function package.

Keep one running instance. The SQLite auth database stores client registrations,
hashed access/refresh tokens, and short-lived authorization transactions, not
student records. Use a private persistent disk if connections must survive
redeploys. Without persistent storage, a restart may require deleting/recreating
the ChatGPT connection. Do not mount the database into any public static folder.

Hosting plan, uptime, and persistent-disk charges must be selected and reviewed
in the hosting dashboard. No paid plan is selected by this code.

## Deploy from this repository

1. In your chosen host, create a Docker web service from `humby2525/Khan-Grader`.
2. Select the branch containing this folder. Set the service root directory to
   `schoology-connector`, Dockerfile to `Dockerfile`, and health check to `/health`.
3. Set the private environment variables below in the hosting dashboard.
   The service deliberately refuses to start until the required settings exist.
4. Set `PUBLIC_ORIGIN` to the host's assigned HTTPS origin (no trailing slash).
5. Deploy and check `/health`: it should return `status: ok`, `mode: read_only`.

| Setting | Value you supply privately |
| --- | --- |
| `PUBLIC_ORIGIN` | The exact HTTPS origin assigned by your host |
| `SCHOOLOGY_CONSUMER_KEY` | Existing key from Khan Grader Setup → Schoology Connection |
| `SCHOOLOGY_CONSUMER_SECRET` | Existing secret from the same setup panel |
| `SCHOOLOGY_SECTION_IDS` | Comma-separated Schoology **section IDs** from Setup → Classes, initially just class 806 |
| `CONNECTOR_PASSWORD` | A new random password of at least 24 characters from your password manager |
| `AUTH_DB_PATH` | Default `./private/auth.sqlite`; Docker default `/app/private/auth.sqlite` |
| `PORT` | Set by the host; otherwise defaults to `3000` |

Never paste the key, secret, connector password, or OAuth tokens into chat,
source files, screenshots, logs, or GitHub. The connector password is separate
from your Schoology and Google passwords. It is entered only on the connector's
HTTPS consent page, in your normal browser, when connecting ChatGPT.

For a Docker host, publish the container's listening port and terminate TLS at
the host. A reverse proxy must preserve the `Origin`, `Cookie`, and
`Authorization` headers. Do not enable logging of request/response bodies or
authorization URLs. Student names and assignment titles are returned to
ChatGPT to fulfill the requested task; the service does not cache them.

## Connect in ChatGPT

1. Enable Developer mode in ChatGPT Settings → Security and login.
2. Open Plugins, select the plus button, and create a connection.
3. Name: **My Schoology**.
4. Description: **Read selected classes, rosters, assignments, and grades.**
5. MCP server URL: your deployed `PUBLIC_ORIGIN` followed by `/mcp`.
6. Use OAuth with dynamic client registration. Leave OAuth client ID and secret
   empty if optional: this server registers ChatGPT dynamically. Do not put
   Schoology's consumer key/secret into ChatGPT's OAuth-client fields.
7. Complete authorization in the page ChatGPT opens. Check that the address is
   your deployed host, then enter your separate connector password and approve
   read-only access.
8. Start a new chat with the connector enabled. Ask it to check the connection,
   list the allowed class, read its roster, and find the weekly Khan assignment.

The server supports the official ChatGPT stable callback
`https://chatgpt.com/connector_platform_oauth_redirect` and callback-specific
`https://chatgpt.com/connector/oauth/{callback_id}` URLs. Other callback hosts
are rejected. If the setup page shows a different callback or requires manual
client credentials, stop and inspect that setup before changing authentication.

## Pilot to resume

The live Khan portion was checked on September 2, 2026. The target was class
806, date range August 31–September 2 (week to date). Re-read Khan for fresh
numbers before any eventual grade transfer. Read the Schoology roster and
assignment, verify student matches, and use the grading measure and goal from
the user's existing configuration. A partial week's totals are not final grades.
Do not guess matches from shortened names or convert missing data into zeroes.

## Security and operation

- Credentials stay in the hosting environment and are sent only in signed
  requests to `https://api.schoology.com`.
- Only numeric, explicitly allowed class IDs can be requested.
- Schoology requests are GET-only; upstream response bodies are never echoed
  in errors. Response fields are reduced to the data needed for grading review.
- OAuth uses S256 PKCE, exact resource binding, exact registered redirect URIs,
  browser-bound consent transactions, single-use codes, expiring opaque bearer
  tokens, rotating refresh tokens, family revocation, and basic rate limits.
- Access tokens expire after one hour; refresh tokens after 14 days. The host
  should protect the database and environment settings from other users.
- Disconnecting in ChatGPT removes its access. To force-revoke all connections,
  stop the service and remove its auth database, then reconnect. Changing only
  the connector password does not revoke already-issued tokens.
- MCP is stateless Streamable HTTP with JSON responses at `/mcp`. It supports
  protocol versions 2025-03-26, 2025-06-18, and 2025-11-25. GET/SSE streams and
  server-initiated requests are not used.
- This is a personal, single-owner pilot, not a multi-tenant or publicly listed
  integration. Live compatibility and authentication still require verification.

## Tests

From this folder, run `node --test test/*.test.mjs` with Node 24. The suite covers
the OAuth flow over HTTP, PKCE/code replay, CSRF protections, redirect validation,
refresh replay/revocation, token expiry, rate limits, MCP initialization/tool
calls, allowed-class enforcement, pagination boundaries, read-only behavior,
and exclusion of unnecessary private fields. Tests use synthetic names and
fake credentials; no Schoology account is accessed.

## Sources and code provenance

- Schoology request signing is adapted from this repository's
  `src/background.js`; roster field selection follows `src/dashboard/dashboard.js`.
- [Schoology authentication](https://developers.schoology.com/api-documentation/authentication/)
- [Schoology grade API](https://developers.schoology.com/api-documentation/rest-api-v1/grade/)
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Connect an MCP server to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)

The MCP transport and OAuth implementation use Node built-ins and a private
SQLite store. The package uses no model API and needs no OpenAI API key.
