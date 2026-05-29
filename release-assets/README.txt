Forge.ai — coding agent that runs locally
==========================================

What this is
------------
A single executable that runs an agent loop on YOUR machine: it can read
your files, run shell commands, edit code, and call out to your chosen
LLM provider (Anthropic / OpenAI / DeepSeek / etc). The UI is bundled
inside the binary — no separate install.


First-time setup (~2 min)
-------------------------

macOS users — bypass Gatekeeper (the binary is not yet signed):

   Option A (one-click):
       Right-click `forge` in Finder → Open → confirm in the dialog.
       After this, you can run it normally from the terminal.

   Option B (terminal):
       xattr -d com.apple.quarantine ./forge

Linux users — just `chmod +x ./forge`.

Then:

   ./forge --open

You'll see something like:

   Forge.ai is ready → http://localhost:8787
   Open this URL in your browser. Press Ctrl-C to stop.

`--open` launches your default browser automatically. Without it, click
the URL yourself.


In the browser
--------------

1. Click the gear icon (bottom-left) → Settings:
   - Models: paste your API key for whichever provider you'll use
     (OpenAI, Anthropic, DeepSeek, etc). Pick a model id.
   - (optional) Skills: install a skill from the store.
   - (optional) MCP: add MCP servers if you have any.

2. Pick a workspace — top-left folder button — point it at the
   project you want the agent to work on.

3. Start chatting. Default permission mode is `prompt`, meaning every
   tool call surfaces a confirmation. Switch to `workspace-write` or
   `danger-full-access` from the MODE badge once you trust the setup.


Flags
-----
    forge --help              # show all flags
    forge --open              # auto-open browser
    forge --port 0            # auto-pick a free port
    forge --port 4000         # bind to a specific port
    forge --host 0.0.0.0      # expose on LAN (NOT recommended)


Where state lives
-----------------
    ~/.claw/state.json        Persisted config: model, providers, MCPs
    ~/.claw/libraries/        RAG library sqlite stores
    ~/.claw/skills/           User-level skills
    ~/.claude/skills/         (Also scanned — that's where `npx skills`
                              installs by default)


Updating
--------
This is an early build. To update, download the new archive and replace
the `forge` binary. State files above are kept.


Stopping
--------
Press Ctrl-C in the terminal. Sessions are in-memory and will be lost;
config / providers / MCPs persist.


Issues
------
Open one at https://github.com/Trynewthings/forge-AI/issues
