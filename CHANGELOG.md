# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased — 1.0.3

_Not yet published. `npm view dsh-session-clean-delete version` still reports
`1.0.2`; the repository is already at `1.0.3`._

### Added

- **A Lock session action**, in the same per-session `…` menu and directly
  above the delete row. Choosing it locks the session; the row becomes
  **Unlock session**, and the delete row stays in place but is **disabled and
  greyed out** rather than removed. Nothing in the session list changes — a
  locked session looks like any other.

  The lock is the Host's decision, not the browser's: `deleteSession` refuses a
  locked session with `session/locked` even when the caller never saw the lock,
  so another tab, an old client or a direct RPC call cannot delete it either.
  The greyed row is a hint; the refusal is the guarantee.

  A lock outlives a restart: it is stored in its own `session_locks` storage
  domain, and deleting a session removes the lock with it. Only deletion is
  blocked — archiving, renaming, forking and using the session are untouched.

  The grey comes from the shell rather than from custom CSS: a disabled menu
  item is drawn at reduced opacity, and the delete row drops its `danger`
  styling while it is disabled, so what is left is the ordinary label colour at
  that lower opacity — a grey rather than a dim red.

- `zod` is now a declared dependency. A storage domain validates every stored
  record with `valueSchema.parse`, and that schema has to be a zod schema; the
  `@deepseek-ai/*` imports are still resolved by the host and are not declared.

## 1.0.2 — 2026-10-25

### Added

- Two screenshots in `docs/`, embedded in the README: the sidebar's per-session
  `…` menu with the **删除会话** row below Archive, and the confirmation dialog
  (永久删除会话？ / 会话日志约 41 KB。 / 取消 · 永久删除).
- `screenshots.json` listing the two images, for the app storefronts that read
  it. The registry probe accepts a plain path array, so the file is one.
- `screenshots.json` and `docs/*.png` added to `files[]`, so the tarball
  actually carries them. npm skips a listed file that does not exist, silently.
- `CHANGELOG.md` added to `files[]`, so the release history ships with the
  package.

### Changed

- The README gained a **Localization** section. The screenshots are in
  Simplified Chinese while the README is in English, which reads as an
  inconsistency unless it is explained: the plugin ships `zh` (Simplified) and
  `en` and follows the app's language setting; Traditional Chinese is owned by
  the separate [`dsh-zh-hant`](https://github.com/wilsonchengassistant/dsh-zh-hant)
  language pack, and without it the dialog is expected to read in Simplified.

The screenshots were captured from a scratch DSH profile with a throwaway
session, so no real conversation is in frame, and in the Simplified Chinese UI
the plugin ships by default. The session title was shortened through
`session/rename` so it renders without truncation.

## 1.0.1 — 2026-10-19

- Tracked `1.0.1` in `package.json` to match npm's `latest` tag. The version
  had been published as `1.0.1`; the repository still said `1.0.0`.

## 1.0.0 — 2026-10-19

First public release, published as `dsh-session-clean-delete`.

- Adds one row to the per-session `…` menu in the left sidebar, ordered after
  Pin / Rename / Fork / Archive.
- A confirmation dialog that reports whether the session is still open on this
  machine, the log size about to be removed, and the running turns, subagents,
  background jobs and reminders bound to the session.
- Deleting releases the id from every registry that would otherwise keep
  listing it — the Host's session corpus is `persistence ∪ live`, so removing
  the log alone lets the row come back.
- The postcondition is checked against the disk: a successful `rm` is not
  treated as proof, and `removeLog()` stats the path afterwards.
- English and Simplified Chinese dictionaries with identical key sets.
- Zero runtime dependencies; one Host module and one browser bundle.
