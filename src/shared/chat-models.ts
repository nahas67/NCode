import type { ReasoningEffort } from './session.js';
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|(?:gpt-?)?6(?:\.0)?-(?:pro|astra))$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[] };

/**
 * The tiers Gemini Web itself offers, used only until a live Gemini tab reports its own
 * `<bard-mode-switcher>` through `MODELS_SYNC`. The host learns what an account really has from
 * that report; these are the shipped floor, so the picker is never empty and never names a
 * generation the product does not drive. The effort ladders match `deriveEfforts()` in
 * ncode-bridge.ts, so a synced model with no ladder of its own lands on the same shape.
 *
 * `aliases` carry the four `x-goog-ext-525001261-jspb` model-mode ids Gemini Web's mode switcher
 * itself uses. A scrape that reports one of those bare 16-hex ids resolves to its tier's label
 * instead of surfacing a meaningless row, and `resolveChatModel` matches aliases as exactly as it
 * matches ids — which also keeps this a four-row picker rather than eight.
 *
 * The id→tier pairing is positional and therefore the one unverified thing here: nothing in this
 * tree records which mode id is which. Resolvability does not depend on it, only the label a
 * given id resolves to. One id belongs to exactly one tier on purpose — `resolveChatModel` refuses
 * an id two entries both claim, which would make the hex id resolve to nothing.
 */
export const DEFAULT_GEMINI_MODELS: readonly ChatModelOption[] = [
  { id: 'gemini-3-fast', label: 'Fast', efforts: ['none'], aliases: ['fbb127bbb056c959'] },
  { id: 'gemini-3-thinking', label: 'Thinking', efforts: ['none', 'low', 'medium', 'high'], aliases: ['5bf011840784117a'] },
  { id: 'gemini-3-1-pro', label: 'Pro', efforts: ['none', 'low', 'medium', 'high'], aliases: ['9d8ca3786ebdfbea'] },
  { id: 'gemini-3-deep-think', label: 'Deep Think', efforts: ['none'], aliases: ['e6fa609c3fa255c0'] }
];

export const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-3-1-pro';

/**
 * The model Goal and Loop decisions run on unless Settings chose another.
 *
 * NCode's decisions are produced by Gemini Web, not by a ChatGPT connector, so the shipped
 * helper is a Gemini tier. An account that offers no Thinking lane falls back to Gemini's own
 * current selection (goal.ts).
 */
export const DEFAULT_HELPER_CHAT_MODEL = 'gemini-3-thinking';
/**
 * Exactly the shipped defaults from earlier builds; a config still holding one adopts the current
 * one (config.ts). The ChatGPT ids are here because they are what this file used to name, so an
 * install that never chose a helper migrates instead of persisting a model no Gemini tab can run.
 */
export const SUPERSEDED_HELPER_CHAT_MODELS: readonly string[] = ['gpt-5.6-sol', 'gpt-6-thinking', 'gpt-6'];
/** Pro silence policy follows the selected provider identity, including the older generation. */
export function isProModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return effort === 'pro' || isAstraModel(model, effort) || /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
}
/**
 * Whether this reasoning effort makes long silences normal.
 *
 * A model above `high` routinely goes minutes without touching the page between tool calls, and
 * the silence watchdog's two-minute window reads that as a dead tab. Pro is excluded here only
 * because it already has its own, wider window; `isProModel` covers it.
 *
 * `high` is deliberately **not** in this list. It is the ordinary effort for the current models —
 * the whole bridge suite uses it as the plain non-Pro case — and widening it would make a
 * genuinely dead page wait ten minutes instead of two. The harm this exists for was measured at
 * Extra high (#393): "An Extra-high turn that thinks longer than that between tool calls".
 *
 * Deliberately not "anything above medium as a number" either: the list is the vocabulary in
 * REASONING_EFFORTS, so a level added there has to be classified here on purpose rather than
 * inheriting a threshold nobody revisited.
 */
export function isDeliberateEffort(effort?: ReasoningEffort | null): boolean {
  return effort === 'xhigh' || effort === 'max' || effort === 'ultra';
}
const normalizeChatModelName = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '');
/**
 * Resolve a saved model value to one observed catalog entry.
 *
 * An exact execution id or lane alias wins. Otherwise a unique display-label match
 * resolves — settings saved before lanes had catalog ids, and labels the picker itself
 * shows (family "6" for gpt-6-pro), must round-trip or every saved default silently
 * falls back. An ambiguous label resolves to nothing: guessing a lane is not a
 * rounding decision.
 */
export function resolveChatModel(models: ChatModelOption[], value: string): ChatModelOption | undefined {
  const exact = models.filter(choice => choice.id === value || choice.aliases?.includes(value));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  // Labels became full names in 2.1.31 ("6" → "GPT-6", "5.6" → "GPT-5.6"); a value saved under the
  // older label still means the same family, so a leading "GPT" never decides the match.
  const bare = (text: string): string => normalizeChatModelName(text).replace(/^gpt(?=\d)/, '');
  const name = bare(value);
  const matches = name ? models.filter(choice => bare(choice.label) === name) : [];
  return matches.length === 1 ? matches[0] : undefined;
}
/** Keep the selected generation intact; Pro is already a complete model label. */
export function chatModelDisplayLabel(label: string, effort: ReasoningEffort, effortLabel: string): string {
  if (effort === 'pro') return /\bpro$/i.test(label) ? label : `${label.replace(/\s+Sol$/i, '')} Pro`;
  return `${label} · ${effortLabel}`;
}
export type ChatModelCatalog = {
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: ChatModelOption[];
  /**
   * The model the Gemini page reports as its own current selection, when it has said so.
   *
   * The page is the authority on which tier it is running; the picker's preference follows it
   * instead of guessing from labels. Absent until a tab reports, and never send authority on its own.
   */
  activeModel?: string | null;
  /** Request progress is not an account observation and never grants Send permission. */
  waiting?: string;
  error?: string;
};
