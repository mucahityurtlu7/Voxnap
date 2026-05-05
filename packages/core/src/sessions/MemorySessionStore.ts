/**
 * In-memory ISessionStore with optional localStorage durability.
 *
 * Used by every app shell as the default store. Web/desktop persist
 * to `localStorage` so refreshes don't lose the demo data; Tauri/mobile
 * shells may pass `{ persist: false }` and handle their own persistence.
 */
import type { ActionItem, Session, SessionSummary } from "../types.js";
import type { ISessionStore } from "./ISessionStore.js";

const STORAGE_KEY = "voxnap.sessions.v1";

export interface MemorySessionStoreOptions {
  /** Seed data used when the store is empty (or persistence is disabled). */
  seed?: Session[];
  /** When true (default), reads/writes localStorage if available. */
  persist?: boolean;
  /** Override the storage key (e.g. for tests). */
  storageKey?: string;
}

function readStorage(key: string): Session[] | null {
  if (typeof globalThis === "undefined") return null;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session[];
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorage(key: string, sessions: Session[]): void {
  if (typeof globalThis === "undefined") return;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(sessions));
  } catch {
    /* quota exceeded — non-fatal. */
  }
}

export class MemorySessionStore implements ISessionStore {
  private sessions: Session[];
  private readonly persist: boolean;
  private readonly storageKey: string;

  constructor(opts: MemorySessionStoreOptions = {}) {
    this.persist = opts.persist ?? true;
    this.storageKey = opts.storageKey ?? STORAGE_KEY;
    const persisted = this.persist ? readStorage(this.storageKey) : null;
    this.sessions = persisted ?? opts.seed ?? [];
    if (this.persist && !persisted && opts.seed) {
      writeStorage(this.storageKey, this.sessions);
    }
  }

  private flush(): void {
    if (this.persist) writeStorage(this.storageKey, this.sessions);
  }

  async list(): Promise<Session[]> {
    return [...this.sessions].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.find((s) => s.id === id);
  }

  async save(session: Session): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) this.sessions[idx] = session;
    else this.sessions.push(session);
    this.flush();
  }

  async delete(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.flush();
  }

  async setSummary(id: string, summary: SessionSummary): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    await this.save({ ...s, summary });
  }

  async setActionItems(id: string, items: ActionItem[]): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    await this.save({ ...s, actionItems: items });
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    await this.save({ ...s, starred });
  }

  async rename(id: string, title: string): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    await this.save({ ...s, title });
  }
}
