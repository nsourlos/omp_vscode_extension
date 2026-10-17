# OMP for VS Code (prototype)

Chat with [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) inside VS Code, with:

- **Command approval:** every shell command asks inside its own row in the chat (Allow once / Reject; omp's "always" answers aren't offered for commands, because they would cover every later command); afterwards the same row shows ✓ or ✗ and the output. Commands that look like they change files get a warning. For a command that only reads or navigates, **Always allow read-only commands** lets later read-only commands (`cd`, `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `git status/log/diff/show`, `echo`) run without asking in that chat; anything else, or any redirection to a file, still asks. A request to use the browser shows the code omp is about to run, open and in full, with the web addresses written in it listed above (the code may open other pages too, so check it).
- **Change review:** every file edit opens VS Code's diff view, split into small changes. Each change has **Accept** / **Reject** / **Reject with note…** buttons above it. Only accepted changes are saved, and omp is told exactly which ones you rejected. A note (what to do instead) reaches omp straight away, in the same turn, and omp acts on it.
- **Edit tool first:** omp is told to change files only with its edit tool, so every change goes through the review.
- **Chat names:** omp names chats only in its own terminal app, so after a reply the extension quietly asks it to (`/rename`), until the chat has a name (a chat that is only "hi" so far gets one after a later reply). The name shows on the tab and in the history list. An untitled old chat is named when you open it. omp uses its `smol` model role for this if one is set in `~/.omp/agent/config.yml`, else the main model.
- **Chat history:** omp saves every chat automatically. **OMP: Continue a Previous Chat…** (the history button in a chat tab's title bar) lists this folder's chats, newest first; picking one opens it in a tab with the conversation so far, and you carry on from there. A chat that is already open is brought forward instead.
- **MCP servers:** omp ignores its own MCP config when it runs inside an editor, so the extension reads `~/.omp/agent/mcp.json`, the project's `.omp/mcp.json` and the project's `.mcp.json` (Claude Code's file; `${VAR}` values are filled in from the environment) and gives those servers to omp when a chat starts. Web servers that need a sign-in (like Atlassian) use the one you made once in omp's terminal app (`omp`, then `/mcp reauth <name>`); omp keeps it and refreshes it, and the extension passes it along when a chat starts (a sign-in lasts for that chat; a new chat gets a fresh one). A server that still won't start is left out, with a warning in the chat that says how to sign in. Servers connect in the background, so their tools can take a few seconds to appear in a new chat. **OMP: Add MCP Server…** adds a server to omp's own config (for all your projects, or just this one), and **OMP: Open MCP Servers File…** opens that file; new chats pick the changes up. A server turned off with omp's `/mcp disable` stays off.
- **Trusted folders only:** omp runs commands, edits files and starts the project's MCP servers, so the extension stays off in VS Code's Restricted Mode (a folder you haven't marked as trusted).
- **Message queue:** a message sent while omp works waits above the input (✕ removes it). When the turn ends, the queued messages are sent together as the next message; a queued slash command (like `/compact`) is sent on its own. If you press **Stop**, or the turn fails or omp crashes, the queued messages go back into the input instead of being sent. A message you send after pressing Stop runs as soon as the stopped turn ends.
- **Context window:** the footer shows how full the context is. omp compacts the conversation by itself when it fills up (it doesn't tell the editor), so the chat notes when the context used drops sharply, and warns once when it passes 80% (type `/compact` to compact now).
- **Replies:** rendered as full markdown (tables, lists, links, code) and sanitised. Code blocks have a **Copy** button, each reply ends with the model and how long the turn took, and the ✎ on any of your messages puts it back in the input to edit and send again.
- **Activity line:** while omp works, a line above the input says what it is doing (thinking, running a tool, waiting for your answer or review) and for how long.

## How it works

The extension starts `omp acp` (omp's built-in editor mode, the Agent Client Protocol) in the background. omp sends approval requests and file writes to the extension instead of acting on its own. Nothing is written until you finish reviewing.

```
src/
  acp/rpc.ts              JSON-RPC over stdio
  omp/agent.ts            starts `omp acp`, session, prompts (no VS Code code)
  omp/policy.ts           prompt text, shell-command warnings, messages back to omp
  review/hunks.ts         split a change into hunks, rebuild from accepted hunks
  review/reviewManager.ts diff editor, Accept/Reject buttons, a review queue per session
  chatPanel.ts + media/   one session's chat tab
  sessions.ts             open sessions, sidebar launcher
  controller.ts           runs one session: connects omp, its chat tab and its reviews
```

## Install

Requirements: `omp` installed and logged in (run `omp` once in a terminal), Node 20+.

```sh
npm install
npm run package                                   # builds omp-vscode-0.1.0.vsix
code --install-extension omp-vscode-0.1.0.vsix --force
```

Reload VS Code. Click the **OMP** icon in the left activity bar: the chat opens as a tab next to your files, and the sidebar switches back to the Explorer. The buttons in the chat tab's title bar start a new session, move the chat into its own window, or show the log.

**Parallel sessions:** **New Session** opens another chat tab (**OMP 2**, **OMP 3**, …) with its own omp, running independently of the others. Each session has its own Stop button, cards and review queue, so one session's review never waits behind another's. When a session needs an answer or finishes while its tab is hidden, the tab gets an orange dot icon and a **●** in its title until you look at it. Closing a tab ends that session: its omp stops and its open reviews are cancelled. If two sessions change the same file, whichever review finishes second is not saved, and that omp is told to read the file again. **OMP: Open Chat** in the Command Palette does the same as the icon. After changing the code, run the last two commands again.

To work on the extension itself, open this folder and press **F5** to start a test window with the current code.

While reviewing: click **Accept** / **Reject** above each change, or put the cursor on a change and press **Alt+Y** / **Alt+N**. The buttons in the editor title accept all, reject all, reject all with a note, or submit (undecided changes count as accepted). The review finishes on its own once every change is decided.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `omp.path` | `omp` | Path to omp (falls back to `~/.bun/bin/omp`) |
| `omp.extraArgs` | `[]` | Extra flags for `omp acp`, e.g. `["--model", "opus"]` |
| `omp.preferEditTool` | `true` | Tell omp to change files only through its edit tool |
| `omp.autoApproveEditPrompts` | `true` | Skip omp's yes/no prompt for edits, since the diff review follows anyway |
| `omp.warnOnShellFileChanges` | `true` | Warn on shell commands that look like they change files |
| `omp.useMcpServers` | `true` | Give omp the MCP servers from its config files and the project's `.mcp.json` |
| `omp.soundOnFinish` | `true` | Play opencode's "task finished" sound when omp finishes a reply |

The extension also turns on `diffEditor.codeLens`, which VS Code hides by default; without it the per-change buttons don't show.

## Tests

- `npm test`: unit tests for hunk splitting, rebuilding, shell warnings and rejection messages, plus the chat page itself (cards, replay, streaming) in jsdom, a simulated browser.
- `npm run test:vscode`: opens a separate, throwaway VS Code with the extension, has omp make an edit, accepts the first change and rejects the rest, then checks the result (uses a few model tokens). Set `VSCODE_PATH` to an installed VS Code executable to skip downloading one.
- `npm run test:offline`: the same throwaway VS Code, but against a fake omp (`test/fixtures/fake-omp.mjs`) that follows a script instead of calling a model. Free and needs no network once VS Code is available.
- `node test/live/partial-review.mjs <empty-dir>`: runs a real `omp acp` session (uses a few model tokens). It accepts only the first of two changes and prints what omp saw.

## Known limits

- Changes made by shell commands (scripts, `sed -i`, …) skip the diff review. You only see the command approval.
- omp's own "Always allow" for shell commands would allow **every** later command, so the extension doesn't offer it. "Always allow read-only commands" lasts until the chat tab closes, and judges commands by their text, so it errs on the side of asking.
- Shell commands run inside omp, not in a VS Code terminal.
- A queued message waits for the whole turn to end: omp's editor mode has no way to add a message to a turn that is already running. Use New Session to work on two things at once.
- All sessions work in the first folder of the workspace.

## License

MIT (see the `LICENSE` file): free for anyone to use, copy, change and share, including commercially. Keep the license notice when you redistribute it.

The finish sound, `media/staplebops-01.mp3`, is the "task finished" sound from [opencode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode, used under the MIT License. Its full license notice is in the `THIRD_PARTY_NOTICES.md` file, which ships with the extension.
