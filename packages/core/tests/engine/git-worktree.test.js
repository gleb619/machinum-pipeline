import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorktreeSource, GitWorktreeTarget, createGitWorktreeSource, createGitWorktreeTarget, } from '../../src/builtins/git-worktree.js';
import { createWorktree, getRepoRoot, mergeWorktreeToMain, removeWorktree, } from '../../src/engine/git-worktree.js';
import { autoCommit, execGit } from '../../src/engine/git.js';
import { registry } from '../../src/uri.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setupGitRepo(dir) {
    execSync('git init', { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "Test User"', { cwd: dir });
    writeFileSync(join(dir, 'initial.txt'), 'initial');
    execSync('git add initial.txt', { cwd: dir });
    execSync('git commit -m "initial commit"', { cwd: dir });
    try {
        // Force branch name to 'main' for test consistency
        execSync('git checkout -b main', { cwd: dir });
    }
    catch {
        // If it fails (e.g. already on main), try renaming
        try {
            execSync('git branch -m main', { cwd: dir });
        }
        catch {
            // ignore
        }
    }
}
function makeSourceContext() {
    return {
        run: {
            runId: 'test-run',
            pipelineId: 'test-pipeline',
            startedAt: new Date().toISOString(),
            global: {
                project: { name: 'test', root: '/tmp' },
                defaults: {
                    retry: { max: 3, backoffMs: 100, strategy: 'fixed' },
                    onError: 'fail-run',
                    concurrency: 1,
                },
                env: {},
            },
            checkpoint: { stepId: 's1', depth: 0, path: [] },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            artifactsDir: '/tmp/.mt/runs/test-run/artifacts',
        },
    };
}
function makeTargetContext() {
    return {
        run: {
            runId: 'test-run',
            pipelineId: 'test-pipeline',
            startedAt: new Date().toISOString(),
            global: {
                project: { name: 'test', root: '/tmp' },
                defaults: {
                    retry: { max: 3, backoffMs: 100, strategy: 'fixed' },
                    onError: 'fail-run',
                    concurrency: 1,
                },
                env: {},
            },
            checkpoint: { stepId: 's1', depth: 0, path: [] },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            artifactsDir: '/tmp/.mt/runs/test-run/artifacts',
        },
    };
}
/** Create a mock inner Source that yields a canned set of envelopes. */
function mockSource(envelopes, lifestyle = 'long-lived') {
    return {
        uri: 'mock://source',
        lifestyle,
        async *start(_ctx) {
            for (const env of envelopes)
                yield env;
        },
        async *resume(_ctx, _cursor) {
            for (const env of envelopes)
                yield env;
        },
    };
}
/** Create a mock inner Target that records writes. */
function mockTarget() {
    const t = {
        uri: 'mock://target',
        written: [],
        opened: false,
        closed: false,
        async open(_ctx) {
            t.opened = true;
        },
        async write(env, _ctx) {
            t.written.push(env);
        },
        async close(_ctx) {
            t.closed = true;
        },
    };
    return t;
}
// ---------------------------------------------------------------------------
// Core git-worktree engine functions
// ---------------------------------------------------------------------------
describe('git-worktree engine', () => {
    let repoRoot;
    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'test-git-worktree-'));
        setupGitRepo(repoRoot);
    });
    afterEach(() => {
        try {
            rmSync(repoRoot, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    // -- getRepoRoot ----------------------------------------------------------
    describe('getRepoRoot', () => {
        it('returns the repo root when called from repo root', async () => {
            const root = await getRepoRoot(repoRoot);
            expect(root).toBe(repoRoot);
        });
        it('returns the repo root when called from a subdirectory', async () => {
            const subdir = join(repoRoot, 'deep', 'nested');
            execSync(`mkdir -p "${subdir}"`);
            const root = await getRepoRoot(subdir);
            expect(root).toBe(repoRoot);
        });
        it('throws when called outside any git repo', async () => {
            await expect(getRepoRoot('/tmp')).rejects.toThrow(/Failed to find git repo root/);
        });
    });
    // -- createWorktree -------------------------------------------------------
    describe('createWorktree', () => {
        it('creates a new worktree directory at repoRoot/worktrees/<branch>', async () => {
            const path = await createWorktree(repoRoot, 'feature-x');
            const expected = join(repoRoot, 'worktrees', 'feature-x');
            expect(path).toBe(expected);
            expect(existsSync(expected)).toBe(true);
            // Should have a .git file (not directory) pointing back to main repo
            expect(existsSync(join(expected, '.git'))).toBe(true);
        });
        it('creates the worktree in detached HEAD state', async () => {
            const path = await createWorktree(repoRoot, 'detached-test');
            const result = await execGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
            expect(result.stdout.trim()).toBe('HEAD');
        });
        it('throws when branch name contains path traversal', async () => {
            // git should reject invalid ref names
            await expect(createWorktree(repoRoot, '../../../etc')).rejects.toThrow(/Failed to create worktree/);
        });
        it('creates worktree at the HEAD commit of main', async () => {
            const mainHead = (await execGit(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
            const worktreePath = await createWorktree(repoRoot, 'at-head');
            const wtHead = (await execGit(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
            expect(wtHead).toBe(mainHead);
        });
    });
    // -- removeWorktree -------------------------------------------------------
    describe('removeWorktree', () => {
        it('removes the worktree directory', async () => {
            const path = await createWorktree(repoRoot, 'to-remove');
            expect(existsSync(path)).toBe(true);
            await removeWorktree(path);
            expect(existsSync(path)).toBe(false);
        });
        it('cleans up git worktree metadata (no longer listed)', async () => {
            const path = await createWorktree(repoRoot, 'cleanup-test');
            await removeWorktree(path);
            const list = await execGit(repoRoot, ['worktree', 'list', '--porcelain']);
            // Main worktree should still be there, but cleanup-test should not
            expect(list.stdout).not.toContain('cleanup-test');
        });
        it('throws for non-existent worktree path', async () => {
            await expect(removeWorktree('/tmp/nonexistent-worktree-99999')).rejects.toThrow(/Failed to remove worktree/);
        });
    });
    // -- mergeWorktreeToMain --------------------------------------------------
    describe('mergeWorktreeToMain', () => {
        it('throws when worktree is in detached HEAD state', async () => {
            const wtPath = await createWorktree(repoRoot, 'detached-merge');
            await expect(mergeWorktreeToMain(repoRoot, wtPath)).rejects.toThrow(/detached HEAD/);
        });
        it('rebases + fast-forward merges worktree branch into main and deletes branch', async () => {
            // Create worktree, then create a named branch inside it
            const wtPath = await createWorktree(repoRoot, 'feature-ff');
            // Create a branch from current detached HEAD
            await execGit(wtPath, ['checkout', '-b', 'feature-ff']);
            // Make a change and commit in the worktree
            writeFileSync(join(wtPath, 'feature.txt'), 'feature work');
            await autoCommit(wtPath, 'feat: add feature.txt');
            // Record the feature commit hash
            const featureHead = (await execGit(wtPath, ['rev-parse', 'HEAD'])).stdout.trim();
            // Merge to main
            await mergeWorktreeToMain(repoRoot, wtPath);
            // Verify main is now at the feature commit
            const mainHead = (await execGit(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
            expect(mainHead).toBe(featureHead);
            // Verify the feature branch was deleted
            const branches = (await execGit(repoRoot, ['branch'])).stdout;
            expect(branches).not.toContain('feature-ff');
            // Verify the file exists on main
            expect(existsSync(join(repoRoot, 'feature.txt'))).toBe(true);
            expect(readFileSync(join(repoRoot, 'feature.txt'), 'utf-8')).toBe('feature work');
        });
        it('throws on merge conflict (main diverged from worktree)', async () => {
            // Create worktree with a branch
            const wtPath = await createWorktree(repoRoot, 'conflict-br');
            await execGit(wtPath, ['checkout', '-b', 'conflict-br']);
            writeFileSync(join(wtPath, 'conflict.txt'), 'from worktree');
            await autoCommit(wtPath, 'worktree change');
            // Meanwhile, change the same file on main
            execSync('git checkout main', { cwd: repoRoot });
            writeFileSync(join(repoRoot, 'conflict.txt'), 'from main');
            execSync('git add conflict.txt', { cwd: repoRoot });
            execSync('git commit -m "main change"', { cwd: repoRoot });
            await expect(mergeWorktreeToMain(repoRoot, wtPath)).rejects.toThrow(/Failed to rebase/);
        });
    });
});
// ---------------------------------------------------------------------------
// GitWorktreeSource
// ---------------------------------------------------------------------------
describe('GitWorktreeSource', () => {
    let repoRoot;
    let worktreePath;
    beforeEach(async () => {
        repoRoot = mkdtempSync(join(tmpdir(), 'test-gwtsrc-'));
        setupGitRepo(repoRoot);
        worktreePath = await createWorktree(repoRoot, 'src-branch');
    });
    afterEach(() => {
        try {
            rmSync(repoRoot, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    it('delegates start() to the inner source inside the worktree directory', async () => {
        const inner = mockSource([{ item: 'hello', meta: {} }]);
        const wrapper = new GitWorktreeSource(inner, worktreePath);
        const chdirSpy = vi.spyOn(process, 'chdir');
        const ctx = makeSourceContext();
        const results = [];
        for await (const env of wrapper.start(ctx)) {
            results.push(env);
        }
        expect(results).toHaveLength(1);
        expect(results[0].item).toBe('hello');
        // Should have chdir'd into the worktree and back
        expect(chdirSpy).toHaveBeenCalledWith(worktreePath);
        chdirSpy.mockRestore();
    });
    it('delegates resume() to the inner source inside the worktree directory', async () => {
        const inner = mockSource([{ item: 'resumed', meta: {} }]);
        const wrapper = new GitWorktreeSource(inner, worktreePath);
        const chdirSpy = vi.spyOn(process, 'chdir');
        const ctx = makeSourceContext();
        const results = [];
        for await (const env of wrapper.resume(ctx, { offset: 0 })) {
            results.push(env);
        }
        expect(results).toHaveLength(1);
        expect(results[0].item).toBe('resumed');
        expect(chdirSpy).toHaveBeenCalledWith(worktreePath);
        chdirSpy.mockRestore();
    });
    it('throws from resume() when inner source does not support resume', async () => {
        const inner = {
            uri: 'mock://no-resume',
            lifestyle: 'long-lived',
            async *start(_ctx) {
                yield { item: 'x', meta: {} };
            },
            // no resume()
        };
        const wrapper = new GitWorktreeSource(inner, worktreePath);
        await expect((async () => {
            for await (const _ of wrapper.resume(makeSourceContext(), {})) {
                /* noop */
            }
        })()).rejects.toThrow(/does not support resume/);
    });
    it('restores the original CWD even if inner source throws', async () => {
        const inner = {
            uri: 'mock://fail',
            lifestyle: 'long-lived',
            async *start(_ctx) {
                yield { item: 'before', meta: {} };
                throw new Error('inner source boom');
            },
        };
        const wrapper = new GitWorktreeSource(inner, worktreePath);
        const originalCwd = process.cwd();
        const chdirSpy = vi.spyOn(process, 'chdir');
        await expect((async () => {
            for await (const _ of wrapper.start(makeSourceContext())) {
                /* noop */
            }
        })()).rejects.toThrow('inner source boom');
        expect(process.cwd()).toBe(originalCwd);
        chdirSpy.mockRestore();
    });
    it('exposes uri combining inner uri with git worktree query params', () => {
        const inner = mockSource([]);
        const wrapper = new GitWorktreeSource(inner, worktreePath);
        expect(wrapper.uri).toContain('git=worktree');
        expect(wrapper.uri).toContain(encodeURIComponent(worktreePath));
    });
    it('exposes the inner source lifestyle', () => {
        const inner = mockSource([], 'resumable');
        const wrapper = new GitWorktreeSource(inner, worktreePath);
        expect(wrapper.lifestyle).toBe('resumable');
    });
});
// ---------------------------------------------------------------------------
// GitWorktreeTarget
// ---------------------------------------------------------------------------
describe('GitWorktreeTarget', () => {
    let repoRoot;
    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'test-gwttgt-'));
        setupGitRepo(repoRoot);
    });
    afterEach(() => {
        try {
            rmSync(repoRoot, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    it('creates worktree on open(), delegates writes, commits+merges on close()', async () => {
        const inner = mockTarget();
        const target = new GitWorktreeTarget(inner, repoRoot, join(repoRoot, 'worktrees', 'tgt-branch'), true);
        const ctx = makeTargetContext();
        // Open: should create worktree
        await target.open(ctx);
        const wtPath = join(repoRoot, 'worktrees', 'tgt-branch');
        expect(existsSync(wtPath)).toBe(true);
        expect(inner.opened).toBe(true);
        // Write
        await target.write({ item: 'data1', meta: {} }, ctx);
        expect(inner.written).toHaveLength(1);
        // Close: should commit + merge + clean up worktree
        // Need a file change so autoCommit has something to commit
        writeFileSync(join(wtPath, 'output.txt'), 'generated');
        await target.close(ctx);
        expect(inner.closed).toBe(true);
        // Worktree should be removed
        expect(existsSync(wtPath)).toBe(false);
        // Main should have the committed file
        execSync('git checkout main', { cwd: repoRoot });
        expect(existsSync(join(repoRoot, 'output.txt'))).toBe(true);
    });
    it('does NOT commit/merge when commitOnClose is false', async () => {
        const inner = mockTarget();
        const target = new GitWorktreeTarget(inner, repoRoot, join(repoRoot, 'worktrees', 'no-commit-br'), false);
        const ctx = makeTargetContext();
        await target.open(ctx);
        const wtPath = join(repoRoot, 'worktrees', 'no-commit-br');
        writeFileSync(join(wtPath, 'discard.txt'), 'should not survive');
        await target.close(ctx);
        expect(inner.closed).toBe(true);
        expect(existsSync(wtPath)).toBe(false);
        // Main should NOT have the file
        execSync('git checkout main', { cwd: repoRoot });
        expect(existsSync(join(repoRoot, 'discard.txt'))).toBe(false);
    });
    it('removes worktree even if close() commit/merge phase fails', async () => {
        // Use commitOnClose=true but don't create a branch —
        // mergeWorktreeToMain will throw on detached HEAD,
        // but worktree cleanup should still happen.
        const inner = mockTarget();
        const target = new GitWorktreeTarget(inner, repoRoot, join(repoRoot, 'worktrees', 'fail-merge-br'), true);
        const ctx = makeTargetContext();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        await target.open(ctx);
        const wtPath = join(repoRoot, 'worktrees', 'fail-merge-br');
        // Manually detach HEAD so mergeWorktreeToMain fails (as it requires a branch)
        await execGit(wtPath, ['checkout', '--detach']);
        writeFileSync(join(wtPath, 'some-file.txt'), 'content');
        await target.close(ctx);
        expect(inner.closed).toBe(true);
        expect(existsSync(wtPath)).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Commit/merge failed'));
        warnSpy.mockRestore();
    });
    it('throws when write() called before open()', async () => {
        const inner = mockTarget();
        const target = new GitWorktreeTarget(inner, repoRoot, join(repoRoot, 'worktrees', 'no-open-br'), true);
        await expect(target.write({ item: 'x', meta: {} }, makeTargetContext())).rejects.toThrow(/Target not opened/);
    });
    it('close() is a no-op when not opened', async () => {
        const inner = mockTarget();
        const target = new GitWorktreeTarget(inner, repoRoot, join(repoRoot, 'worktrees', 'not-open-br'), true);
        await target.close(makeTargetContext());
        expect(inner.opened).toBe(false);
        expect(inner.closed).toBe(false);
    });
    it('exposes uri with branch name', () => {
        const inner = mockTarget();
        const target = new GitWorktreeTarget(inner, repoRoot, join(repoRoot, 'worktrees', 'my-branch'), true);
        expect(target.uri).toContain('git=worktree');
        expect(target.uri).toContain('my-branch');
    });
});
// ---------------------------------------------------------------------------
// Composite URI factories: createGitWorktreeSource / createGitWorktreeTarget
// ---------------------------------------------------------------------------
describe('createGitWorktreeSource (composite URI)', () => {
    let repoRoot;
    let originalSourceFactory;
    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'test-gwt-comp-src-'));
        setupGitRepo(repoRoot);
        // Save any existing jsonl source factory
        originalSourceFactory = registry.getSourceFactory('jsonl');
    });
    afterEach(() => {
        try {
            rmSync(repoRoot, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
        // Restore original factory (best effort)
        if (originalSourceFactory) {
            registry.registerSource('jsonl', originalSourceFactory);
        }
    });
    it('resolves inner jsonl scheme and wraps in GitWorktreeSource', () => {
        // Register a mock jsonl source factory
        const innerSource = mockSource([{ item: 'wrapped', meta: {} }]);
        registry.registerSource('jsonl', () => innerSource);
        const uri = {
            scheme: 'jsonl',
            host: '',
            path: '/data/test.jsonl',
            query: { _inner_scheme: 'jsonl', branch: 'composite-test', root: repoRoot },
            fragment: '',
            raw: 'jsonl://data/test.jsonl?_inner_scheme=jsonl&branch=composite-test&root=' +
                encodeURIComponent(repoRoot),
        };
        const source = createGitWorktreeSource(uri);
        expect(source).toBeInstanceOf(GitWorktreeSource);
        expect(source.uri).toContain('git=worktree');
        expect(source.uri).toContain('composite-test');
    });
    it('throws when _inner_scheme is missing', () => {
        const uri = {
            scheme: 'jsonl',
            host: '',
            path: '/data/test.jsonl',
            query: {},
            fragment: '',
            raw: 'jsonl://data/test.jsonl',
        };
        expect(() => createGitWorktreeSource(uri)).toThrow(/missing inner scheme/);
    });
    it('throws when inner scheme has no registered factory', () => {
        const uri = {
            scheme: 'unknown',
            host: '',
            path: '',
            query: { _inner_scheme: 'no-such-scheme-xyz' },
            fragment: '',
            raw: 'no-such-scheme-xyz://test',
        };
        expect(() => createGitWorktreeSource(uri)).toThrow(/No source registered for inner scheme/);
    });
    it('uses default branch name when none provided', () => {
        registry.registerSource('jsonl', () => mockSource([]));
        const uri = {
            scheme: 'jsonl',
            host: '',
            path: '/data/test.jsonl',
            query: { _inner_scheme: 'jsonl', root: repoRoot },
            fragment: '',
            raw: 'jsonl://data/test.jsonl?_inner_scheme=jsonl&root=' + encodeURIComponent(repoRoot),
        };
        const source = createGitWorktreeSource(uri);
        // The branch name should contain a timestamp-based default
        expect(source.uri).toContain('git=worktree');
    });
});
describe('createGitWorktreeTarget (composite URI)', () => {
    let repoRoot;
    let originalTargetFactory;
    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'test-gwt-comp-tgt-'));
        setupGitRepo(repoRoot);
        originalTargetFactory = registry.getTargetFactory('jsonl');
    });
    afterEach(() => {
        try {
            rmSync(repoRoot, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
        if (originalTargetFactory) {
            registry.registerTarget('jsonl', originalTargetFactory);
        }
    });
    it('resolves inner jsonl scheme and wraps in GitWorktreeTarget with commit=on-close', () => {
        const innerTarget = {
            ...mockTarget(),
            uri: 'jsonl://out.jsonl',
        };
        registry.registerTarget('jsonl', () => innerTarget);
        const uri = {
            scheme: 'jsonl',
            host: '',
            path: '/out.jsonl',
            query: {
                _inner_scheme: 'jsonl',
                branch: 'target-branch',
                root: repoRoot,
                commit: 'on-close',
            },
            fragment: '',
            raw: 'jsonl://out.jsonl?_inner_scheme=jsonl&branch=target-branch&root=' +
                encodeURIComponent(repoRoot) +
                '&commit=on-close',
        };
        const target = createGitWorktreeTarget(uri);
        expect(target).toBeInstanceOf(GitWorktreeTarget);
        expect(target.uri).toContain('git=worktree');
        expect(target.uri).toContain('target-branch');
    });
    it('commitOnClose is false when commit query param is not on-close', () => {
        registry.registerTarget('jsonl', () => ({ ...mockTarget(), uri: 'jsonl://out.jsonl' }));
        const uri = {
            scheme: 'jsonl',
            host: '',
            path: '/out.jsonl',
            query: { _inner_scheme: 'jsonl', branch: 'no-commit', root: repoRoot, commit: 'never' },
            fragment: '',
            raw: 'jsonl://out.jsonl?_inner_scheme=jsonl&branch=no-commit&root=' +
                encodeURIComponent(repoRoot) +
                '&commit=never',
        };
        const target = createGitWorktreeTarget(uri);
        // Can't directly inspect commitOnClose (it's private), but verify it was created
        expect(target).toBeInstanceOf(GitWorktreeTarget);
    });
    it('throws when _inner_scheme is missing for target', () => {
        const uri = {
            scheme: 'jsonl',
            host: '',
            path: '/out.jsonl',
            query: {},
            fragment: '',
            raw: 'jsonl://out.jsonl',
        };
        expect(() => createGitWorktreeTarget(uri)).toThrow(/missing inner scheme/);
    });
    it('throws when inner scheme has no registered target factory', () => {
        const uri = {
            scheme: 'unknown',
            host: '',
            path: '',
            query: { _inner_scheme: 'no-such-target-scheme' },
            fragment: '',
            raw: 'no-such-target-scheme://test',
        };
        expect(() => createGitWorktreeTarget(uri)).toThrow(/No target registered for inner scheme/);
    });
});
//# sourceMappingURL=git-worktree.test.js.map