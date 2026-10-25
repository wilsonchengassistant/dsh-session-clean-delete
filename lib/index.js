/**
 * Permanent session deletion, host half.
 *
 * Registers one Typert Remote service, `sessionDelete`, with five methods:
 * `describe` reports what a delete would destroy, `deleteSession` performs
 * it, and `listLocked` / `lockSession` / `unlockSession` manage the locks
 * that stop a session from being deleted. The browser reaches all of them
 * over the ordinary `/api` RPC channel, so no route, registry entry or
 * permission is needed: the Gateway auto-claims every endpoint a live
 * `TypertRemoteService` declares on its prototype, and the desktop browser
 * peer is the owner principal.
 *
 * The lock is the Host's own decision, not the browser's: `deleteSession`
 * refuses a locked session even when the caller never saw the lock, so the
 * guarantee does not depend on the menu being greyed out.
 */
import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

/**
 * Session ids are the transport-safe segment characters DSH itself mints:
 * `session-<uuid>` for a top-level session, a bare uuid for a delegated child.
 * The leading-alphanumeric rule is what keeps `.` and `..` out.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/u;

/** The storage domain the projection cache checkpoints live in. */
const PROJECTION_CACHE_DOMAIN = "session_projcache";

/**
 * The storage domain the session locks live in.
 *
 * A lock has to outlive the process: a lock that vanished on every restart
 * would be a weak lock, and the whole point of locking a session is to keep it
 * safe across a working session that may well span a restart. The domain is
 * separate from the projection cache because the two have nothing in common —
 * one is a cache the Host rebuilds on demand, the other is a decision the user
 * made and expects to be remembered.
 */
const LOCK_DOMAIN = "session_locks";

/** The table inside {@link LOCK_DOMAIN}, one record per locked session. */
const LOCK_TABLE = "locks";

/**
 * One lock record. The timestamp is the only content: the key is the session
 * id, and a lock carries no settings of its own.
 *
 * A storage domain's record schema has to be a zod schema — the domain layer
 * validates every stored record with `valueSchema.parse` — so zod is the one
 * runtime dependency this package declares. `@deepseek-ai/*` imports are
 * resolved by the host itself and are not declared.
 */
const lockRecord = z.object({
	lockedAt: z.number().int().nonnegative()
});

/** The domain declaration for the session locks. */
const lockDomainSpec = defineDomain({
	name: LOCK_DOMAIN,
	version: 1,
	compatibleVersions: [],
	invalidRecords: "backup-and-skip",
	layout: "per-record",
	tables: { locks: domainTable(lockRecord) }
});


/**
 * Declare one direct Remote method without decorator syntax: this runtime has
 * V8 decorators switched off, so `@Remote(…)` is a hard SyntaxError here.
 * `Remote(exportName)` returns the same decorator function the shipped
 * packages' compiler emits, and the only thing it needs from a decorator
 * context is `addInitializer`. The initializer derives the prototype from its
 * receiver, so it has to run against an instance.
 *
 * @param {object} Proto - Class carrying the method.
 * @param {string} method - Method name, which is also the wire export name.
 * @returns {void}
 */
function declareRemote(Proto, method) {
	const initializers = [];
	Remote(method)(void 0, {
		name: method,
		"static": false,
		private: false,
		addInitializer(initializer) {
			initializers.push(initializer);
		}
	});
	if (initializers.length !== 1) {
		throw new Error(`session-delete: cannot declare Remote method '${method}'`);
	}
	initializers[0].call(Object.create(Proto.prototype));
}

/**
 * Narrow one wire request to a well-formed session id.
 *
 * @param {unknown} request - Decoded wire argument.
 * @returns {string} the session id.
 */
function sessionIdOf(request) {
	const sessionId = request?.sessionId;
	if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
		throw new RemoteError("delete/invalid-request", "a session id must be transport-safe: letters, digits, `_`, `$`, `.` and `-`, starting with a letter or digit", {
			sessionId: typeof sessionId === "string" ? sessionId : null
		});
	}
	return sessionId;
}

/**
 * Test one path without following into a directory listing.
 *
 * @param {string} path - Absolute path to probe.
 * @returns {Promise<boolean>} whether the path exists.
 */
async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Project one activity entry into the lossless JSON the browser renders.
 *
 * @param {{kind: string, items?: readonly unknown[]}} entry - Registry activity.
 * @returns {{kind: string, items: {id: string, label: string | null}[]}} the wire shape.
 */
