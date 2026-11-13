# Pixel Kaisha

**Status: under development.** Pixel Kaisha is a pixel-art office for observing AI coding agents as animated characters. _Kaisha_ (会社) means “company” in Japanese.

Pixel Kaisha is a fork of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) by pixel-agents-hq, distributed under the [MIT license](LICENSE). See the [upstream README](docs/UPSTREAM_README.md) for the original project.

![Pixel Agents office](webview-ui/public/office.png)

## Agent engines

- **Claude Code:** local sessions through hooks.
- **Codex:** local sessions through hooks and Codex Cloud task status through polling.
- **Antigravity (`agy`):** local sessions through hooks. A session ends on its `SessionEnd` hook and its character leaves the office.

Cloud polling shows task status rather than a full live conversation. Availability depends on the corresponding tools and credentials being configured.

## Architecture and stack

The project uses TypeScript and Node.js (20 or later), Fastify and WebSockets for the server, and React, Vite and CSS for the webview. The browser interface includes a PWA manifest. The VS Code adapter and browser server share core types and messages.

- [`core/src/`](core/src/) — shared schemas, messages and provider interfaces.
- [`server/src/providers/hook/`](server/src/providers/hook/) — local agent providers and hook integrations for Claude, Codex and Antigravity.
- [`server/src/`](server/src/) — server, event handling, agent state and client communication; [`cli.ts`](server/src/cli.ts) is the CLI entry point.
- [`server/src/cloudPoller.ts`](server/src/cloudPoller.ts) and [`server/src/providers/poll/codexCloud/`](server/src/providers/poll/codexCloud/) — cloud polling and the Codex Cloud provider.
- [`webview-ui/src/`](webview-ui/src/) — React office and browser UI; [`webview-ui/public/manifest.webmanifest`](webview-ui/public/manifest.webmanifest) provides PWA metadata.
- [`adapters/vscode/`](adapters/vscode/) — VS Code extension integration.

The intended setup is a visualizer running on a PC, with local CLI sessions and supported cloud tasks represented in the office. The browser UI also targets mobile devices; remote access and PC migration are planned work.

## Releases

- **v0.1.0:** initial milestone with local providers, Codex Cloud polling and mobile layouts. [Tag](https://github.com/lucaskikkawa/pixel-kaisha/tree/v0.1.0).
- **v0.1.1:** fixes for local session detection and the mobile cloud card layout. Antigravity session-end handling was a known issue in v0.1.1; it has since been fixed on `main` (B2.5, part of the upcoming v0.2). [Release notes](https://github.com/lucaskikkawa/pixel-kaisha/releases/tag/v0.1.1).

## Roadmap

The following features are planned, not yet released:

| Version                       | Goals                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.2 — living office**      | Short speech and action bubbles without extra model calls; per-character and group history; work, meeting and rest rooms; character memory links and default tools; status panel and browser notifications; lifecycle fixes for Antigravity and Codex subagents. |
| **v0.3 — projects and teams** | Projects and team organization, Scrum ceremonies, a prioritized task queue and continuous QA, per-character model configuration, remote notifications and PC migration after testing and review.                                                                 |
| **v0.4 — Google Docs**        | Google Docs integration.                                                                                                                                                                                                                                         |

## License and credit

Pixel Kaisha and its upstream foundation are distributed under the [MIT license](LICENSE). Pixel art in the upstream project is based on [JIK-A-4's Metro City character pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).
