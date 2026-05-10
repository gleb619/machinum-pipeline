import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

// ── Typo dictionary (~100 common misspellings) ──────────────────────────
const TYPO_DICT: Record<string, string[]> = {
  recieve: ['receive'],
  accomodate: ['accommodate'],
  occured: ['occurred'],
  definately: ['definitely'],
  goverment: ['government'],
  arguement: ['argument'],
  beleive: ['believe'],
  calender: ['calendar'],
  commitee: ['committee'],
  concious: ['conscious'],
  curiousity: ['curiosity'],
  embarass: ['embarrass'],
  enviroment: ['environment'],
  existance: ['existence'],
  familar: ['familiar'],
  finaly: ['finally'],
  foriegn: ['foreign'],
  foward: ['forward'],
  freind: ['friend'],
  futher: ['further'],
  grammer: ['grammar'],
  gaurd: ['guard'],
  happend: ['happened'],
  heros: ['heroes'],
  hinderance: ['hindrance'],
  honourable: ['honorable'],
  humourous: ['humorous'],
  idiosyncracy: ['idiosyncrasy'],
  immediatly: ['immediately'],
  independant: ['independent'],
  inteligence: ['intelligence'],
  interupt: ['interrupt'],
  irresistable: ['irresistible'],
  knowlege: ['knowledge'],
  libary: ['library'],
  liscence: ['licence', 'license'],
  maintainance: ['maintenance'],
  millenium: ['millennium'],
  miniture: ['miniature'],
  mischeivous: ['mischievous'],
  neccessary: ['necessary'],
  neice: ['niece'],
  noticable: ['noticeable'],
  ocassion: ['occasion'],
  occassionally: ['occasionally'],
  ocurrance: ['occurrence'],
  paralel: ['parallel'],
  particuarly: ['particularly'],
  peice: ['piece'],
  persistant: ['persistent'],
  personel: ['personnel'],
  posession: ['possession'],
  preceed: ['precede'],
  preffer: ['prefer'],
  priviledge: ['privilege'],
  publically: ['publicly'],
  questionaire: ['questionnaire'],
  reccomend: ['recommend'],
  refered: ['referred'],
  relevent: ['relevant'],
  religous: ['religious'],
  remeber: ['remember'],
  resistence: ['resistance'],
  restaraunt: ['restaurant'],
  rythm: ['rhythm'],
  scedule: ['schedule'],
  scisors: ['scissors'],
  sentance: ['sentence'],
  seperate: ['separate'],
  successfull: ['successful'],
  supercede: ['supersede'],
  suprise: ['surprise'],
  tatoo: ['tattoo'],
  tendancy: ['tendency'],
  therefor: ['therefore'],
  threshhold: ['threshold'],
  tommorow: ['tomorrow'],
  tounge: ['tongue'],
  truely: ['truly'],
  unforgetable: ['unforgettable'],
  unfortunatly: ['unfortunately'],
  untill: ['until'],
  usefull: ['useful'],
  vacinity: ['vicinity'],
  vegitable: ['vegetable'],
  visable: ['visible'],
  warrent: ['warrant'],
  wendsday: ['wednesday', 'Wednesday'],
  wierd: ['weird'],
  writting: ['writing'],
  yeild: ['yield'],
  acheive: ['achieve'],
  adress: ['address'],
  alot: ['a lot'],
  begining: ['beginning'],
  buisness: ['business'],
  comming: ['coming'],
  decieve: ['deceive'],
  experiance: ['experience'],
  greatful: ['grateful'],
  harrass: ['harass'],
  indite: ['indict'],
  lonly: ['lonely'],
  mispell: ['misspell'],
  noteriety: ['notoriety'],
  pharoah: ['pharaoh'],
  pronounciation: ['pronunciation'],
  rehersal: ['rehearsal'],
  seige: ['siege'],
  similiar: ['similar'],
  specfic: ['specific'],
  strenght: ['strength'],
  suceed: ['succeed'],
  unconcious: ['unconscious'],
  vaccum: ['vacuum'],
  wierless: ['wireless'],
}

// ── Zero-width character ranges ────────────────────────────────────────
const ZERO_WIDTH_RANGES: [number, number][] = [
  [0x200b, 0x200d], // zero-width space, non-joiner, joiner
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
]

function isZeroWidth(codePoint: number): boolean {
  return ZERO_WIDTH_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
}