function activityEntry(entry) {
	return {
		kind: String(entry?.kind ?? "other"),
		items: (entry?.items ?? []).map((item) => ({
			id: String(item?.id ?? ""),
			label: typeof item?.label === "string" ? item.label : null
		}))
	};
}

class SessionDeleteService extends TypertRemoteService {
	/** Nothing below may run before the store, the live registry and the storage facility exist. */
	static inject = ["sessionPersistence", "sessions", "storageDomain"];

	/**
	 * The sessions the user has locked, by id.
	 *
	 * This set is the Host's own view and the authority a delete is checked
	 * against: a browser that has not yet learned about a lock — an old tab, a
	 * second window, a stale client — must not be able to delete a session the
	 * user asked to keep. The durable copy in {@link LOCK_DOMAIN} is the
	 * mirror; this set is what the running Host answers from.
	 */
	locked = new Set();

	/** The open lock domain, once {@link ensureLocks} has opened it. */
	lockDomain = undefined;

	/** Whether the lock set has been hydrated from the durable copy. */
	locksHydrated = false;

	/**
	 * @param {object} ctx - Host context carrying the injected services.
	 */
	constructor(ctx) {
		super(ctx, "sessionDelete");
	}

	/**
	 * Open the lock domain and read the stored locks into memory.
	 *
	 * This is fail-soft on purpose. A lock that cannot be persisted is still
	 * worth having for the life of the process, so the failure is logged and
	 * the plugin keeps working with an in-memory set; the delete is still
	 * refused for whatever the user locked during this run.
	 *
	 * @returns {Promise<void>} resolution after the set is hydrated.
	 */
	async ensureLocks() {
		if (this.locksHydrated) return;
		this.locksHydrated = true;
		try {
			let domain;
			try {
				domain = await this.ctx.storageDomain.open(lockDomainSpec);
			} catch (error) {
				// Another mount of this plugin already opened the domain.
				domain = this.ctx.storageDomain.get(LOCK_DOMAIN);
				if (domain === undefined) throw error;
			}
			this.lockDomain = domain;
			this.ctx.effect(() => () => domain.close(), "session-delete: lock domain close");
			for (const [sessionId] of domain.table(LOCK_TABLE).entries()) {
				this.locked.add(sessionId);
			}
		} catch (error) {
			this.ctx.logger.warn(`session-delete: session locks will not survive a restart: ${String(error)}`);
		}
	}

	/**
	 * Write one lock into the durable mirror, or take it out again.
	 *
	 * @param {string} sessionId - Session whose lock state changes.
	 * @param {boolean} locked - Whether the session ends up locked.
	 * @returns {Promise<void>} resolution after the mirror is updated.
	 */
	async writeLock(sessionId, locked) {
		if (this.lockDomain === undefined) return;
		const table = this.lockDomain.table(LOCK_TABLE);
		try {
			if (locked) await table.put(sessionId, { lockedAt: Date.now() });
			else await table.delete(sessionId);
		} catch (error) {
			this.ctx.logger.warn(`session-delete: could not ${locked ? "lock" : "unlock"} '${sessionId}' durably: ${String(error)}`);
		}
	}

	/**
	 * Every session the user has locked.
	 *
	 * The browser mirrors this so it can grey the delete row out without
	 * asking the Host on every menu open; the Host still checks the lock
	 * itself before it deletes anything.
	 *
	 * @returns {Promise<{locked: string[]}>} the locked session ids.
	 */
	async listLocked() {
		await this.ensureLocks();
		return { locked: [...this.locked] };
	}

	/**
	 * Lock one session: it can no longer be deleted until it is unlocked.
	 *
	 * @param {{sessionId: string}} request - Session to lock.
	 * @returns {Promise<{sessionId: string, locked: boolean}>} the new state.
	 */
	async lockSession(request) {
		const sessionId = sessionIdOf(request);
		await this.ensureLocks();
		this.locked.add(sessionId);
		await this.writeLock(sessionId, true);
		return { sessionId, locked: true };
	}

	/**
	 * Unlock one session, so it can be deleted again.
	 *
	 * @param {{sessionId: string}} request - Session to unlock.
	 * @returns {Promise<{sessionId: string, locked: boolean}>} the new state.
	 */
	async unlockSession(request) {
		const sessionId = sessionIdOf(request);
		await this.ensureLocks();
		this.locked.delete(sessionId);
		await this.writeLock(sessionId, false);
		return { sessionId, locked: false };
	}

