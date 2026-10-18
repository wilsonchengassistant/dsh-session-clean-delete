# dsh-session-delete

A permanent **Delete session** action for the DeepSeek Harness sidebar, behind a
confirmation dialog that tells you what is about to go.

DSH ships a *Archive* action, which is reversible and keeps the session in the
Archived list. This plugin adds the irreversible counterpart, and — unlike a
naive `rm` of the session log — it actually makes the row disappear.

## What it does

Adds one row to the per-session `…` menu in the left sidebar, ordered after
Pin / Rename / Fork / Archive. Choosing it opens a modal that reports:

- whether the session is **still open on this machine** (it cannot be reopened afterwards),
- the **log size** about to be removed,
- **running turns, subagents, background jobs and reminders** bound to the session,
- how many reminders are deleted with it.

Confirming stops the session's work, unlinks its session directory and projection
checkpoint, and releases the id from every registry that would otherwise keep
listing it. Then the sidebar refreshes and the row is gone.

There is **no undo and no trash folder**. The dialog says so.

## Why it is not just `rm`

A session's directory is not the only thing that makes it appear. The Host's
session corpus is `persistence ∪ live`, so a session the Host still holds live
keeps coming back after its log is deleted:

1. the browser drops the row,
2. the next `sessions.refresh()` rebuilds the rows from the Host list and folds
   the live summary back in,
3. the row **returns**.

The visible symptom of this is that deleting several sessions in a row makes the
earlier ones reappear, and that archived rows come back stuck in Archived forever
(the old id was never removed from the archive set, so it accumulated dead ids).

`release()` therefore detaches through the same teardown the owning fiber uses,
in the order the agent loop's own disposal uses — **agents first, then
sessions** — plus `unarchiveSession(id)` and `workspace.detachSession(id)`. The
browser keeps its own `retired` set and re-applies every retirement after each
refresh, so rows stay retired until the Host's `api-session/removed` agrees.

## Install

This is a **profile-local** package: it declares no `dsh.bundle`, so `dsh plugin`
installs it as a plain dependency and it stays out of the layer stack until
`cordis.patch.yml` names it. Bare `@deepseek-ai/*` imports are resolved by the
host itself, so the package declares **zero dependencies** — do not add them.

```bash
git clone https://github.com/wilsonchengassistant/dsh-session-delete.git
dsh plugin add file:/absolute/path/to/dsh-session-delete
```

Then add a root-patch row with a **list** value to the profile's
`cordis.patch.yml` (usually `~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

Verify it joined the tree — the entry must appear under a `# == …/cordis.patch.yml`
banner, which is the part that is easy to miss:

```bash
dsh --profile <profile> --dump-config | grep session-delete
```

`--dump-config` never mounts, so it is safe against the live profile.

Finally **restart the harness**. The bundle is composed at boot, so there is no
partial effect: until it restarts, the menu row is not there.

### If nothing happens

- **Re-running `dsh plugin add file:<dir>` is a no-op** — same spec, same version.
  `rm -rf ~/.dsh/profiles/<profile>/node_modules/dsh-session-delete` first, or the
  profile keeps serving the old copy forever.
- pnpm **copies** the package into the profile rather than symlinking it, so
  editing your clone does not change the running plugin. Copy
  `lib/*.js` into `~/.dsh/profiles/<profile>/node_modules/dsh-session-delete/lib/`.
  `client.js` hot-reloads; `index.js` is host-side and needs a restart.
- `dsh plugin` needs `pnpm` on `PATH` (`corepack enable pnpm`), or it fails with
  "pnpm was not found".

## Design notes

**A Typert `Remote` service, not an HTTP route.** The host half registers one
`TypertRemoteService` named `sessionDelete` with `describe` and `deleteSession`.
The Gateway auto-claims every endpoint a live `TypertRemoteService` declares, and
the browser calls it over the ordinary channel:

```js
ctx.connection.rpc.call('/api', `sessionDelete/${method}`, { args: { request } })
```

So there is no route to register and no permission to grant — the browser peer is
the owner principal.

**It deliberately does not check `Origin`.** In the desktop app the renderer
origin is the custom scheme `dsh-app://app`, and the shell's `protocol.handle`
strips `origin`, `host`, `cookie` and `sec-fetch-site` before forwarding to the
Host. A plugin route that validates `origin === 'http://' + host` therefore 403s
*every* request from the desktop app while working fine under `dsh web`. The
Remote-service path avoids the question entirely.

**The postcondition is checked against the disk.** A successful `rm` is not
treated as proof; `removeLog()` stats the path afterwards and throws
`delete/failed` if it survived.

## Files

| Path | Role |
| --- | --- |
| `lib/index.js` | Host half: `TypertRemoteService`, the delete sequence, registry release. |
| `lib/client.js` | Browser half: the menu row and the `shell.overlay` confirmation dialog. |
| `locale/en.json`, `locale/zh.json` | Plugin titles for the Plugins panel. |

The in-app dictionary lives in `lib/client.js` (`zh` is the key-set source of
truth, `en` is checked complete against it); `locale/*.json` is the metadata the
Plugins panel reads.

## License

MIT — see [LICENSE](LICENSE).
