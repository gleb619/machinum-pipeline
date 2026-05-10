import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface FixerInput {
  text: string
}

export interface FixerOutput {
  text: string
  changes: number
}

export interface EntityNormalizerInput {
  text: string
}

export interface EntityNormalizerOutput {
  text: string
  replacements: number
}

export interface MarkdownFormatterInput {
  text: string
}

export interface MarkdownFormatterOutput {
  text: string
  fixes: number
}

// ---------------------------------------------------------------------------
// Built-in typo dictionary (lowercase key → correction)
// ---------------------------------------------------------------------------

const TYPO_DICT: Record<string, string> = {
  teh: 'the',
  recieve: 'receive',
  adress: 'address',
  seperate: 'separate',
  ocurred: 'occurred',
  untill: 'until',
  beggining: 'beginning',
  goverment: 'government',
  enviroment: 'environment',
  necesary: 'necessary',
  occassion: 'occasion',
  accomodate: 'accommodate',
  definately: 'definitely',
  independant: 'independent',
  wierd: 'weird',
  calender: 'calendar',
  arguement: 'argument',
  maintainance: 'maintenance',
  priviledge: 'privilege',
  relevent: 'relevant',
  cemetary: 'cemetery',
  concious: 'conscious',
  curiousity: 'curiosity',
  embarass: 'embarrass',
  existance: 'existence',
  experiance: 'experience',
  foriegn: 'foreign',
  greatful: 'grateful',
  guarentee: 'guarantee',
  harrass: 'harass',
  heigth: 'height',
  immediatly: 'immediately',
  inteligent: 'intelligent',
  knowlege: 'knowledge',
  lisence: 'licence',
  neice: 'niece',
  noticable: 'noticeable',
  ocassion: 'occasion',
  occurance: 'occurrence',
  peice: 'piece',
  persistant: 'persistent',
  questionaire: 'questionnaire',
  religous: 'religious',
  resistence: 'resistance',
  rhythem: 'rhythm',
  sargeant: 'sergeant',
  sherbert: 'sherbet',
  similiar: 'similar',
  supercede: 'supersede',
  tomorow: 'tomorrow',
  truely: 'truly',
  unforseen: 'unforeseen',
  unfortunatly: 'unfortunately',
  vaccum: 'vacuum',
  visable: 'visible',
  wether: 'whether',
  writting: 'writing',
}

// ---------------------------------------------------------------------------
// Tool 1: Typo Fixer
// ---------------------------------------------------------------------------

export const typoFixer = defineTool<FixerInput, FixerOutput>({
  name: 'typo-fixer',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(env: Envelope<FixerInput>, _ctx: ToolContext): Promise<Envelope<FixerOutput>> {
    const { text } = env.item
    let result = text
    let changes = 0

    // Word-boundary replacement to avoid partial-word matches
    for (const [wrong, correct] of Object.entries(TYPO_DICT)) {
      const regex = new RegExp(`\\b${escapeRegex(wrong)}\\b`, 'gi')
      let localChanges = 0
      result = result.replace(regex, () => {
        localChanges++
        return correct
      })
      changes += localChanges
    }

    return {
      item: { text: result, changes },
      meta: {
        ...env.meta,
        typoFixed: true,
        changes,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 2: Entity Normalizer
// ---------------------------------------------------------------------------

export const entityNormalizer = defineTool<EntityNormalizerInput, EntityNormalizerOutput>({
  name: 'entity-normalizer',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(
    env: Envelope<EntityNormalizerInput>,
    _ctx: ToolContext,
  ): Promise<Envelope<EntityNormalizerOutput>> {
    const { text } = env.item
    const entityMap = (env.meta?.entityMap as Record<string, string>) ?? {}
    let result = text
    let replacements = 0

    for (const [before, after] of Object.entries(entityMap)) {
      if (!before) continue
      const regex = new RegExp(escapeRegex(before), 'g')
      let local = 0
      result = result.replace(regex, () => {
        local++
        return after
      })
      replacements += local
    }

    return {
      item: { text: result, replacements },
      meta: {
        ...env.meta,
        normalized: true,
        replacements,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Tool 3: Markdown Formatter
// ---------------------------------------------------------------------------

export const markdownFormatter = defineTool<MarkdownFormatterInput, MarkdownFormatterOutput>({
  name: 'markdown-formatter',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(
    env: Envelope<MarkdownFormatterInput>,
    _ctx: ToolContext,
  ): Promise<Envelope<MarkdownFormatterOutput>> {
    const { text } = env.item
    let result = text
    let fixes = 0

    // --- 1. Blank lines around fenced code blocks ---
    // Ensure blank line before opening ``` and after closing ```
    // Process from back to front so indices stay valid (we use regex)
    result = result.replace(/([^\n])\n(```)/g, (_m, before, fence) => {
      fixes++
      return `${before}\n\n${fence}`
    })
    result = result.replace(/(```)\n([^\n`])/g, (_m, fence, after) => {
      fixes++
      return `${fence}\n\n${after}`
    })
    // Also handle start-of-file fence
    result = result.replace(/^(```)/gm, (_m, fence) => {
      // Only fix if there's content on same line (unlikely but safe)
      return `${fence}`
    })

    // --- 2. Normalise unordered list markers ---
    // Replace mixed * - + markers with consistent `- `
    // We only touch lines that look like list items (indent + marker + space)
    result = result.replace(/^(\s*)[*+]\s/gm, '$1- ')
    // Count fixes: detect changes by comparing before/after (approximate)
    // Actually let's track fixes more carefully
    let listFixCount = 0
    result = result.replace(/^(\s*)[*+]\s/gm, () => {
      listFixCount++
      return '' // placeholder, we already replaced above
    })
    // Simpler: just apply and count
    const before = result
    result = result.replace(/^(\s*)[*+]\s/gm, '$1- ')
    if (before !== result) listFixCount += 1

    // --- 3. Fix indentation: tabs → 2 spaces (preserve code fences) ---
    let indentFixCount = 0
    const lines = result.split('\n')
    let inFence = false
    const fixedLines = lines.map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line // don't touch code blocks
      const replaced = line.replace(/\t/g, '  ')
      if (replaced !== line) indentFixCount++
      return replaced
    })
    result = fixedLines.join('\n')

    fixes += listFixCount + indentFixCount

    // Re-count actual code-fence blank-line fixes
    let fenceFixCount = 0
    const testBefore = text
    const _testAfter = result
    // We'll track fence fixes differently
    // Count how many fences don't have blank lines around them
    const fenceLines = testBefore.split('\n')
    for (let i = 0; i < fenceLines.length; i++) {
      const line = fenceLines[i] as string
      if (/^```/.test(line)) {
        // Opening fence: check line before
        if (i > 0 && (fenceLines[i - 1] as string).trim() !== '') {
          fenceFixCount++
        }
        // Closing fence: check line after
        if (
          i < fenceLines.length - 1 &&
          (fenceLines[i + 1] as string).trim() !== '' &&
          !/^```/.test(fenceLines[i + 1] as string)
        ) {
          fenceFixCount++
        }
      }
    }
    fixes = fenceFixCount + listFixCount + indentFixCount

    return {
      item: { text: result, fixes },
      meta: {
        ...env.meta,
        formatted: true,
        fixes,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
