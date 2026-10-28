# OMP for VS Code (prototype)

Chat with [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) inside VS Code, with:

- **Command approval:** every shell command asks inside its own row in the chat (Allow once / Reject; omp's "always" answers aren't offered for commands, because they would cover every later command); afterwards the same row shows ✓ or ✗ and the output. Commands that look like they change files get a warning. **Reject with note…** lets you tell omp what to do instead, and change the command to suggest another: omp can only be told "rejected" in answer, so the turn stops and your note (with the command as you changed it) goes as your next message. A suggested command is not run as is: omp asks again before running it. A command that only reads or navigates, and only reads inside the open folder, runs without asking (turn this off with `omp.autoAllowReadsInFolder`); reading outside the folder asks. A command that reads a secret (`.env` files, keys such as `*.pem` or `id_rsa`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `.netrc`, `.npmrc` and similar, or a recursive search of a folder holding them) asks every time, and can't be always allowed. On a command that only reads or navigates, **Always allow cd, grep, …** allows the programs in that command for the rest of that chat, in any folder (on any other command, a checkbox offers the same for its read-only parts, and leaves that command's own answer to you). A later command then runs without asking only if every program in it is one you allowed and it only reads; any other program still asks. Only read-only programs can be allowed this way (`cd`, `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `echo`); `git` always asks, because even `git status` runs a repository's own settings, which can start programs; anything else, or any redirection to a file, still asks. A request to use the browser shows the code omp is about to run, open and in full, with the web addresses written in it listed above (the code may open other pages too, so check it).
- **Change review:** every file edit opens VS Code's diff view, split into small changes. Each change has **Accept** / **Reject** / **Reject with note…** buttons above it. Only accepted changes are saved, and omp is told exactly which ones you rejected. A note (what to do instead) reaches omp straight away, in the same turn, and omp acts on it.
- **Edit tool first:** omp is told to change files only with its edit tool, so every change goes through the review.
- **Chat names:** omp names chats only in its own terminal app, so after a reply the extension quietly asks it to (`/rename`), until the chat has a name (a chat that is only "hi" so far gets one after a later reply). The name shows on the tab and in the history list. An untitled old chat is named when you open it. omp uses its `smol` model role for this if one is set in `~/.omp/agent/config.yml`, else the main model.
- **Chat history:** omp saves every chat automatically. **OMP: Continue a Previous Chat…** (the history button in a chat tab's title bar) lists this folder's chats, newest first; picking one opens it in a tab with the conversation so far, and you carry on from there. A chat that is already open is brought forward instead. **Show chats from other folders** (the last entry, or the button at the top of the list) adds every other folder's chats, named "folder: chat", those from folders that no longer exist (renamed, moved or deleted) first; one you pick continues in the open folder, and is listed with this folder's chats from then on.
- **MCP servers:** omp ignores its own MCP config when it runs inside an editor, so the extension reads `~/.omp/agent/mcp.json`, the project's `.omp/mcp.json` and the project's `.mcp.json` (Claude Code's file; `${VAR}` values are filled in from the environment) and gives those servers to omp when a chat starts. Web servers that need a sign-in (like Atlassian) use the one you made once in omp's terminal app (`omp`, then `/mcp reauth <name>`); omp keeps it and refreshes it, and the extension passes it along when a chat starts (a sign-in lasts for that chat; a new chat gets a fresh one). A server that still won't start is left out, with a warning in the chat that says how to sign in. Servers connect in the background, so their tools can take a few seconds to appear in a new chat. **OMP: Add MCP Server…** adds a server to omp's own config (for all your projects, or just this one), and **OMP: Open MCP Servers File…** opens that file; new chats pick the changes up. A server turned off with omp's `/mcp disable` stays off.
- **Trusted folders only:** omp runs commands, edits files and starts the project's MCP servers, so the extension stays off in VS Code's Restricted Mode (a folder you haven't marked as trusted).
- **Slash commands:** type `/` at the start of the input to list omp's commands (`/model`, `/compact`, `/review`, …) and click one to fill it in. omp sends the list as soon as a chat starts, before the first message.
- **Message queue:** a message sent while omp works waits above the input (✕ removes it). When the turn ends, the queued messages are sent together as the next message, with all their attachments; a queued slash command (like `/compact`) is sent on its own. If you press **Stop**, or the turn fails or omp crashes, the queued messages go back into the input, attachments included, instead of being sent. A message you send after pressing Stop runs as soon as the stopped turn ends. A long message of yours shows its first three lines in the chat; **Show more** opens it in full.
- **Attachments:** click **+** below the input, right-click files in the Explorer (or an editor tab) and pick **Attach to OMP Chat**, drop files on the chat with **Shift** held (from the Explorer, an editor tab or Finder; when dragging from inside VS Code, press Shift before you reach the chat), or paste an image (cells copied from Excel, or text from Word or Keynote, paste as text, not as the picture of them that comes along). A slash command can't be sent with attachments: send the files in a message of their own. Each file shows as a chip above the input (✕ removes it, hover shows how it is sent). Images go to the model as images; omp shrinks them first. For a model that can't read images, omp has a model that can describe them, and the description goes to the model instead (it shows in a reopened chat as a note). omp uses its `vision` model role for this, set in `~/.omp/agent/config.yml` (`modelRoles.vision`), else any available model that reads images; with none, the model is only told an image was attached. A text file goes in full, unsaved changes included, as long as the message's attached text stays under half the context omp has left (see `omp.attachments.maxTextTokens`); queued messages sent together share that limit, so text that no longer fits goes as its path. Word, Excel, PowerPoint, PDF and EPUB files go as documents: omp is told to read them with its read tool, which turns them into text. A folder goes as a reference: only its path, and omp looks in it and reads just the files that matter for the message. Anything else (other binary files, larger text) goes as its path, which omp can read itself. Type **@** in the input to pick a file or folder (arrow keys, then Enter or Tab). It completes what you type like a path: `@src/om` lists what in `src/` starts with `om`, and picking a folder lists what is in it; a bare name (`@pol`) lists what in the project folder starts with it, then matching files further down (in a git repository, leaving out what git ignores, like `.venv` or build output). Enter picks the first suggestion only when it holds what you typed, so a message ending in `@src/` or `@someone` sends as typed. Every `@path` in a message that exists as typed (letter case included), typed or picked, is attached when it is sent (`@"path with spaces"` for a path with spaces); a file goes like any attached file, a folder as a reference. An `@` inside code (a fenced block or a `span`), like pasted CSS's `@media` or a `@Test` decorator, mentions nothing. A file that comes with no location (pasted, dropped from Finder, or an untitled editor) and can't go inline is saved as a copy for omp, removed when the chat closes (or, after a crash, when VS Code next starts). A reopened chat shows the files as chips again.
- **Context window:** the footer shows how full the context is. omp compacts the conversation by itself when it fills up (it doesn't tell the editor), so the chat notes when the context used drops sharply, and warns once when it passes 80% (type `/compact` to compact now).
- **Replies:** rendered as full markdown (tables, lists, links, code) and sanitised. A ```` ```mermaid ```` block is drawn as a diagram as soon as its closing fence arrives, in VS Code's light or dark theme (**Show code** shows its source; one that can't be drawn stays code, with the reason). Mermaid loads the first time a reply holds a diagram. Code blocks have a **Copy** button, each reply ends with the model and how long the turn took, and the ✎ on any of your messages puts it back in the input to edit and send again.
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
  attachments.ts          what an attached file is sent as: image, text, document, folder or path (no VS Code code)
  mentions.ts             @path mentions: finding them in a message, ranking the @ suggestions (no VS Code code)
  chatPanel.ts + media/   one session's chat tab
  sessions.ts             open sessions, sidebar launcher
  controller.ts           runs one session: connects omp, its chat tab and its reviews
