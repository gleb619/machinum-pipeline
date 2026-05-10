import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createJsonlSource } from '../../src/builtins/jsonl.js';
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        createReadStream: vi.fn(),
        createWriteStream: vi.fn(),
    };
});
vi.mock('node:readline', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        createInterface: vi.fn(),
    };
});
describe('jsonl', () => {
    it('should emit items from source', async () => {
        const mockReadStream = new Readable();
        vi.mocked(fs.createReadStream).mockReturnValue(mockReadStream);
        // Simulate read line
        const rlMock = {
            [Symbol.asyncIterator]: async function* () {
                yield JSON.stringify({ item: 'test' });
            },
        };
        vi.mocked(readline.createInterface).mockReturnValue(rlMock);
        const uri = {
            raw: 'jsonl://test.jsonl',
            host: 'test.jsonl',
            path: 'test.jsonl',
            query: {},
        };
        const source = createJsonlSource(uri);
        const results = [];
        for await (const env of source.start({})) {
            results.push(env);
        }
        expect(results).toHaveLength(1);
        expect(results[0].item).toBe('test');
    });
});
//# sourceMappingURL=jsonl.test.js.map