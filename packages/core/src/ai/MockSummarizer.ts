/**
 * MockSummarizer — backwards-compatible alias for `HeuristicSummarizer`.
 *
 * Older code paths and external embedders still import `MockSummarizer`
 * directly. We keep the symbol around so those imports keep working,
 * but the implementation now defers to the multilingual heuristic
 * summariser — same `ISummarizer` contract, same streaming events, but
 * the actual content is useful in any of the supported languages
 * (en, tr, de, es, fr, it).
 *
 * @deprecated Prefer `HeuristicSummarizer` directly. This re-export
 *             will stay for one release cycle.
 */
import {
  HeuristicSummarizer,
  type HeuristicSummarizerOptions,
} from "./HeuristicSummarizer.js";

export type MockSummarizerOptions = HeuristicSummarizerOptions & {
  /**
   * Legacy option from the original mock implementation. Currently
   * ignored; the heuristic summariser produces deterministic output
   * by design. Kept here so existing TypeScript call-sites compile.
   */
  jitter?: boolean;
};

export class MockSummarizer extends HeuristicSummarizer {
  constructor(opts: MockSummarizerOptions = {}) {
    // Drop legacy fields that don't map to the new options surface.
    const { jitter: _jitter, ...rest } = opts;
    super({
      label: "Voxnap (on-device)",
      ...rest,
    });
  }
}
