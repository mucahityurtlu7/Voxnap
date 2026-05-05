import type { Session, SessionSummary, ActionItem } from "../types.js";

/**
 * Persistence-agnostic session storage.
 *
 * The default implementation is in-memory (with a localStorage adapter
 * sprinkled on top for the web). Apps may swap in a Tauri-backed store
 * later without touching the UI.
 */
export interface ISessionStore {
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;

  /** Convenience patches; emitted as full `save` from the UI side. */
  setSummary(id: string, summary: SessionSummary): Promise<void>;
  setActionItems(id: string, items: ActionItem[]): Promise<void>;
  setStarred(id: string, starred: boolean): Promise<void>;
  rename(id: string, title: string): Promise<void>;
}
