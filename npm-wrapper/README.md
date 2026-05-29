# Forge.ai

Local coding agent. Reads your files, runs shell commands, edits code,
talks to your chosen LLM. Runs entirely on your machine — your code
never leaves it.

## Install & run

```bash
npx @forge-ai/forge --open
```

That's it. First run downloads the matching binary (~20 MB) into
`~/.forgeai/binaries/`, then launches the server and opens
`http://localhost:8787` in your browser.

Subsequent runs skip the download.

Or install globally so you can just type `forge-ai`:

```bash
npm i -g @forge-ai/forge
forge-ai --open
```

(The CLI command is `forge-ai` — not plain `forge` — to avoid the
common collision with Foundry's `forge` Ethereum dev tool.)

## What you'll see

```
Forge.ai is ready → http://localhost:8787
Open this URL in your browser. Press Ctrl-C to stop.
```

In the browser:

1. Click the gear icon (bottom-left) → **Settings**
2. Under **Models**, paste an API key for any provider
   (Anthropic / OpenAI / DeepSeek / xAI / etc.)
3. Top-left folder button → point at the project you want the agent
   to work on
4. Type a prompt, hit Enter

Default permission mode is `prompt` — every tool call surfaces a
confirmation. Change it from the **MODE** badge in the input area
once you trust the setup.

## Flags

```
forge-ai --help              # show all flags
forge-ai --open              # auto-open browser
forge-ai --port 0            # auto-pick a free port
forge-ai --port 4000         # bind to a specific port
forge-ai --host 0.0.0.0      # expose on LAN (NOT recommended)
```

## State

- `~/.claw/state.json` — config, providers, MCPs (persists across runs)
- `~/.claw/libraries/` — RAG library sqlite stores
- `~/.claw/skills/` — user-level skills
- `~/.forgeai/binaries/v<version>/` — downloaded binary cache

## Updating

```bash
npx @forge-ai/forge@latest --open
```

To clear the cached binary for a version:

```bash
rm -rf ~/.forgeai/binaries/v0.1.0
```

## Supported platforms

- macOS arm64 (Apple silicon)
- macOS x86_64 (Intel)
- Linux x86_64

Other targets: open an issue.

## License

Apache-2.0
