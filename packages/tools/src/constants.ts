/**
 * Single source of truth for text-processing constants (splitting, token budgets,
 * word lengths, verification thresholds). Tools import from here — never redefine
 * the same value locally.
 */

// ---------------------------------------------------------------------------
// Series splitting
// ---------------------------------------------------------------------------

export const SERIES_SPLIT_STRATEGY = 'balanced'
/**
 * Balanced-strategy target: chapters whose meaningful body exceeds this many
 * characters are split into parts of approximately this size
 * (parts = ceil(bodyChars / target)). Chapters at or below the target stay whole.
 */
export const SERIES_SPLIT_TARGET_CHARS = 10_000

// ---------------------------------------------------------------------------
// Tokens / budgets
// ---------------------------------------------------------------------------

export const TOKEN_ENCODING = 'cl100k_base'
export const CHARS_PER_TOKEN_HEURISTIC = 4
export const DEFAULT_MAX_TOKENS = 12_000
export const DEFAULT_CHUNK_TARGET = 6_000
export const DEFAULT_OUTPUT_RESERVE = 2_048
/** Summary-specific fallback; deliberately smaller than DEFAULT_OUTPUT_RESERVE. */
export const SUMMARY_OUTPUT_RESERVE = 1_024
export const CHUNK_SAFETY_RESERVE_TOKENS = 64
export const PROMPT_OVERHEAD_SLACK_TOKENS = 8
export const REASONING_RESERVE_HIGH_TOKENS = 8_000
export const REASONING_RESERVE_LOW_TOKENS = 4_000
export const TRANSLATE_SYSTEM_FALLBACK_TOKENS = 200
export const TRANSLATE_PREFIX_FALLBACK_TOKENS = 100

// ---------------------------------------------------------------------------
// Chunking / splitting
// ---------------------------------------------------------------------------

export const DEFAULT_LINE_MAX_TOKENS = 2_000
export const DEFAULT_SENTENCE_MAX_CHARS = 4_000
export const DEFAULT_OVERLAP_CHARS = 0
export const BALANCE_ALLOWED_DEVIATION = 0.05
export const DEFAULT_CHUNK_SEPARATOR = '---'
export const DEFAULT_CHUNK_CONCURRENCY = 2
export const GLOSSARY_CORPUS_MAX_CHARS = 12_000

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

export const SENTENCE_END_RE = /[.!?](?:\s|$)/g
export const MIN_SENTENCE_WORDS = 4
export const SUMMARY_SENTENCE_COUNT = 4
export const REPEATED_SENTENCE_MIN_COUNT = 2

// ---------------------------------------------------------------------------
// Words / names
// ---------------------------------------------------------------------------

export const WORD_CHAR_CLASS = '\\p{L}\\p{N}_'
export const DECORATIVE_LINE_RE = /^[\s*~=_\-#+•·■-◿★☆※♦—–.]{3,}$/
export const MAX_TITLE_LINE_LENGTH = 120
export const BRACKET_TERM_MIN_CHARS = 2
export const BRACKET_TERM_MAX_CHARS = 60
export const BRACKET_TERM_MAX_WORDS = 5
export const QUOTED_NAME_MIN_CHARS = 2
export const QUOTED_NAME_MAX_CHARS = 40
export const WORDLIST_CELL_MAX_CHARS = 64
export const GLOSSARY_MAX_REFS_PER_TERM = 12
export const REF_GRAPH_MAX_HOPS = 3

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Max chars of a logged text before it is truncated (start + "..." + end + length). */
export const LOG_TEXT_MAX_LENGTH = 200

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export const DEFAULT_NOTE_COUNT = 10
export const MIN_TERM_COVERAGE = 0.15
export const MIN_TERMS_FOR_COVERAGE = 5
export const SUMMARY_MIN_BODY_WORDS = 40

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const MIN_CYRILLIC_RATIO = 0.3
export const MAX_UNTRANSLATED_SHARE = 0.3
export const UNTRANSLATED_MIN_LETTERS = 20
export const PARITY_ABS_TOLERANCE = 0.005
export const PARITY_REL_TOLERANCE = 0.15
export const MAX_ISSUES_IN_ERROR = 3
export const MAX_ISSUES_IN_FEEDBACK = 5

// ---------------------------------------------------------------------------
// Frequency / glossary mining
// ---------------------------------------------------------------------------

export const STAT_FREQ_TOP_K = 500
export const STAT_FREQ_MAX_NGRAM = 3
export const STAT_FREQ_MIN_WORD_LENGTH = 1
export const STAT_DICT_TOP_K = 100
export const STAT_DICT_MIN_COUNT = 3
export const GLOSSARY_MIN_COUNT = 2
export const GLOSSARY_ALWAYS_CAP_MIN_COUNT = 3
export const MAX_ENTITIES = 200
export const VOCABULARY_DEFAULT_LIMIT = 40
export const VOCABULARY_MAX_LIMIT = 300
export const MAX_SCHEMA_LINES = 80
export const FREQUENT_TERMS_LIMIT = 20
