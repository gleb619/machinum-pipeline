# sample3 runner report

Generated: 2026-11-03T13:06:18.589Z

Every sibling runner script of this sample, executed one after another.
Command: `pnpm run runner`

Fixtures: `prepare-input` ran before the sweep.

## Summary

| Runner | Pipeline | Status | Duration |
| --- | --- | --- | --- |
| `runner:multi` | `./pipelines/jsonl-to-md-multi.ts` | ok | 2.3s |
| `runner:simple` | `./pipelines/jsonl-to-md-simple.ts` | ok | 1.9s |

Totals: 2 runners, 2 ok, 0 failed.

## runner:multi

- Status: ok
- Duration: 2.3s
- Run id: `e675a2fb-86b3-430a-9653-ef17e9b0ac09`
- Log: `.mt/runs/e675a2fb-86b3-430a-9653-ef17e9b0ac09/run.log`
- Outputs:
  - `chapters/en/chapter1.md`
  - `chapters/en/chapter2.md`
  - `chapters/en/chapter3.md`
  - `chapters/ru/chapter1.md`
  - `chapters/ru/chapter2.md`
  - `chapters/ru/chapter3.md`
  - `chapters/schema/chapter1.schema.md`
  - `chapters/schema/chapter2.schema.md`
  - `chapters/schema/chapter3.schema.md`

~~~~text
2026-11-03T13:06:15.566Z [INFO] Starting pipeline: jsonl-to-md-multi
2026-11-03T13:06:15.567Z [INFO] Pipeline file: ./pipelines/jsonl-to-md-multi.ts
2026-11-03T13:06:15.887Z [INFO] Resolved URI alias '@en' → 'md://./chapters/en'
2026-11-03T13:06:15.930Z [INFO] [forbidden] findings: {"findings":[]}
2026-11-03T13:06:16.071Z [INFO] [forbidden] findings: {"findings":[]}
2026-11-03T13:06:16.160Z [INFO] [forbidden] findings: {"findings":[]}
2026-11-03T13:06:16.241Z [INFO] [MyLogMarker] <repo>/samples/sample3/jsonl/input.jsonl#0 # Chapter 1: The Road from Thornhaven\n\nDolore occaecat et est ut officia ad laborum culpa elit ani...at nostrud sunt magna ullamco do aute consectetur magna minim minim excepteur consequat quis quis.\n (length: 2015 chars)
2026-11-03T13:06:16.241Z [INFO] [MyLogMarker] <repo>/samples/sample3/jsonl/input.jsonl#1 # Chapter 2: Ambush in the Darkwood\n\nLaboris officia deserunt labore nulla consequat excepteur par...unt ea. Tempor irure cupidatat occaecat veniam dolore cupidatat proident ipsum aliqua labore esse.\n (length: 1942 chars)
2026-11-03T13:06:16.242Z [INFO] [MyLogMarker] <repo>/samples/sample3/jsonl/input.jsonl#2 # Chapter 3: The Duke’s Tribunal\n\nNulla nulla nostrud ut Lorem consectetur qui anim. Cillum conseq...unt. Commodo reprehenderit exercitation Lorem veniam nisi fugiat adipisicing amet ullamco aliquip.\n (length: 1757 chars)
2026-11-03T13:06:16.243Z [INFO] md target 'md://./chapters/en' wrote 3 file(s) under <repo>/samples/sample3/chapters/en
2026-11-03T13:06:16.633Z [INFO] md target 'md://./chapters' wrote 3 file(s) under <repo>/samples/sample3/chapters
2026-11-03T13:06:16.666Z [INFO] Pipeline complete. Run ID: e675a2fb-86b3-430a-9653-ef17e9b0ac09
~~~~

## runner:simple

- Status: ok
- Duration: 1.9s
- Run id: `dfdaa89f-d9fd-4f24-93d3-a9ac8f673da6`
- Log: `.mt/runs/dfdaa89f-d9fd-4f24-93d3-a9ac8f673da6/run.log`
- Outputs:
  - `chapters/en/chapter1.md`
  - `chapters/en/chapter2.md`
  - `chapters/en/chapter3.md`
  - `chapters/ru/chapter1.md`
  - `chapters/ru/chapter2.md`
  - `chapters/ru/chapter3.md`

~~~~text
2026-11-03T13:06:17.903Z [INFO] Starting pipeline: jsonl-to-md-simple
2026-11-03T13:06:17.904Z [INFO] Pipeline file: ./pipelines/jsonl-to-md-simple.ts
2026-11-03T13:06:18.222Z [INFO] Resolved URI alias '@en' → 'md://./chapters/en'
2026-11-03T13:06:18.269Z [INFO] [forbidden] findings: {"findings":[]}
2026-11-03T13:06:18.390Z [INFO] [forbidden] findings: {"findings":[]}
2026-11-03T13:06:18.462Z [INFO] [forbidden] findings: {"findings":[]}
2026-11-03T13:06:18.530Z [INFO] [MyLogMarker] <repo>/samples/sample3/jsonl/input.jsonl#0 # Chapter 1: The Road from Thornhaven\n\nDolore occaecat et est ut officia ad laborum culpa elit ani...at nostrud sunt magna ullamco do aute consectetur magna minim minim excepteur consequat quis quis.\n (length: 2015 chars)
2026-11-03T13:06:18.531Z [INFO] [MyLogMarker] <repo>/samples/sample3/jsonl/input.jsonl#1 # Chapter 2: Ambush in the Darkwood\n\nLaboris officia deserunt labore nulla consequat excepteur par...unt ea. Tempor irure cupidatat occaecat veniam dolore cupidatat proident ipsum aliqua labore esse.\n (length: 1942 chars)
2026-11-03T13:06:18.532Z [INFO] [MyLogMarker] <repo>/samples/sample3/jsonl/input.jsonl#2 # Chapter 3: The Duke’s Tribunal\n\nNulla nulla nostrud ut Lorem consectetur qui anim. Cillum conseq...unt. Commodo reprehenderit exercitation Lorem veniam nisi fugiat adipisicing amet ullamco aliquip.\n (length: 1757 chars)
2026-11-03T13:06:18.533Z [INFO] md target 'md://./chapters/en' wrote 3 file(s) under <repo>/samples/sample3/chapters/en
2026-11-03T13:06:18.534Z [INFO] Resolved URI alias '@ru' → 'my-target://./chapters'
2026-11-03T13:06:18.559Z [INFO] Pipeline complete. Run ID: dfdaa89f-d9fd-4f24-93d3-a9ac8f673da6
~~~~