	/**
	 * Read what deleting one session would destroy: where it lives, how large
	 * its log is, whether the Host still holds it live, and which activity the
	 * registry reports (running turns, subagents, jobs and reminders).
	 *
	 * @param {{sessionId: string}} request - Session to inspect.
	 * @returns {Promise<object>} the facts the confirmation dialog renders.
	 */
	async describe(request) {
		const sessionId = sessionIdOf(request);
		const stored = await this.ctx.sessionPersistence.stat(sessionId);
		const live = this.ctx.sessions.get(sessionId);
		if (stored === undefined && live === undefined) {
			throw new RemoteError("session/not-found", `no session '${sessionId}'`, { sessionId });
		}
		const activity = await this.ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
		return {
			sessionId,
			live: live !== undefined,
			locked: this.locked.has(sessionId),
			cwd: stored?.header?.cwd ?? live?.header?.cwd ?? null,
			sizeBytes: typeof stored?.sizeBytes === "number" ? stored.sizeBytes : null,
			activity: [...activity].map(activityEntry)
		};
	}

	/**
	 * Permanently remove one session: stop its work, drop its reminders and
	 * background jobs, flush whatever the Host still holds live, unlink the
	 * session directory and its projection checkpoint, then release the id from
	 * the live and durable registries so it stops being listed.
	 *
	 * The delete is irreversible — there is no undo and no trash — so every
	 * refusal is explicit and the postcondition is verified against the disk
	 * rather than assumed from a successful `rm`.
	 *
	 * @param {{sessionId: string}} request - Session to delete.
	 * @returns {Promise<object>} which artifacts were actually removed.
	 */
	async deleteSession(request) {
		const sessionId = sessionIdOf(request);
		await this.ensureLocks();

		// A locked session is one the user asked to keep. The browser greys the
		// delete row out, but that is only a hint: this refusal is the actual
		// guarantee, and it has to hold for a client that has not learned about
		// the lock yet.
		if (this.locked.has(sessionId)) {
			throw new RemoteError("session/locked", `the session '${sessionId}' is locked; unlock it before deleting it`, { sessionId });
		}

		const live = this.ctx.sessions.get(sessionId);
		const stored = live === undefined ? await this.ctx.sessionPersistence.stat(sessionId) : void 0;
		if (live === undefined && stored === undefined) {
			throw new RemoteError("session/not-found", `no session '${sessionId}'`, { sessionId });
		}

		// Archive first. The durable archive set is what the providers'
		// `agent/pre-step` gate reads, so a wake the stop below induces is
		// already blocked and cannot recreate the log we are about to unlink.
		// The entry is dropped again in `release`, after the live registries no
		// longer hold the id. Best effort — a session outside the workspace
		// registry has no gate to close.
		const registry = this.ctx.get("workspaceRegistry");
		try {
			await registry?.archiveSession(sessionId, { stopActivity: true });
		} catch (error) {
			this.ctx.logger.warn(`session-delete: could not archive '${sessionId}' before deleting it: ${String(error)}`);
		}

		// The one supported way to quiesce a session: running turns, subagent
		// descendants, background jobs and every reminder bound to it.
		await this.ctx.parallel("workspace/session-stop", { sessionId });

		if (live !== undefined) {
			try {
				await this.ctx.sessions.flush(live);
			} catch (error) {
				this.ctx.logger.warn(`session-delete: flushing live session '${sessionId}' failed: ${String(error)}`);
			}
		}

		const header = stored?.header ?? live?.header;
		const removed = {
			log: header === undefined ? false : await this.removeLog(header),
			projectionCache: await this.removeProjectionCache(sessionId)
		};

		await this.release(sessionId);

		// A deleted session has no lock to keep, and a lock left behind would
		// refuse a session that is later created with the same id.
		if (this.locked.delete(sessionId)) await this.writeLock(sessionId, false);

		return { sessionId, deleted: removed.log || removed.projectionCache, removed };
	}

