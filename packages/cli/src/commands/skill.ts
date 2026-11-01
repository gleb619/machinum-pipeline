import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { atomicWriteFile } from '@mt/core'
import { SKILL_MD, SKILL_SOURCE, SKILL_VERSION } from '../generated/skill-content.js'

const FILE_NAME = 'SKILL.md'

/** Agent skill folders (relative to cwd) used by `--install --target`. Keep this table small. */
export const SKILL_TARGETS = {
  agents: '.agent/skills/mt',
  claude: '.claude/skills/mt',
  codex: '.codex/skills/mt',
  opencode: '.opencode/skills/mt',
} as const

type SkillTarget = keyof typeof SKILL_TARGETS

const USAGE = `Usage: mt skill [options]

Print the embedded agent skill (SKILL.md) for this mt version to stdout.

Options:
  --out <file>        Write the skill to <file> (atomic, parent dirs created)
  --install [dir]     Write <dir>/SKILL.md (default dir: ${SKILL_TARGETS.agents})
  --target <name>     With --install: preset dir (${Object.keys(SKILL_TARGETS).join('|')})
  --force             Overwrite an existing file
  --path              Print the skill version and where the embedded copy came from
  -h, --help          Show this help

Examples:
  mt skill > .agent/skills/mt/SKILL.md
  mt skill --install --target claude     # .claude/skills/mt/SKILL.md
`

interface SkillOptions {
  help: boolean
  path: boolean
  force: boolean
  out?: string
  install: boolean
  installDir?: string
  target?: SkillTarget
}

function fail(message: string): never {
  throw new Error(message)
}

function isTarget(value: string): value is SkillTarget {
  return Object.hasOwn(SKILL_TARGETS, value)
}

function parseArgs(args: string[]): SkillOptions {
  const options: SkillOptions = { help: false, path: false, force: false, install: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--path':
        options.path = true
        break
      case '--force':
        options.force = true
        break
      case '--out': {
        const value = args[i + 1]
        if (value === undefined || value.startsWith('-')) fail('Option --out requires a file')
        options.out = value
        i++
        break
      }
      case '--target': {
        const value = args[i + 1]
        if (value === undefined) fail('Option --target requires a value')
        if (!isTarget(value)) {
          fail(`Unknown target: ${value} (expected ${Object.keys(SKILL_TARGETS).join('|')})`)
        }
        options.target = value
        i++
        break
      }
      case '--install': {
        options.install = true
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          options.installDir = next
          i++
        }
        break
      }
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
        fail(`Unexpected argument: ${arg}`)
    }
  }
  if (options.target && !options.install) fail('Option --target requires --install')
  if (options.target && options.installDir) fail('Use either --target or an explicit --install dir')
  if (options.install && options.out) fail('Use either --install or --out, not both')
  return options
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function writeSkill(file: string, force: boolean): Promise<void> {
  if (!force && (await exists(file))) {
    fail(`${file} already exists (use --force to overwrite)`)
  }
  await mkdir(dirname(file), { recursive: true })
  await atomicWriteFile(file, SKILL_MD)
  console.error(`Wrote ${file} (skill-version ${SKILL_VERSION})`)
}

/**
 * `mt skill` - print or install the agent skill embedded at build time from docs/SKILL.md.
 * stdout carries only the skill content; every notice goes to stderr.
 */
export async function skillCommand(args: string[]): Promise<void> {
  try {
    const options = parseArgs(args)
    if (options.help) {
      console.log(USAGE)
      return
    }
    if (options.path) {
      console.log(`${SKILL_SOURCE} (embedded at build time) skill-version ${SKILL_VERSION}`)
      return
    }
    if (options.out) {
      await writeSkill(resolve(process.cwd(), options.out), options.force)
      return
    }
    if (options.install) {
      const dir = options.target
        ? SKILL_TARGETS[options.target]
        : (options.installDir ?? SKILL_TARGETS.agents)
      await writeSkill(join(resolve(process.cwd(), dir), FILE_NAME), options.force)
      return
    }
    process.stdout.write(SKILL_MD)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
