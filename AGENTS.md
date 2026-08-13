# AGENTS.md

You are a TypeScript developer experienced with the Mastra framework. You build AI agents, tools, workflows, and scorers. You follow strict TypeScript practices and always consult up-to-date Mastra documentation before making changes.

## Project Overview

This is a **Mastra** project written in TypeScript. It serves the **Discador Wavoip** — a
PWA that lists qualified GHL leads and dials them from the browser via the Wavoip SDK. Mastra
is used only as the HTTP server (routes), not for AI agents. The Node.js runtime is `>=22.13.0`.

## Commands

```bash
npm run dev # Start the server at localhost:4111 (long-running, use a separate terminal)
npm run build # Build a production-ready server
```

## Project Structure

| File                          | Description                                                              |
| ----------------------------- | ------------------------------------------------------------------------ |
| `src/mastra/index.ts`         | Mastra server + discador routes (static PWA + API).                      |
| `src/mastra/discador-pwa.ts`  | PWA frontend (HTML/JS/manifest/service worker/icon) as strings.         |
| `src/mastra/discador-auth.ts` | Closer login + HMAC session token.                                       |
| `src/mastra/ghl.ts`           | `buscarQualificados` — reads the qualified-leads list from GHL.          |
| `src/mastra/config.ts`        | Central config (GHL + Wavoip token).                                     |
| `src/mastra/http.ts`          | `fetchTimeout` (fetch with AbortController).                             |

### Top-level files

Top-level files define how your Mastra project is configured, built, and connected to its environment.

| File                  | Description                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/mastra/index.ts` | Central entry point where you configure and initialize Mastra.                                                    |
| `.env.example`        | Template for environment variables - copy and rename to `.env` to add your secret [model provider](/models) keys. |
| `package.json`        | Defines project metadata, dependencies, and available npm scripts.                                                |
| `tsconfig.json`       | Configures TypeScript options such as path aliases, compiler settings, and build output.                          |

## Boundaries

### Always do

- Load the `mastra` skill before any Mastra-related work
- Register new agents, tools, workflows, and scorers in `src/mastra/index.ts`
- Use schemas for tool inputs and outputs
- Run `npm run build` to verify changes compile

### Never do

- Never commit `.env` files or secrets
- Never modify `node_modules` or Mastra's database files directly
- Never hardcode API keys (always use environment variables)

## MCP Docs Server

This project has the Mastra MCP Docs Server configured for Cursor.

### Using MCP Docs

The MCP server provides embedded documentation access within your editor:

1. The server was automatically configured during project creation
2. Restart your editor to load the MCP server
3. Use the Mastra docs tools in your editor to access:
   - API references
   - Code examples
   - Integration guides

Learn more in the [MCP Documentation](https://mastra.ai/docs/mcp/overview).

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
