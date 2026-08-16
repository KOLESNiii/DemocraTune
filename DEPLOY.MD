# DemocraTune deployment

This is the production runbook for the main DemocraTune application:

- Next.js frontend on Vercel;
- the Python YouTube Music adapter in `api/index.py`, deployed by Vercel on the
  same origin;
- Convex functions, data, authentication, and scheduled jobs.

The recommendation and audio-extraction stack is independent. Its runbook is
[`deployed-backend/DEPLOY.MD`](deployed-backend/DEPLOY.MD).

## Production topology

```text
Browser
  |
  +-- Vercel: Next.js frontend and /api/search Python function
  |
  +-- Convex: rooms, queue, votes, playback, auth, crons
        |
        +-- Recommendation backend: jobs and candidates
        +-- Vercel /api/search: playable YouTube resolution
```

The browser and Python search function share an origin, so no CORS
configuration is required. Production must not rewrite `/api/*` to another
host; `next.config.ts` only adds that rewrite during local development.

## Prerequisites

- A Convex account and project.
- A Vercel account and project connected to this repository.
- Node.js 22 and Bun 1.2.19 for local verification.
- A production domain, if the generated `vercel.app` domain is not sufficient.
- Optional: Spotify and PostHog projects for their corresponding features.

Do not commit `.env.local`, deploy keys, YouTube Music headers, JWT keys, or
other credentials. The repository ignores `.env*` files.

## 1. Prepare Convex

For a new project, authenticate and create/select the development and
production deployments:

```bash
bunx convex dev
```

The app uses Convex Auth with anonymous identities. On the first production
setup, generate its `JWT_PRIVATE_KEY` and `JWKS` in the production Convex
deployment:

```bash
bunx @convex-dev/auth --prod
```

Those two values belong to the Convex deployment, not Vercel. Do not copy them
into `NEXT_PUBLIC_*` variables.

Configure the server-only application endpoints in each Convex deployment that
should run AutoDJ:

| Variable                   | Required value                                                                   |
| -------------------------- | -------------------------------------------------------------------------------- |
| `FASTAPI_BASE_URL`         | The Vercel app's HTTPS origin, used to resolve candidates through `/api/search`. |
| `RECOMMENDATION_API_URL`   | The public HTTPS origin from `deployed-backend/DEPLOY.MD`.                       |
| `RECOMMENDATION_API_TOKEN` | Exactly the backend's `APP_API_TOKEN`; mark it sensitive.                        |

Set these in the Convex dashboard's environment-variable settings. They are
read only by Convex actions and must never use a `NEXT_PUBLIC_` prefix. If the
recommendation variables are absent, AutoDJ network work is disabled and the
normal user/fallback queues continue to operate.

Create a production deploy key in the Convex dashboard under the production
deployment's settings. Give it the `deployment:deploy` permission and store it
as the sensitive Vercel environment variable `CONVEX_DEPLOY_KEY`, scoped only
to Production.

The equivalent authenticated CLI operation is:

```bash
bunx convex deployment token create vercel-production --deployment prod
```

The command prints a secret. Put it directly into Vercel and do not save it in
the repository or shell history. Revoke the old key in Convex after rotating
it.

## 2. Configure Vercel

Import the repository as one Vercel project with these settings:

| Setting          | Value                           |
| ---------------- | ------------------------------- |
| Root directory   | Repository root                 |
| Framework        | Next.js                         |
| Node.js          | 22.x                            |
| Install command  | `bun install --frozen-lockfile` |
| Build command    | `bun run vercel-build`          |
| Output directory | Next.js default (`.next`)       |

`vercel-build` deliberately behaves differently by environment:

- Production runs `bunx convex deploy --cmd 'bun run build'`, deploying the
  Convex functions and building the web app against that production URL.
- Preview runs `bun run build` and does not mutate production Convex.

Configure these variables in Vercel Project Settings:

| Variable                        | Scope                 | Required                 | Purpose                                                                                                   |
| ------------------------------- | --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `CONVEX_DEPLOY_KEY`             | Production, sensitive | Yes                      | Allows the production build to deploy Convex functions.                                                   |
| `NEXT_PUBLIC_SITE_URL`          | Production            | Yes                      | Canonical HTTPS origin, without a trailing slash.                                                         |
| `NEXT_PUBLIC_CONVEX_URL`        | Preview/Development   | Yes for previews/dev     | Convex deployment that non-production clients may use. Production receives its URL from `convex deploy`.  |
| `YTMUSIC_HEADERS_JSON`          | Production, sensitive | Only for playlist writes | Authenticated YouTube Music account headers used by server-side playlist routes. Search does not need it. |
| `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | Production/Preview    | Optional                 | Enables client-side Spotify playlist export. There is no Spotify client secret.                           |
| `NEXT_PUBLIC_POSTHOG_KEY`       | Production/Preview    | Optional                 | Enables PostHog analytics.                                                                                |
| `NEXT_PUBLIC_POSTHOG_HOST`      | Production/Preview    | Optional                 | PostHog ingest host used by the client.                                                                   |

Do not configure `CONVEX_DEPLOYMENT`, `JWT_PRIVATE_KEY`, `JWKS`, or
`NEXT_PUBLIC_FASTAPI_URL` in Vercel production:

- `CONVEX_DEPLOYMENT` selects a local development deployment.
- the JWT variables belong in Convex deployment settings;
- `NEXT_PUBLIC_FASTAPI_URL` is only used by the local Next.js rewrite.

Vercel environment-variable changes affect only new deployments, so redeploy
after adding or rotating a value.

### Preview data

The current build script does not create an isolated Convex backend for each
preview. Set Preview's `NEXT_PUBLIC_CONVEX_URL` to a non-production deployment
whose data may safely be used by previews. Never point untrusted preview code
at production data. If isolated branch deployments are added later, use a
Convex preview deploy key and update `vercel-build` deliberately.

## 3. Configure domains and optional providers

Add the production domain in Vercel Project Settings, then set
`NEXT_PUBLIC_SITE_URL` to its complete HTTPS origin, for example:

```text
https://democratune.example.com
```

If Spotify export is enabled, register every permitted deployment origin in
the Spotify application with this exact callback path:

```text
https://democratune.example.com/spotify/callback
```

Spotify's flow uses Authorization Code with PKCE in the browser; no Spotify
client secret is deployed.

## 4. Verify before deployment

Pull Vercel's Development variables when local verification needs them:

```bash
bunx vercel link
bunx vercel env pull .env.local
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

The production build additionally validates and deploys Convex through
`CONVEX_DEPLOY_KEY`.

## 5. Deploy

With Vercel Git integration:

- pushes to non-production branches create Preview deployments;
- merging or pushing to the configured production branch creates a Production
  deployment.

For a manual preview and production deployment:

```bash
bunx vercel deploy
bunx vercel deploy --prod
```

The production command invokes `bun run vercel-build`, so it also deploys the
Convex functions.

## 6. Post-deployment checks

Check the deployment before announcing it:

1. Load `/` and create a room.
2. Join the room from a second browser/private session.
3. Search with at least three characters and confirm results appear.
4. Select a song and confirm the playability check and queue mutation succeed.
5. Vote and advance playback once to exercise Convex mutations.
6. If configured, complete one Spotify export through `/spotify/callback`.
7. Inspect Vercel Function logs for the Python `/api/*` routes.
8. Inspect the Convex production deployment for function errors and cron
   failures.

Useful Vercel commands:

```bash
bunx vercel ls
bunx vercel inspect <deployment-url>
bunx vercel logs <deployment-url>
```

## Rollback

A Vercel rollback only repoints the web and Python deployment. It does not
restore older Convex functions or data. If a release changed Convex APIs,
redeploy a known-good repository commit so that the Convex functions and web
bundle are compatible again.

Prefer additive Convex schema/function changes across releases. This reduces
the period in which a failed web build or a Vercel-only rollback could leave a
new Convex backend serving an older frontend.

```bash
bunx vercel rollback
```

Use that command by itself only when the release did not require a Convex
rollback. Data recovery should be handled separately through Convex's
production dashboard and backup/export facilities.

## References

- [Convex deployment with Vercel](https://docs.convex.dev/production/hosting/vercel)
- [Convex deploy keys](https://docs.convex.dev/cli/deploy-key-types)
- [Convex environment variables](https://docs.convex.dev/production/environment-variables)
- [Vercel CLI deployment](https://vercel.com/docs/projects/deploy-from-cli)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