function isForbiddenControl(codePoint: number): boolean {
  // U+0000..U+001F except tab(9), LF(10), CR(13)
  return codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d
}

// ── Typo Detector Tool ──────────────────────────────────────────────────

interface TypoEntry {
  word: string
  line: number
  suggestions: string[]
}

export const typoDetector = defineTool<string, string>({
  name: 'typo-detector',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const text = env.item
    const lines = text.split('\n')
    const typos: TypoEntry[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      const words = line.split(/\b/)
      for (const word of words) {
        const lower = word.toLowerCase()
        if (TYPO_DICT[lower]) {
          typos.push({
            word: lower,
            line: i + 1,
            suggestions: TYPO_DICT[lower] as string[],
          })
        }
      }
    }

    return {
      item: env.item,
      meta: {
        ...env.meta,
        typos,
      },
    }
  },
})

// ── Forbidden Character Detector Tool ───────────────────────────────────

interface ForbiddenEntry {
  char: string
  codePoint: number
  pos: number
  line: number
}

export const forbiddenCharDetector = defineTool<string, string>({
  name: 'forbidden-char-detector',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const text = env.item
    const lines = text.split('\n')
    const forbidden: ForbiddenEntry[] = []
    let globalPos = 0

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] as string
      for (let col = 0; col < line.length; col++) {
        const char = line[col] as string
        const codePoint = char.codePointAt(0)
        if (codePoint === undefined) continue

        if (isZeroWidth(codePoint) || isForbiddenControl(codePoint)) {
          forbidden.push({
            char,
            codePoint,
            pos: globalPos + col,
            line: lineIdx + 1,
          })
        }
      }
      globalPos += line.length + 1 // +1 for the newline
    }

    return {
      item: env.item,
      meta: {
        ...env.meta,
        forbidden,
      },
    }
  },
})

// ── Grammar Warnings Tool ───────────────────────────────────────────────

interface GrammarIssue {
  type: string
  message: string
  line: number
}

const PASSIVE_PATTERN = /\b(was|were|is|are|been|being)\s+\w+(ed|en|t)\b/gi
const REPEATED_WORD_PATTERN = /\b(\w+)\s+\1\b/gi

function splitSentences(text: string): { sentence: string; startLine: number }[] {
  const lines = text.split('\n')
  const results: { sentence: string; startLine: number }[] = []
  let current = ''
  let startLine = 1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // Split line on sentence-ending punctuation followed by space or end
    const parts = line.split(/(?<=[.!?])\s+/)
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p] as string
      if (p === 0 && current.length > 0) {
        current += ` ${part}`
      } else if (p === 0) {
        current = part
        startLine = i + 1
      } else {
        // New sentence starting mid-line
        if (current.trim()) {
          results.push({ sentence: current.trim(), startLine })
        }
        current = part
        startLine = i + 1
      }
    }
  }
  if (current.trim()) {
    results.push({ sentence: current.trim(), startLine })
  }
  return results
}

export const grammarWarnings = defineTool<string, string>({
  name: 'grammar-warnings',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const text = env.item
    const lines = text.split('\n')
    const issues: GrammarIssue[] = []

    // 1. Passive voice detection (line-based)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      PASSIVE_PATTERN.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = PASSIVE_PATTERN.exec(line)) !== null) {
        issues.push({
          type: 'passive-voice',
          message: `Possible passive voice: "${match[0]}"`,
          line: i + 1,
        })
      }
    }

    // 2. Sentence length check (>40 words)
    const sentences = splitSentences(text)
    for (const { sentence, startLine } of sentences) {
      const wordCount = sentence.split(/\s+/).filter((w) => w.length > 0).length
      if (wordCount > 40) {
        issues.push({
          type: 'long-sentence',
          message: `Sentence has ${wordCount} words (>40): "${sentence.slice(0, 80)}..."`,
          line: startLine,
        })
      }
    }

    // 3. Repeated words (line-based)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      REPEATED_WORD_PATTERN.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = REPEATED_WORD_PATTERN.exec(line)) !== null) {
        issues.push({
          type: 'repeated-word',
          message: `Repeated word: "${match[1]}" on line ${i + 1}`,
          line: i + 1,
        })
      }
    }

    return {
      item: env.item,
      meta: {
        ...env.meta,
        grammarIssues: issues,
      },
    }
  },
})
