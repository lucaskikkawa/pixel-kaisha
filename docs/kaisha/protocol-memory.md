# Character memory: client ↔ server messages (Pixel Kaisha B2.4)

Additive to the existing WebSocket protocol (`/ws`, see `core/asyncapi.yaml`). Older servers never answer the new request and keep an unknown profile field as is; older clients never send it. Server code: `server/src/characterMemory.ts` (pure, tested in `server/__tests__/characterMemory.test.ts`); the profile field lives in `core/src/characterProfiles.ts`.

**Pixel Kaisha stores only the path** of a character's tool memory on its profile. The content is **read on request, never written**: the server only calls `stat`, `readdir`, `open('r')`, `read` and `close` on it — no create, append, mkdir, chmod or delete. A path that isn't there is a warning, never an error. The memory's content is never logged.

## `memoryPath` on the character profile

```json
{ "id": "c1a2b3", "name": "Ana", "body": "bust", "v": 35, "memoryPath": "~/work/app/CLAUDE.md" }
```

- Optional string: an absolute path (`/…`, `C:\…`, `\\server\…`) or one in the home directory (`~`, `~/…`; `~user` is not supported).
- Typical paths (the UI suggests these; any readable file or folder is accepted):
  - `~/work/<repo>/CLAUDE.md` or `~/.claude/CLAUDE.md` (Claude Code)
  - `~/.claude/projects/<project>/memory/` (Claude Code's per-project memory folder)
  - `~/work/<repo>/AGENTS.md` (Codex and others)
  - `~/work/<repo>/GEMINI.md` or `~/.gemini/GEMINI.md` (Gemini CLI)
- Saved with the rest of the profile (`saveCharacterProfiles` → `~/.pixel-agents/characters.json` → `characterProfilesLoaded`), so it comes back in the snapshot after a restart. No separate file.
- Normalized by `parseCharacterProfiles` (`normalizeMemoryPath`): trimmed; a blank, relative, `~user`, NUL-holding, over-1024-character or non-string value is **dropped** (never saved as `""`), and the rest of the profile is still saved. `isCharacterProfile` does not refuse a profile for it.
- Absent = no memory. Profiles saved before B2.4 are unchanged and valid.
- **No `CHARACTER_PROFILE_VERSION` bump** (still 35): the migration copies the whole profile, so the optional field passes through it untouched; a current profile whose path is already normal comes back as the same object.
- The server does not check that the path exists when it is saved: it is checked on every read.

## `requestCharacterMemory` (client → server)

```json
{ "type": "requestCharacterMemory", "profileId": "c1a2b3" }
{ "type": "requestCharacterMemory", "profileId": "c1a2b3", "path": "~/work/app/AGENTS.md" }
```

- `profileId`: the character profile's `id`.
- `path?`: read this instead of the stored path. It is read whether or not the profile is saved yet (the editor can preview a draft character's path before Save). Same rules as `memoryPath`.
- **Privileged clients only**: a read-only (untokened) client gets no reply (the usual read-only gate).

## `characterMemory` (server → client)

Sent to the asking client only (never broadcast).

```json
{ "type": "characterMemory", "profileId": "c1a2b3", "path": "/home/ana/work/app/CLAUDE.md", "content": "# Project\n…" }
{ "type": "characterMemory", "profileId": "c1a2b3", "path": "/home/ana/work/app/CLAUDE.md", "warning": "not-found" }
{
  "type": "characterMemory",
  "profileId": "c1a2b3",
  "path": "/home/ana/.claude/projects/app/memory",
  "content": "--- notes.md ---\n\n…\n\n--- todo.md ---\n\n…",
  "files": ["notes.md", "todo.md"]
}
```

- `path`: the resolved path tried (`~` expanded to the home directory, normalized); `''` when there was none (`no-path`, `unknown-profile`, `invalid-path`).
- `content?`: UTF-8 text, at most 256 KiB (`MEMORY_READ_MAX_BYTES`).
- `files?`: for a folder, the file names read, in order.
- `warning?`:

| Warning           | When                                                                          | `content`                  |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------- |
| `not-found`       | Nothing at the path (or a parent is a file)                                   | absent                     |
| `not-a-file`      | Neither a regular file nor a folder (a socket, a FIFO, a device)              | absent                     |
| `too-large`       | A file over 256 KiB. For a folder: some files didn't fit under the cap        | absent / the ones that fit |
| `unreadable`      | Permission denied or another read error; or binary (a NUL in the first 8 KiB) | absent                     |
| `no-path`         | The profile has no `memoryPath` and the request named no `path`               | absent                     |
| `invalid-path`    | The request's `path` is not a string, blank, relative or `~user`              | absent                     |
| `unknown-profile` | No saved profile has `profileId` (and the request named no `path`)            | absent                     |

The server never throws on a bad request or a bad path.

## Reading rules

- **File**: read whole as UTF-8 when ≤ 256 KiB; larger is `too-large` and **no content is sent** (no flood). A symlink to a file is followed (a `CLAUDE.md` is often one).
- **Folder** (`~/.claude/projects/<proj>/memory/`): only its **direct** regular files named `*.md`, `*.markdown` or `*.txt` (case-insensitive), not hidden (`.name`), sorted by name. Not recursive; **symlinks inside the folder are not followed** (skipped), so a link can't pull in a file from elsewhere. Joined as `--- <name> ---\n\n<text>`, files separated by `\n\n` (i.e. the separator `\n\n--- <name> ---\n\n`), until the 256 KiB cap (headers included); a file that doesn't fit is left out and the reply carries `too-large` with the ones that fit. A binary or unreadable file inside is skipped. A folder with none: `content: ''`, `files: []`, **no warning**.
- Async (`fs.promises`), so a read never blocks the event loop.
- Both surfaces answer it: the standalone server (`clientMessageHandler`) and the VS Code panel (`PixelAgentsViewProvider`).
