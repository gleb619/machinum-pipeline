/**
 * Canonical category names for `@mt/tools`.
 *
 * `category([...])` annotations are dev markers: grep `category([` or run
 * `pnpm annotations --kind category` to find tools by role. They carry no
 * runtime behaviour and are optional for user-defined tools.
 */
export const TOOL_CATEGORIES = Object.freeze([
  'validator',
  'normalizer',
  'formatter',
  'translator',
  'extractor',
  'statistics',
  'splitter',
  'serializer',
  'llm',
  'analyzer',
  'stub',
  'pipeline',
] as const)

export type ToolCategory = (typeof TOOL_CATEGORIES)[number]
