/**
 * Deterministic passage extraction for `tako_contents(query=…)` on web page
 * text. No LLM, no backend change: the worker fetches the (up to 1M-char)
 * extracted page text and slices out the windows around query matches, so an
 * agent lands on the relevant section of a long filing in ONE call instead of
 * fetch → got-the-cover-page → refetch.
 *
 * Matching is two-tier: the full query phrase first (case-insensitive); when
 * the phrase never occurs, each individual term (≥ MIN_TERM_LEN chars) is
 * matched instead — a query like "RevPAR occupancy 2024" still lands on
 * sections mentioning any of its terms. When nothing matches at all, the
 * result says so explicitly and carries the head of the document — a
 * deterministic "not on this page" verdict, not a silent empty string.
 *
 * `_`-prefixed so the registry codegen (`gen-registry.ts`) skips it.
 */

// Chars kept on each side of a match. Two windows closer than this merge.
const WINDOW = 1500;
// Ceiling on returned passages — bounds the response even on a page where
// the query matches everywhere.
const MAX_PASSAGES = 8;
// Total match budget. The phrase tier uses it whole; the per-term fallback
// splits it EVENLY across terms (floor(MAX/terms), min 1 each) so a common
// term can never starve a rare one out of the candidate set. Enough to
// saturate MAX_PASSAGES while keeping the scan bounded on degenerate inputs.
const MAX_MATCHES = 64;
// Terms shorter than this are noise ("of", "in", "Q1"→"Q1" is 2… keep 2+ digits
// out too) — only used in the per-term fallback tier.
const MIN_TERM_LEN = 3;
// Head slice returned when nothing matches, so the agent still sees what the
// page IS about before deciding the next step.
const NO_MATCH_HEAD_CHARS = 2000;

export interface PassageResult {
  /** The model-facing replacement for the full page text. */
  data: string;
  /** Whether any passage matched (false → `data` is the no-match notice + head). */
  matched: boolean;
  /** Whether any of the page text was omitted from `data`. */
  truncated: boolean;
}

/**
 * Occurrence indices of `needle` in `haystack` (both pre-lowercased), capped
 * at `max` kept hits. Scans one PAST the cap so `capped` distinguishes
 * "exactly max occurrences" from "more exist" (an honest "N+" header).
 */
function occurrences(
  haystack: string,
  needle: string,
  max: number,
): { hits: number[]; capped: boolean } {
  const hits: number[] = [];
  if (needle.length === 0) return { hits, capped: false };
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    if (hits.length === max) return { hits, capped: true };
    hits.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return { hits, capped: false };
}

/** Merge sorted [start,end) windows that overlap or touch. */
function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of windows) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], end)];
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Extract the passages of `text` around case-insensitive matches of `query`.
 * Pure and deterministic — see module docs for the matching tiers.
 */
export function extractPassages(text: string, query: string): PassageResult {
  const lowerText = text.toLowerCase();
  const phrase = query.trim().toLowerCase();

  let saturated = false;
  const phraseScan = occurrences(lowerText, phrase, MAX_MATCHES);
  saturated = phraseScan.capped;
  let hits = phraseScan.hits;
  let tier = `the phrase "${query.trim()}"`;
  if (hits.length === 0) {
    const terms = [...new Set(
      phrase.split(/[^\p{L}\p{N}%$]+/u).filter((t) => t.length >= MIN_TERM_LEN),
    )];
    // Split the match budget EVENLY across terms rather than pooling and
    // position-slicing: a common term ("occupancy", "2024") occurring early
    // must never starve a rare term ("RevPAR") of its slots — the rare term
    // is usually the one carrying the figure the caller wants, and dropping
    // it silently while reporting matched:true is worse than a clean miss.
    const perTerm = Math.max(1, Math.floor(MAX_MATCHES / Math.max(1, terms.length)));
    saturated = false;
    hits = terms
      .flatMap((t) => {
        const scan = occurrences(lowerText, t, perTerm);
        saturated = saturated || scan.capped;
        return scan.hits;
      })
      .sort((a, b) => a - b);
    if (hits.length > MAX_MATCHES) {
      saturated = true;
      hits = hits.slice(0, MAX_MATCHES);
    }
    tier = `terms of "${query.trim()}"`;
  }

  if (hits.length === 0) {
    const head = text.slice(0, NO_MATCH_HEAD_CHARS);
    return {
      data: [
        `[tako_contents] Query "${query.trim()}" NOT FOUND in this page's text (${text.length} chars scanned, phrase and per-term). Treat this as a deterministic miss for this page — do not refetch it with a reworded query; try a different url. The first ${head.length} chars follow for orientation:`,
        "",
        head,
      ].join("\n"),
      matched: false,
      truncated: text.length > head.length,
    };
  }

  const windows = mergeWindows(
    hits.map((i): [number, number] => [Math.max(0, i - WINDOW), Math.min(text.length, i + WINDOW)]),
  ).slice(0, MAX_PASSAGES);

  const passages = windows.map(([start, end]) => {
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return `${prefix}${text.slice(start, end)}${suffix}`;
  });
  const covered = windows.reduce((sum, [start, end]) => sum + (end - start), 0);
  const header =
    `[tako_contents] ${hits.length}${saturated ? "+" : ""} match(es) for ${tier} — ` +
    `${passages.length} passage(s) extracted from ${text.length} chars of page text. ` +
    `Omit \`query\` to fetch the full text instead.`;

  return {
    data: [header, "", passages.join("\n\n[…]\n\n")].join("\n"),
    matched: true,
    truncated: covered < text.length,
  };
}