	/**
	 * Take one deleted session out of every registry that would otherwise keep
	 * listing it.
	 *
	 * The Host's session corpus is persistence ∪ live (`SessionCorpus.
	 * listSessions`), so a session the Host still holds live keeps coming back
	 * after its log is gone: the browser drops the row, the next
	 * `sessions.refresh()` folds the live summary back in, and the row returns
	 * — which is why deleting a few in a row only made the earlier ones
	 * reappear. Detaching through the same teardown the owning fiber uses
	 * removes the entry and emits `session/disposed`, which the Session
	 * Controller relays as `api-session/removed` to every connected browser.
	 *
	 * This reaches for the registries' own teardown on purpose: a live session
	 * belongs to the fiber that created it and the runtime publishes no
	 * close/delete entry point. Each step is best effort and logged, because
	 * the log is already unlinked by the time this runs.
	 *
	 * @param {string} sessionId - Session that was just deleted.
	 * @returns {Promise<void>} resolution after every best-effort step.
	 */
	async release(sessionId) {
		// Agent first, then the session: that is the order the agent loop's own
		// disposal uses, and with the session already gone `agent/disposed`
		// cannot re-publish an `api-session/added` row.
		this.detachLive(this.ctx.get("agents"), sessionId);
		this.detachLive(this.ctx.sessions, sessionId);

		// Durable registry state: a deleted id left in the archive set is a
		// dangling entry that keeps the id archived forever, and it is what
		// made deleted sessions show up under Archived again after a reload.
		const registry = this.ctx.get("workspaceRegistry");
		try {
			await registry?.unarchiveSession(sessionId);
		} catch (error) {
			this.ctx.logger.warn(`session-delete: could not drop the archive entry for '${sessionId}': ${String(error)}`);
		}

		// Workspace accounting keeps a slot per session; drop the deleted one so
		// the workspace never accumulates ids whose logs are gone.
		for (const workspace of registry?.list?.() ?? []) {
			if (!workspace.sessionIds.includes(sessionId)) continue;
			try {
				await workspace.detachSession(sessionId);
			} catch (error) {
				this.ctx.logger.warn(`session-delete: could not detach '${sessionId}' from workspace '${workspace.id}': ${String(error)}`);
			}
		}
	}

	/**
	 * Remove one live entry from a registry that stores it by session id.
	 *
	 * Both the Agent registry and the Session store expose the same shape: an
	 * id-keyed `store` of entries plus `detachEntered(entry)`, the single
	 * teardown that unregisters the entry and emits its paired disposal event.
	 *
	 * @param {object | undefined} service - Registry carrying `store` and `detachEntered`.
	 * @param {string} sessionId - identity to detach.
	 * @returns {void}
	 */
	detachLive(service, sessionId) {
		if (service === void 0) return;
		const entry = service.store?.get?.(sessionId);
		if (entry === void 0) return;
		if (typeof service.detachEntered !== "function") {
			this.ctx.logger.warn(`session-delete: live registry for '${sessionId}' has no detach entry point, so the session may be listed again`);
			return;
		}
		try {
			service.detachEntered(entry);
		} catch (error) {
			this.ctx.logger.warn(`session-delete: detaching live '${sessionId}' failed: ${String(error)}`);
		}
	}

	/**
	 * Unlink one session's whole directory and verify the artifact is gone.
	 *
	 * The path comes from the backend's own `locate`, so the project slug and
	 * the encoded id segment stay the store's business rather than a copy here.
	 *
	 * @param {{id: string, cwd?: string}} header - The stored session header.
	 * @returns {Promise<boolean>} whether a materialized log was removed.
	 */
	async removeLog(header) {
		const persistence = this.ctx.sessionPersistence;
		if (typeof persistence.locate !== "function") {
			throw new RemoteError("delete/unsupported", "this deployment's session store cannot locate artifacts, so a permanent delete is unavailable");
		}
		const logPath = persistence.locate(header).path;
		const existed = await pathExists(logPath);
		await rm(dirname(logPath), { recursive: true, force: true });
		if (await pathExists(logPath)) {
			throw new RemoteError("delete/failed", `the session log is still on disk after deletion: ${logPath}`, { sessionId: header.id });
		}
		return existed;
	}

	/**
	 * Drop the projection checkpoint through the already-open storage domain,
	 * so the in-memory table and the stored document move together.
	 *
	 * @param {string} sessionId - Session whose checkpoint goes.
	 * @returns {Promise<boolean>} whether a checkpoint was removed.
	 */
	async removeProjectionCache(sessionId) {
		try {
			const domain = this.ctx.get("storageDomain")?.get(PROJECTION_CACHE_DOMAIN);
			if (domain === void 0) return false;
			return await domain.table("sessions").delete(sessionId);
		} catch (error) {
			this.ctx.logger.warn(`session-delete: projection checkpoint for '${sessionId}' survived: ${String(error)}`);
			return false;
		}
	}
}

declareRemote(SessionDeleteService, "describe");
declareRemote(SessionDeleteService, "deleteSession");
declareRemote(SessionDeleteService, "listLocked");
declareRemote(SessionDeleteService, "lockSession");
declareRemote(SessionDeleteService, "unlockSession");

export { SessionDeleteService, SessionDeleteService as default };
