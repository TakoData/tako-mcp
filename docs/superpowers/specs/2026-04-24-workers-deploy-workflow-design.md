# Workers Deploy Workflow — Design

**Ticket:** [TAKO-2601](https://linear.app/trytako/issue/TAKO-2601/deploy-workflow-github-actions-to-cloudflare-workers)
**Date:** 2026-04-24
**Status:** Approved, ready for implementation plan

## Goal

Automate `wrangler deploy` for the `workers/` Cloudflare Worker so that:

- Merges to `main` touching `workers/**` deploy staging automatically.
- Manual `workflow_dispatch` can target either `staging` or `production`.

## Scope

One new file: `.github/workflows/workers-deploy.yml`. No other files change. The existing `.github/workflows/workers-ci.yml` (dry-run validation on PRs) is untouched.

## Design

### Triggers

| Event | Behavior |
|---|---|
| `push` to `main`, `paths: ['workers/**']` | Deploys `staging` |
| `workflow_dispatch` with `inputs.environment` in `[staging, production]` (default `staging`) | Deploys the chosen env |

### Env resolution

The target env is resolved once via the expression `github.event.inputs.environment || 'staging'` and threaded through three places:

1. `concurrency.group: workers-deploy-<env>` — per-env queue so two staging deploys don't race.
2. Job-level `environment: <env>` — enables GitHub Environments deployment tracking (URL + history in the Actions UI).
3. The `wrangler deploy --env <env>` command itself.

No matrix, no separate jobs. Single source of truth.

### Concurrency

- **Group:** `workers-deploy-<env>` (per-env).
- **`cancel-in-progress: false`** — deploys must not be cut off mid-upload. This intentionally differs from `workers-ci.yml`, which cancels in-flight CI runs per-ref.

### Permissions

`contents: read` only. No write permissions needed — the workflow neither pushes code nor creates releases.

### Steps

```
checkout → setup-node (from workers/.nvmrc) → npm ci → npm run typecheck
         → npm test → npm run registry:check → cloudflare/wrangler-action@v3
```

`npm ci` uses the lockfile cache that `actions/setup-node` warms via `cache: 'npm'` + `cache-dependency-path: workers/package-lock.json`.

`wrangler-action@v3` handles auth by reading `apiToken` and `accountId` inputs and passing them to wrangler as env vars. The action masks the token in logs. We never `echo` or `set -x` the secrets.

### GitHub Environments

Both `staging` and `production` are declared via `environment:` on the job. **No protection rules** (per design decision in TAKO-2601 AskUserQuestion). The manual-dispatch gate is the only approval step for production.

## Secrets

Two repo-level GitHub Actions secrets, provided by Bobby:

- `CLOUDFLARE_API_TOKEN` — Workers:Edit scope, masked automatically by Actions.
- `CLOUDFLARE_ACCOUNT_ID` — non-sensitive but kept as a secret for operational hygiene.

Until both are present, deploys fail at the wrangler-action step. CI is unaffected because CI only dry-runs.

## Dependencies and merge order

- `npm run registry:check` is introduced by PR #44 (TAKO-2600, still open). This PR **must merge after #44**. If it lands first, the first push-to-main deploy fails on an unknown npm script.
- The Tako MCP Phase-2 stack merge order is: #44 → #45 → this PR → main.

## Out of scope

- Custom domains (`mcp.staging.tako.com`, `mcp.tako.com`) — TAKO-2610.
- Smoke tests after deploy — TAKO-MCP-15.
- Python Docker / pip publish — untouched.
- A `ref == main` guard on `workflow_dispatch` to block production deploys from feature branches. Operational guidance for now: "dispatch from main only." File a follow-up if the team wants it enforced.

## Acceptance criteria (from ticket)

1. Merge to `main` touching `workers/**` deploys staging automatically.
2. Manual dispatch with `environment=production` deploys to prod.
3. Failing tests/typecheck/registry-check block the deploy.
4. No secrets visible in workflow logs.
5. Staging Worker reachable on its `workers.dev` subdomain after first deploy (default behavior; `wrangler.jsonc` does not set `workers_dev = false`).

## Final YAML

```yaml
name: workers-deploy

on:
  push:
    branches: [main]
    paths: ['workers/**']
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        type: choice
        options: [staging, production]
        default: staging

concurrency:
  group: workers-deploy-${{ github.event.inputs.environment || 'staging' }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    name: deploy (${{ github.event.inputs.environment || 'staging' }})
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.environment || 'staging' }}
    defaults:
      run:
        working-directory: workers
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: workers/.nvmrc
          cache: 'npm'
          cache-dependency-path: workers/package-lock.json

      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run registry:check

      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers
          command: deploy --env ${{ github.event.inputs.environment || 'staging' }}
          packageManager: npm
```
