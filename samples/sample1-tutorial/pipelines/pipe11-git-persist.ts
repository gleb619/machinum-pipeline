import { definePipeline, defineProcess, log, registry } from '@mt/core'
import { createGitCommit, createGitStage } from '@mt/tools'
import { createGitWorktreeTarget } from '@mt/waypoint'
import '@mt/waypoint'

/**
 * PIPE 11 — persist pipeline output through git.
 *
 * Two mechanisms, one file:
 *
 *   1. git:// target waypoint: writes through an inner scheme (here `jsonl`) inside a
 *      temporary git worktree; `commit=on-close` auto-commits the worktree branch and
 *      fast-forward merges it into the base branch when the target closes.
 *   2. git tools from `@mt/tools` (`gitStage`, `gitCommit`): commit files the pipeline
 *      itself wrote, with the message coming either from the tool options or from the
 *      envelope meta (`meta.commitMessage`). The generated-default message path
 *      (`mt(<pipelineId>): <n> envelopes`) is covered by the `@mt/tools` unit tests and
 *      is not demoed here.
 *
 * Run from the sample dir (all `runner:*` scripts do):
 *
 *   mt run ./pipelines/pipe11-git-persist.ts                       # section 1 (default)
 *   mt run ./pipelines/pipe11-git-persist.ts --pipeline explicitCommitPipeline
 *   mt run ./pipelines/pipe11-git-persist.ts --pipeline metaCommitPipeline
 *
 * Everything lands under `out-git/` of this sample, so the git tools' pathspecs stay
 * scoped to `./out-git/…` and never touch the rest of the repository. The `out-git/`
 * directory ships in the repo (`.gitkeep`) because the jsonl target does not create
 * missing directories — and it is deliberately NOT gitignored, since the git tools
 * commit its contents.
 */

/**
 * Section 2a — commit message via tool options.
 *
 * A `.to()` step is a sink: the stream ends there and nothing can commit after it inside
 * the same pipeline. So this flow is a two-member process: the first member writes
 * `out-git/commits-explicit.jsonl`, the second commits it with an explicit message.
 */
const explicitWriteStage = definePipeline({ id: 'pipe11-commit-explicit-write' })
  .from('range://1..3')
  .flatMap(async (n: unknown) => [`explicit line ${String(n)}`])
  .to('jsonl://./out-git/commits-explicit.jsonl')

const explicitCommitStage = definePipeline({ id: 'pipe11-commit-explicit-commit' })
  .from('range://1..1')
  .use(
    createGitCommit({
      message: 'mt(pipe11): persist tutorial output (explicit message)',
      pathspecs: ['./out-git/commits-explicit.jsonl'],
    }),
  )
  .tap((env) => {
    log.info('pipe11 explicit commit', { commit: env.meta.commit ?? null })
  })
  .to('void://')

export const explicitCommitPipeline = defineProcess([explicitWriteStage, explicitCommitStage], {
  id: 'pipe11-commit-explicit',
})

/**
 * Section 2b + 3 — commit message via `meta.commitMessage`, staging via `gitStage`.
 *
 * Same two-stage shape as section 2a, but the commit stage resolves its message from
 * `meta.commitMessage` (set in the tap) because no message option is given, and the
 * staging is done by `gitStage` with explicit pathspecs; `gitCommit` runs with
 * `stage: false` and commits exactly what `gitStage` staged.
 */
const metaWriteStage = definePipeline({ id: 'pipe11-commit-meta-write' })
  .from('range://1..3')
  .flatMap(async (n: unknown) => [`meta line ${String(n)}`])
  .to('jsonl://./out-git/commits-meta.jsonl')

const metaCommitStage = definePipeline({ id: 'pipe11-commit-meta-commit' })
  .from('range://1..1')
  .tap((env) => {
    // `gitCommit` reads `meta.commitMessage` when no message option is given.
    env.meta.commitMessage = 'mt(pipe11): persist tutorial output (meta message)'
  })
  .use(createGitStage({ pathspecs: ['./out-git/commits-meta.jsonl'] }))
  .tap((env) => {
    log.info('pipe11 staged', { staged: env.meta.gitStaged ?? 0 })
  })
  .use(createGitCommit({ stage: false }))
  .tap((env) => {
    log.info('pipe11 meta commit', { commit: env.meta.commit ?? null })
  })
  .to('void://')

export const metaCommitPipeline = defineProcess([metaWriteStage, metaCommitStage], {
  id: 'pipe11-commit-meta',
})

/**
 * Section 1 (default pipeline): persist through the git worktree waypoint.
 *
 *   range://1..3 → git://…?via=jsonl&branch=mt-pipe11&commit=on-close
 *
 * On open, the target creates a worktree at `<repo>/worktrees/mt-pipe11` on a new branch
 * `mt-pipe11`; the inner `jsonl` target writes `worktree.jsonl` at the worktree root (keep
 * the URI path flat — `./`-prefixed, see below — and note the inner target does not create
 * nested directories). On close, the branch is auto-committed, rebased onto the base
 * branch, fast-forward merged (visible as a merge line in `git log --oneline`) and the
 * worktree is removed. The merged file appears at `<repo>/worktree.jsonl`. A rerun works
 * because the merged branch is deleted on close.
 *
 * Note: the `git://` waypoint anchors the repo at the process working directory — always
 * run this pipe from the sample dir (the `runner:*` scripts and `mt run` invocations do).
 * The URI path must start with `./`: a bare `git://worktree.jsonl` parses `worktree.jsonl`
 * as the URI host and the inner target then writes next to the project, not in the worktree.
 */
const GIT_PERSIST_URI = 'git://./worktree.jsonl?via=jsonl&branch=mt-pipe11&commit=on-close'

export const gitPersistPipeline = definePipeline({ id: 'pipe11-git-persist' })
  .from('range://1..3')
  .flatMap(async (n: unknown) => [`persisted line ${String(n)}`])
  .tap((env) => {
    log.info('pipe11 persist', { item: env.item })
  })
  // Pass the resolved Target instance (not the URI string): the string form is re-resolved
  // by the Runner from the target's own `.uri`, which currently mangles the query string
  // and silently drops `commit=on-close` (detached worktree, no merge — see kanban T288).
  // The instance keeps the parsed `commit=on-close` intact.
  .to(createGitWorktreeTarget(registry.parse(GIT_PERSIST_URI)))

export default gitPersistPipeline
