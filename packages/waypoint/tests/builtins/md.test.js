import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMdSource, createMdTarget } from '../../src/builtins/md.js';
// Register builtins on import
import '../../src/builtins/md.js';
describe('md source', () => {
    let tempDir;
    let filePath;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'md-test-'));
        filePath = join(tempDir, 'test.md');
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('should read markdown file and yield its contents', async () => {
        const content = '# Hello\n\nThis is a test markdown file.';
        writeFileSync(filePath, content, 'utf-8');
        const uri = {
            raw: `md://${filePath}`,
            host: filePath,
            path: filePath,
            query: {},
        };
        const source = createMdSource(uri);
        const results = [];
        for await (const env of source.start({})) {
            results.push(env);
        }
        expect(results).toHaveLength(1);
        expect(results[0].item).toBe(content);
    });
    it('should support resume by re-reading the file', async () => {
        const content = '# Resume Test';
        writeFileSync(filePath, content, 'utf-8');
        const uri = {
            raw: `md://${filePath}`,
            host: filePath,
            path: filePath,
            query: {},
        };
        const source = createMdSource(uri);
        const results = [];
        for await (const env of source.resume({}, 0)) {
            results.push(env);
        }
        expect(results).toHaveLength(1);
        expect(results[0].item).toBe(content);
    });
});
describe('md target', () => {
    let tempDir;
    let filePath;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'md-test-'));
        filePath = join(tempDir, 'out.md');
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('should append markdown content to file', async () => {
        const uri = {
            raw: `md://${filePath}`,
            host: filePath,
            path: filePath,
            query: {},
        };
        const target = createMdTarget(uri);
        await target.open({});
        await target.write({ item: '# Line 1', meta: {} }, {});
        await target.write({ item: '# Line 2', meta: {} }, {});
        await target.close({});
        const content = readFileSync(filePath, 'utf-8');
        expect(content).toBe('# Line 1\n# Line 2\n');
    });
    it('should throw if write is called before open', async () => {
        const uri = {
            raw: `md://${filePath}`,
            host: filePath,
            path: filePath,
            query: {},
        };
        const target = createMdTarget(uri);
        await expect(target.write({ item: 'x', meta: {} }, {})).rejects.toThrow('Target not opened. Call open() before write().');
    });
});
//# sourceMappingURL=md.test.js.map