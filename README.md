# Pixel Kaisha

**Status: under development**

Pixel Kaisha is a pixel-art office that shows AI coding agents at work. Each agent appears as a character in a tiny office: they sit at their desks, type when they edit files, read when they search, and visually flag when they need input.

**Kaisha** (会社) is the Japanese word for *company*. The name is a reminder that these agents are the project's staff, visible together in one shared workplace.

This project is a public fork of **[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)** by [pixel-agents-hq](https://github.com/pixel-agents-hq), released under the [MIT License](LICENSE). The upstream project is the original pixel office; Pixel Kaisha builds on that foundation. The original upstream README is preserved at [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md).

![Pixel Agents office](webview-ui/public/office.png)

## Planned engines

Pixel Kaisha aims to support the following engines (work in progress; not all of these are available yet):

- **Claude Code** — local CLI sessions, with optional later support for Claude Code cloud events via repository hooks
- **Codex** — local CLI sessions, plus **Codex Cloud** via polling (`codex cloud list` and related commands)
- **Antigravity (`agy`)** — local sessions, with a later phase for remote-agent streaming

Upstream Pixel Agents supports Claude Code today, with other engines on its own roadmap. This fork focuses on the engines listed above.

## Architecture

- **Visualizer** — the office UI runs on a Windows PC (local server, no paid host required). Opening the office in a browser on that machine is the primary desktop view.
- **Agents** — agents run in the vendors' own clouds (for example Codex Cloud) and, when useful, as local CLIs on the same PC. Cloud tasks are reflected in the office through a poller that maps task status into the existing agent events.
- **Android** — the same office is available as a PWA, reached through a free private tunnel while the PC is on. With the PC off or asleep, the PWA can show only a cached last-known state.

A public ingest route for live hook events (for example Claude Code cloud repository hooks) is optional and not required for the polling-based cloud view.

## Roadmap

Phases below are the intended path for this fork. They are under development and may change.

| Phase | Goal |
|---|---|
| **F0** | Project name, public fork, and documentation (this repository). |
| **F1** | Office running on Windows; local Claude Code agents visible; Android PWA over a private tunnel. |
| **F2** | Local providers for Codex and Antigravity (`agy`). |
| **F3** | Generic cloud poller and Codex Cloud support (status and summaries, cloud-tagged characters). |
| **F4** (optional) | Restricted public ingest for repository hooks and store-and-forward hook queues, so live events can arrive when a tunnel is enabled. |
| **F5** | Antigravity remote-agent stream, plus launching a cloud agent from the office. |
| **F6** | Android offline last-known state, Web Push (while the PC is on), compact mobile layout, and starting the office server automatically with Windows. |

An early usable milestone is the end of F3: local agents plus Codex Cloud visible on the desktop and, with the PC on, on the phone.

## License and credit

Pixel Kaisha is distributed under the MIT License. See [LICENSE](LICENSE).

This repository is a fork of [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT). Upstream copyright and license notices are kept intact. Please credit and follow the original project as well as this fork.

Pixel art in the upstream project is based on the work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

To use the original Pixel Agents CLI or VS Code extension, see the [upstream repository](https://github.com/pixel-agents-hq/pixel-agents) and [`docs/UPSTREAM_README.md`](docs/UPSTREAM_README.md).
