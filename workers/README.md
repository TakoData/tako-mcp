# tako-mcp workers

[![workers-ci](https://github.com/TakoData/tako-mcp/actions/workflows/workers-ci.yml/badge.svg?branch=main&event=push)](https://github.com/TakoData/tako-mcp/actions/workflows/workers-ci.yml?query=branch%3Amain+event%3Apush)

This subdirectory hosts the TypeScript Cloudflare Workers port of the Tako MCP server, tracked under the [tako-mcp Linear project](https://linear.app/trytako/project/tako-mcp-635ac07fae22).

## Local dev

Node version is pinned via `.nvmrc` (`nvm use` to match CI).

```sh
nvm use
npm ci
npm test
npm run typecheck
npm run dev
```
