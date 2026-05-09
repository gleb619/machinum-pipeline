import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner } from '../../src/engine/runner.js';
describe('runner caching', () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'mt-runner-test-'));
    });
    it('should use cached tool output', async () => {
        const mockTool = {
            name: 'testTool',
            version: '1.0.0',
            cacheable: true,
            invoke: vi.fn().mockImplementation(async () => {
                return { item: 'result' };
            }),
        };
        const pipeline = {
            id: 'p1',
            steps: [
                {
                    type: 'tool',
                    config: {
                        name: 'testTool',
                        tool: mockTool,
                        input: { item: 'input' },
                    },
                },
            ],
        };
        const globalContext = {
            project: { name: 'test', root: tempDir },
            defaults: {
                retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
                onError: 'fail-run',
                concurrency: 1,
            },
        };
        const runner1 = new Runner(pipeline, globalContext);
        // First run - should call invoke
        await runner1.start();
        expect(mockTool.invoke).toHaveBeenCalledTimes(1);
        // Second run with a fresh runner instance
        const runner2 = new Runner(pipeline, globalContext);
        await runner2.start();
        // In second run, tool.invoke should NOT be called again
        expect(mockTool.invoke).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=runner-cache.test.js.map