```

## Install

Requirements: `omp` installed and logged in (run `omp` once in a terminal), Node 20+.

```sh
npm install
npm run package # builds omp-vscode-0.1.0.vsix
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
| `omp.attachments.maxTextTokens` | `0` | How much attached text one message may include, in tokens; `0` is half of the context omp has left (100,000 before omp has reported it). Over the limit, or over 5 MB, a file goes as its path |
| `omp.soundOnFinish` | `true` | Play opencode's "task finished" sound when omp finishes a reply |

The extension also turns on `diffEditor.codeLens`, which VS Code hides by default; without it the per-change buttons don't show.

## Tests

- `npm test`: unit tests for hunk splitting, rebuilding, shell warnings, rejection messages and what each attached file is sent as, plus the chat page itself (cards, replay, streaming, attachments, drag and drop) in jsdom, a simulated browser.
- `npm run test:vscode`: opens a separate, throwaway VS Code with the extension, has omp make an edit, accepts the first change and rejects the rest, then checks the result. Then it drops an image (as from Finder) and a file dragged from the Explorer onto the chat with Shift held, through the window's own drag and drop (a simulated drag can't move from one frame into another the way a mouse does, so the Explorer drag is let through by Shift over the Explorer first, then enters the chat), sends them with Enter, and checks the model's answer used both. It uses a few model tokens, and needs a model that reads images, as the main one or omp's `vision` role. Set `VSCODE_PATH` to an installed VS Code executable to skip downloading one.
- `npm run test:offline`: the same throwaway VS Code, but against a fake omp (`test/fixtures/fake-omp.mjs`) that follows a script instead of calling a model. Free and needs no network once VS Code is available.
- `node test/live/partial-review.mjs <empty-dir>`: runs a real `omp acp` session (uses a few model tokens). It accepts only the first of two changes and prints what omp saw.

## Known limits

- Changes made by shell commands (scripts, `sed -i`, …) skip the diff review. You only see the command approval.
- omp's own "Always allow" for shell commands would allow **every** later command, so the extension doesn't offer it. The extension's "Always allow" covers only the read-only programs you chose, lasts until the chat tab closes, and judges commands by their text, so it errs on the side of asking.
- Shell commands run inside omp, not in a VS Code terminal.
- A queued message waits for the whole turn to end: omp's editor mode has no way to add a message to a turn that is already running. Use New Session to work on two things at once.
- All sessions work in the first folder of the workspace.
- VS Code passes a file dropped on a chat tab to the chat only while **Shift** is held. A drag that starts inside VS Code (the Explorer, a tab) is kept from every webview until VS Code sees Shift held during it, and the chat only gets a drag that is let through before it reaches the chat: press Shift on the way. **Attach to OMP Chat** in the right-click menu always works.
- ✎ on a message puts back its text, not its attachments: attach them again. The chat page reads files dropped from Finder or pasted itself, up to 20 MB; attach a larger one with **+** or from the Explorer, so omp gets its path. Old Office formats (`.doc`, `.xls`, `.ppt`) go as paths only: omp has no converter for them.

## License

MIT (see the `LICENSE` file): free for anyone to use, copy, change and share, including commercially. Keep the license notice when you redistribute it.

The finish sound, `media/staplebops-01.mp3`, is the "task finished" sound from [opencode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode, used under the MIT License. Its full license notice is in the `THIRD_PARTY_NOTICES.md` file, which ships with the extension.
