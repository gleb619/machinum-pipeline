# Preparing a model for the pipeline (SFT)

← [Docs layout](../README.md) · see also [tools steering](../steering/tools.md), [architecture](architecture.md)

This guide explains what it takes to get a **local, self-hosted model** to speak
machinum-pipeline's LLM protocol reliably, and how to build the fine-tuning (SFT)
data for it out of this repo's own artifacts.

Nothing here changes `mt`. A fine-tuned model is just another OpenAI-compatible
endpoint registered in `mt.json` (§8).

**Scope (2026-11-08): text only.** Image/scan input is deferred, so the model needs no
vision tower. That frees VRAM, removes the projector from the artifact and takes the
cheap text bases on Together ($0.34/1 M tokens) as the default lane (§11).

**On the 128 K requirement.** It is a serving convenience, not a correctness requirement:
a 4 K–8 K window plus previous-sentence context and retrieved style pairs recovers most of
what long context buys, and measured discourse-level work (§15.2) shows the gain comes from
training and prompting rather than from the window. Buy 128 K if it is free; do not pay for
it, and do not train for it.

---

## 1. What "ready for the format of communication" means

The engine never sends free-form prompts. Every LLM call is a **composed prompt
pair** plus a **strict reply shape** that is parsed by code, not by a human:

```
system = <family>.system + llm.format.<mode> + <family>.output.<mode>
user   = wrapPromptInput(text, mode)
reply  = parsed by parseStructuredReply / extract*Entries / line parity
```

### 1.1 Work modes

`PromptWorkMode = 'plain' | 'xml' | 'properties'` (`PROMPT_WORK_MODES`,
`packages/tools/src/core/prompt-blocks.ts`). The mode decides how input lines are
wrapped and how the reply must be shaped:

| Mode | Input (`wrapPromptInput`) | Reply |
| --- | --- | --- | --- | --- |
| `plain` | bare text, one unit | one unit, same content, no wrapper |
| `xml` | `<context>…<result><id>N</id><origin>text</origin></result>…</context>` | one `<result>` per input id |
| `properties` | `N=text` pairs in `<context>` | `N=text` pairs, ids kept |

### 1.2 Per-family reply contracts

| Family | Prompt blocks | Required reply shape |
| --- | --- | --- |
| proofread / proofread-xml | `proofread.system`, `llm.format.*` | `<result><id/><text/><proofread/></result>`, one per paragraph, ids preserved |
| proofread-properties | `proofread.properties.*` | `N=corrected` |
| translate | `translate.system`, `translate.output.<mode>` | one output line per input line, then **exactly one** `<terms>[{"term","ru","type"}]</terms>` block |
| summary / summary-notes | `summary.system`, `summary.output.bullets` | plain `- ` bullets, no numbering, no commentary |
| glossary (+ relations, enrich) | `glossary.*` | JSON array, field order `name`, `category`, `description`, `references`; `additionalProperties: false` |
| schema / metadata / entities | `schema-doc` prompts | mdshape / mermaid / single row — whole-chapter, never chunked |

### 1.3 What the code tolerates, and what it does not

- Parsers are tolerant about formatting drift but **not** about structure:
  `parseStructuredReply` demands non-empty content, numeric sort, contiguous
  `1..N`, and throws a retryable `StructuredReplyParseError` otherwise.
- The loop guard re-prompts with the failure reason appended, **max 3 attempts**,
  then falls back to the deterministic heuristic. A model that needs 3 attempts
  everywhere still "works" — it just costs ~3x tokens and silently degrades.
- Budgets come from tiktoken (`countTextTokens`), not the model's own tokenizer:
  `inputBudget = contextLimit − outputReserve − thinkReserve − overhead − reserve`
  (`core/chunk-processor.ts`). `contextLimit` comes from `modelContextLimit()`
  and its `MODEL_CONTEXT_LIMITS` table, overridable with `MT_CONTEXT_LIMITS`.

So the four failure classes worth training away are: **chatter**
(preamble, ```` ``` ```` fences, ` thinking`), **structure loss** (dropped or
merged lines, id drift, invented tags), **schema drift** (extra JSON fields,
trailing commas, prose around JSON), and **unrequested edits** (rewriting style,
"improving" names, inventing glossary terms).

---

## 2. Target model profile

Text-only, on a 16 GB-VRAM-class GPU (a 2×16 GB box trains on one card and serves on
the other):

| Requirement | Value | Why |
| --- | --- | --- |
| Parameters | 7–9 B dense | protocol compliance + RU fluency at 4-bit |
| Weights on disk | **5–9.5 GB** (Q4_K_M … Q8_0) | text-only Q4 lands near 5 GB; Q6/Q8 stay inside the band |
| Native context | **≥32 K required, 128 K a bonus** | whole-chapter calls; chunk mode covers the rest, and long context is a serving comfort, not a correctness need (§15.2) |
| Modalities | text only | images deferred — no `mmproj`, no image token budget |
| Tokenizer/Chat template | untouched from the base model | prompts embed literal tags and markers |

### 2.1 Candidates — re-ranked 2026-11-08 (no Llama; newest Qwen/Gemma; 128 K demoted)

Method behind the table: parameters and context from each model's `config.json`, GGUF sizes
from the Hugging Face tree API (`unsloth/*-GGUF`), KV computed with the §3 formula, and
**Russian tokenizer fertility measured directly** — each `tokenizer.json` was run over this
repo's own Russian chapters (9 463 characters, 1 422 words):

| Model | Params | Native ctx | KV / token | GGUF Q4_K_S / Q4_K_M / Q5_K_M | RU chars/token (measured) | Licence | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Qwen3.5 9B** | 9.65 B | 262 144 | 128 KB | 5.39 / 5.68 / 6.58 GB | **3.08** (2.16 tok/word) | Apache-2.0 | **primary**: 128 K fits (5.39 + 4.6 GB q4_0 KV), 262 K native, cheap KV |
| **Gemma 4 12B it** | 11.96 B | 262 144 | **384 KB** | 6.76 / 7.12 / 8.41 GB | **3.10** (2.15 tok/word) | Apache-2.0 | quality alternative: best fertility, but KV caps context at ~32–48 K |
| **Gemma 4 E4B it** | 8.0 B (MoE, 4 B active) | 131 072 | **84 KB** (42 L / 2 kv / 256 d) | 4.84 / 4.98 / 5.48 GB | 3.10 | Apache-2.0 | **pilot**: 128 K needs only ~8 GB total — iterate cheap, train fast |
| Qwen3.5 4B | 4.66 B | 262 144 | 128 KB | 2.59 / 2.74 / 3.14 GB | 3.08 | Apache-2.0 | budget fallback, same tokenizer as 9B |
| Qwen3-8B | 8.19 B | **40 960** | 144 KB | 4.80 / 5.03 / 5.85 GB | **2.46** (2.71 tok/word) | Apache-2.0 | demoted: 41 K window *and* 26 % more tokens for the same Russian text |
| Qwen3.5 27B / Gemma 4 26B-A4B | 27 B / 26 B | 262 144 | — | 16.5 GB+ | — | Apache-2.0 | out: does not fit a 16 GB card at Q4 |

Reading:

- **Qwen3.5 9B is the default.** Same KV cost as the Llama 3.1 8B it replaces (128 KB/token),
  a 262 K window it can actually serve on 16 GB (Q4_K_S 5.39 GB + q4_0 KV 4.6 GB = **10 GB at
  128 K**), Apache-2.0, and a tokenizer 25 % more efficient on Russian than Qwen3-8B's.
- **Gemma 4 12B is the fidelity play.** Equal fertility, Apache-2.0 (Gemma 3 was not), but
  384 KB/token means 32 K costs 3.5 GB of KV and 64 K costs 6.9 GB — usable only because the
  pipeline chunks by budget anyway (§15.2). Choose it if rubric-judged prose quality beats
  window size.
- **Gemma 4 E4B is the experiment platform.** 84 KB/token and 4.84 GB of weights mean 128 K
  costs ~8 GB, so prompt/protocol iteration is cheap; it is also the MoE one, so it is the
  cheapest to serve at the end.
- **Qwen3-8B is no longer the safe pick.** It was chosen for protocol compliance at 41 K; the
  new tokenizer measurement plus the demotion of 128 K leave it strictly worse than Qwen3.5 9B
  on both axes.
- **All three "new" models are multimodal checkpoints** (`image-text-to-text` / `any-to-any`:
  `Qwen3_5ForConditionalGeneration`, `Gemma4UnifiedForConditionalGeneration`). Using them
  text-only is fine — serve without `--mmproj`, exactly as §8 says — but the *trainer* must
  load them through the vision-capable loader. That is a real integration risk: verify it on
  the target box before committing a run, and keep **Qwen3-8B as the text-only fallback** if
  the training stack cannot load the unified architecture.

For a 500 k-character novel: 161 k tokens on Qwen3.5/Gemma 4 versus 203 k on Qwen3-8B — the
tokenizer alone is worth ~20 % of every context budget and every API bill.

---

## 3. Memory math (decides the serving config)

KV cache per token = `2 × layers × kv_heads × head_dim × bytes`, where
`bytes` = 2 (fp16), ~1.06 (q8_0) or ~0.56 (q4_0) per element.

| Model | KV/token (fp16) | 128 K fp16 | 128 K q8_0 | 128 K q4_0 |
| --- | --- | --- | --- | --- |
| Qwen3.5 9B / 4B (32 L / 4 kv / 256 d) | 128 KB | 17.2 GB | 9.1 GB | 4.8 GB |
| Qwen3-8B (36 L / 8 kv / 128 d) | 144 KB | 19.3 GB | 10.3 GB | 5.4 GB |
| Gemma 4 12B (48 L / 8 kv / 256 d) | 384 KB | 51.5 GB | 27.4 GB | 14.5 GB |
| Gemma 4 E4B (42 L / 2 kv / 256 d) | 84 KB | 11.0 GB | 5.8 GB | 3.1 GB |
| Vikhr-Nemo-12B (40 L / 8 kv / 128 d) | 160 KB | 21.5 GB | 11.4 GB | 6.0 GB |
| Qwen2.5-7B (28 L / 4 kv / 128 d) | 56 KB | 7.5 GB | 4.0 GB | 2.1 GB |

One more column exists, off the stock build: the **TurboQuant** KV fork
(`github.com/AmesianX/TurboQuant`, ★92) advertises a **4.71×** reduction over FP16
(`-ctk tbqp3 -ctv tbq3`), which puts an 8 B model at 128 K near **3.4 GB** of KV, or
**~9.3 GB** together with Q4_K_M weights. It is a third-party CUDA-only fork, not stock
llama.cpp — treat it as an experiment with a fallback (§14.1).

Consequences:

- **An 8 B text model at 128 K fits one 16 GB card only with quantized KV**:
  4.9–5.0 GB weights (Q4_K_M) + 4.8 GB (q4_0 KV) + ~1 GB runtime ≈ 11 GB.
  fp16 KV (17 GB) does not fit.
- **Native window is a per-model fact, not a family fact.** Qwen3-8B stops at 41 K
  unless YaRN/rope scaling is enabled in the GGUF; Llama 3.1 8B and Gemma 3 declare
  131 072 natively. Do not promise 128 K because a sibling model had it.
- **Gemma 3 12 B cannot do 128 K under any quant** on 16 GB. Use it at 16–32 K.
- `llama.cpp` does **not** spill KV to system RAM by itself. With all layers
  offloaded it OOMs; you must pass `-ctk q8_0 -ctv q4_0` (Flash Attention on) or
  lower `--n-gpu-layers`.
- Text-only removes the image budget: no `--mmproj`, no ~1–2 K tokens per image on top
  of the text context.

Training is a different budget: QLoRA activations, not attention matrices, are
the limit. 2 K–8 K sequences are comfortable on 16 GB; 32 K is borderline at
batch 1; **128 K training is not possible** — and is not needed (§5.4).

---

## 4. Why SFT rather than prompting

Prompt engineering already carries this project: the blocks are long, explicit
and full of edge cases ("do not reformat tags", "output only XML", "keep
[bracketed] markers"). Small models spend that instruction budget on
compliance and lose it on the actual editing. An adapter trained on the *same*
prompt blocks internalises the protocol, which buys:

1. first-pass parse rate near 100% (no loop-guard retries ⇒ ~3x fewer tokens);
2. line/paragraph parity that survives retries and chunk merges;
3. fewer `<terms>`/JSON schema violations, so the glossary stage stops falling
   back to heuristics;
4. stable behaviour at chunk boundaries (the runtime splits by
   `adaptiveSemanticChunks`, training pairs must be split the same way).

Do **not** change the prompt blocks after training without retraining (§6, §9).

---

## 5. Building the SFT dataset from this repo

### 5.1 Where the pairs come from

| Source | Path | What it gives |
| --- | --- | --- |
| Parallel corpus | `books/book1/chapter-*.en.md` + `chapter-*.ru.md` | human-quality EN→RU pairs, 5 chapters |
| Source-only corpus | `books/book2/chapter-*.en.md` | input distribution for proofread/summary/glossary |
| Prompt log | `MT_TRANSLATE_PROMPT_LOG=.mt-translate-prompts.jsonl` | every rendered `(system, user)` prompt the translator sent |
| Run artifacts | `.mt/` checkpoints, `events.jsonl`, `logs/<step>.log`, `run.log` | tool sequence, chunk sizes, retry counts |
| LLM records | `<tool>Llm` variable (`attempts`, `tokens`, `model`, `fallbackUsed`, `lastFailure`) | which replies failed the loop guard, and why |
| Dead letters | `.mt/` dead-letter entries | realistic hard failures |
| Public RU corpus (style + terminology) | `IlyaGusev/ficbook` — 1.39 M stories, 133 GB, per-part `clean_text` | modern Russian prose voice, dialogue, names |
| Public RU classics (target-side style) | `Imperius/ru-classic` — 6.9 M rows, 866 MB clean text, 61 authors, lib.ru, CC0-1.0 | 19th–early-20th c. prose: the register literary translation must reach |
| Public RU corpus (books) | `IlyaGusev/librusec_full` — 496 k books, 331 GB, `sections` + metadata | broad genre coverage, translator credits, annotations |
| Public RU summarization | `IlyaGusev/gazeta` — 60.9 k news + summaries | summary-tool style, bullet compression |
| Public RU SFT, pre-scored | `IlyaGusev/saiga_scored` — 41.6 k dialogues with `opus_score`, `is_bad_by_regex`, topic/complexity labels | quality-filtering precedent: keep `opus_score ≥ 8` |
| Public RU instruction mixes | `IlyaGusev/ru_turbo_alpaca`, `ru_turbo_saiga`, `ru_sharegpt_cleaned`, `pippa_ru` | general RU instruction following, guard against fluency collapse |

Corpora are raw material, not training triples: `ficbook` / `librusec_full` give the
*Russian side* of a translation or the *input* side of proofreading; the instruction
pairs still come from §5.2.

### 5.2 Teacher-student distillation (the practical path)

1. Run the real pipelines (`samples/sample2-practical/pipelines/*.ts`) against a
   strong API model with `MT_TRANSLATE_PROMPT_LOG` on and full logging.
2. Capture `(systemPrompt, userPrompt, reply)` triples — the system prompt is
   already the composed block set, so the training distribution equals production.
3. Filter with the repo's own validators (`parseStructuredReply`,
   `extractXmlResultEntries`, `extractPropertiesEntries`, `lintLineParity`,
   glossary schema check). Keep only first-attempt passes.
4. Convert to chat JSONL with `tokenizer.apply_chat_template` — one `text` field,
   not a hand-written `conversations` field.

This is cheaper and safer than scraping novels: the model learns *this* protocol,
not generic literary editing.

Two published variants worth copying when the teacher is expensive:

- **Seed → generate (CRAFT-style).** Take real material (your chapters, `ficbook`
  fragments, `gazeta` pairs) as seeds and let a strong model generate the
  target-side pairs in batch. One published run: 30 k pairs for ~$310 in batch API
  calls, which was 93 % of the whole project budget (§12).
- **Fluency-repair triplets.** Produce a literal hypothesis (cheap translator) and a
  fluent paraphrase (strong general LLM), keep `(source, good, bad)` — Yandex used
  exactly this to convert noisy parallel data into DPO material (§12).

One-generation rule: synthesise **once**, from real text, and keep real targets as anchors;
iterating synthesis on synthesis causes documented model collapse (§12.12).


### 5.3 Task mix (target proportions)

| Family | Share | Mode balance |
| --- | --- | --- |
| translate (incl. `<terms>` block) | 35% | match production mode per target language |
| proofread | 30% | xml 50% / properties 30% / plain 20% |
| summary / summary-notes | 15% | plain bullets |
| glossary (+ relations/enrich) | 15% | JSON only |
| schema / metadata / entities | 5% | whole-chapter, single call |

Add **5–10% hard negatives**: already-correct lines where the right answer is the
original text unchanged, and chapters whose correct glossary answer is `[]` plus
an empty `<terms>` block. Without them, the adapter learns to always edit and
always invent terms.

### 5.4 Sequence lengths and long context

- Train at 2048–8192 tokens, aligned to the chunker's `splitUnit` (paragraph →
  sentence → line), so a training example is exactly one runtime chunk.
- Keep **2–5% of samples at 16–32 K** so position handling does not collapse.
- Never train at 128 K: the base model already has that window; SFT only needs to
  teach the protocol, and the runtime prefers `chunkMode: 'auto'` anyway.

### 5.5 Volume

- ~3–10 K samples: format compliance, tag fidelity, JSON validity.
- 20–50 M tokens: terminology and style consistency for one book series.
- Held-out 5% split, stratified by family **and** by mode.

---

## 6. Training recipe (QLoRA, single 16 GB card)

```text
base        Llama 3.1 8B-Instruct (native 128 K) or Qwen3.5-9B (bnb-4bit)
method      QLoRA + gradient checkpointing (unsloth), bf16, adamw_8bit
r / alpha   32 / 16, dropout 0, all 7 projections + modules_to_save ["lm_head"]
batch       1 per device × grad-accum 128 (effective 128)
lr          5e-5 cosine, warmup 8, weight_decay 0.05, max_grad_norm 1.0
epochs      2, eval + save every 8 steps, load_best_model_at_end
max_seq     8192
loss        mask system+user, train on the reply only
            (Saiga: only_target_loss; TRL: completion_only_loss=True)
loader      FastLanguageModel; formatting fn → `text` field;
            TRL `max_length` (older: `max_seq_length`)
split       97/3 by content hash, duplicates removed by hash
```

These are not invented defaults: they are the published config of the Saiga 8B SFT
run (`configs/models/saiga_llama3_8b_sft_m11.json`, §12). Two deviations from the
usual blog advice are deliberate:

- **lr 5e-5, not 1e-4…2e-4.** On a few thousand literary samples the higher rate
  overfits inside one epoch; 5e-5 with 2 epochs and best-checkpoint selection is the
  published Russian SFT setting.
- **r = 32, alpha = 16.** Saiga uses alpha = r/2; the common convention is alpha = 2r.
  Either scales, but pick one and keep it stable across runs, otherwise the effective
  learning rate on the adapter changes between experiments.

Notes that bite:

- Text-only means `FastLanguageModel` for every candidate — no collator for images, no
  `FastVisionModel` path, no projector in the artifact.
- Saving `lm_head` in `modules_to_save` matters when the tokenizer is extended or the
  output vocabulary distribution shifts (RU text after an English-centric base).
- One epoch is often enough and the best checkpoint is frequently *mid*-epoch, so
  evaluate every few steps and keep the best instead of the last (MTS hit this; §12).
- Merge the adapter into 16-bit weights, then quantize to GGUF `Q5_K_M`/`Q6_K`;
  ship the tokenizer and chat template unchanged.
- Keep the base model's license terms with the artifact (they apply to the
  adapter and to merged weights).

### 6.1 Where published settings disagree — and how to reconcile them

Two credible sources, two different configurations:

| Source | r / alpha | lr | epochs | batch | seq |
| --- | --- | --- | --- | --- | --- |
| Saiga 8B SFT (real run, §12.1) | 32 / 16 | 5e-5 | 2 | 1 × 128 | 8192 |
| OTUS / Unsloth guide (§12.11) | 16 / 32 | 2e-4 | 3 | 4 × 4 | 2048 |
| torchtune `8B_qlora_single_device` (§13.6) | 8 / 16 | 3e-4 | 1 | 2 | model max |

A fourth run sits outside the table because it reports no learning rate: a Qwen3-8B QLoRA
on one RTX 4090 (`unsloth/Qwen3-8B-unsloth-bnb-4bit`, `max_seq_length=128000`) used
r 32 / alpha 64 on all seven projections, batch 4 × accum 2, 5 epochs, `auto_find_batch_size`,
bf16, `save_strategy="best"` on METEOR, seven full runs of **29 min–1 h 22 min** each
(§14.3). Its DoRA arms ran 2–2.7× slower and, crucially, **DoRA adapters could not be
converted to GGUF** — for a project whose artifact is a GGUF, plain LoRA is the only
option, whatever the quality delta.

They are not as far apart as they look. `alpha / r` is an effective multiplier on the
adapter's update, so Saiga runs at 0.5× and the guide at 2× — a 4× spread that mirrors the
4× spread in their learning rates. Practical reading:

- Pick **r from the task**, not from a blog: 8 for style/format, 16–32 for moderate domain
  shift, 64 only for substantial new knowledge.
- Then set lr by the multiplier you want: with `alpha = r` or `alpha = 2r`, lr 1e-4…2e-4 is
  the usual band; with `alpha = r/2` (Saiga), expect ~5e-5.
- Sweep lr on 10 % of the data for one epoch over {1e-4, 2e-4, 3e-4} and keep the winner —
  this costs minutes and settles the argument faster than either source.

Three guardrails both sources agree on, stated with their own numbers:

- **Below ~200–300 quality examples, do not fine-tune** — a prompt or RAG beats it, and the
  model memorises instead of generalising (the TorchTune run at ~6 k pairs still called its
  dataset thin, §12.10).
- **Mix 5–10 % general instruction data** (`ru_turbo_alpaca`, `saiga_scored`) into the SFT
  set to limit catastrophic forgetting of general Russian.
- **Sequence length, not parameter count, is what breaks 16 GB.** 8B QLoRA fits under ~10 GB
  only at `seq ≤ 512`; at 4096–8192 budget VRAM accordingly and cut batch before cutting seq.

---

## 7. Acceptance gates

Run these before the model is allowed into a pipeline. Each maps to existing code:

| Gate | Implementation |
| --- | --- |
| parse rate 100% | `parseStructuredReply` / `extract*Entries` on the held-out set, first attempt |
| id contiguity | contiguous `1..N`, no duplicates, no missing ids |
| line/paragraph parity | `lintLineParity` (EN vs RU) via `pnpm run lint:parity` in the samples |
| glossary schema | JSON array, field order, closed `references`, empty-array instead of null |
| `<terms>` block | exactly one per translation, valid JSON, `[]` when nothing new |
| no chatter | zero fences, zero `thinking` blocks, zero preamble lines |
| no silent truncation | `contextWindow.applied` shows no shrink strategy fired at the configured chunk size |
| end-to-end | `pnpm test:gpu` green with the local model; sample2-practical runner parity clean |

Prompts, temperature and chunk size must be frozen during evaluation — changing
them changes the distribution.

Two gates are cheaper to satisfy than to train away: structure loss and schema drift can be
removed by constrained decoding (GBNF in llama.cpp, structured outputs in vLLM — §13.10),
leaving SFT to fix semantics and style. Measure the gates with the grammar off as well, so
you know whether the adapter or the grammar is doing the work.

---

## 8. Wiring the model into `mt` (config only)

```jsonc
// mt.json (or mt.local.json)
{
  "settings": {
    "llm.tool": "ollama",              // or a custom gate
    "llm.model": "local-novel-8b",
    "llm.baseUrl": "http://127.0.0.1:11434/v1",
    "llm.temperature": 0,
    "llm.maxTokens": 4096
  }
}
```

- Context window: `MODEL_CONTEXT_LIMITS` matches `qwen*` at 128 K already; for a
  custom name register it explicitly —
  `MT_CONTEXT_LIMITS='{"local-novel-8b":131072}'` (or `context.limits` in `mt.json`).
- Sanity check: `pnpm run check-llm` in `samples/sample2-practical` reports
  backend, URL, server health and whether the model exists; `mt info` shows the
  resolved config.
- Serving: any OpenAI-compatible endpoint works. For GGUF, `llama-server` with
  `-c 131072 -ngl 99 -fa -ctk q8_0 -ctv q4_0`. No projector argument: the artifact is
  text-only.
  Keep `temperature` at 0–0.3 for format tasks.

---

## 9. Pitfalls

1. **Prompt drift.** Any edit to `packages/tools/prompts/*.md` invalidates the
   adapter. Store the prompt-block hash with the dataset and retrain on change.
2. **Mode imbalance.** Training mostly on XML makes the model emit tags in
   `plain` mode. Keep the mode proportions of production traffic.
3. **Contamination.** Never train on the chapters you intend to process; keep a
   held-out book.
4. **Over-aggressive editing.** Without "no-op" negatives the model rewrites
   style; with them it also learns when to return the input untouched.
5. **Long-context rot.** Beyond ~32 K the model's compliance drops faster than
   its perplexity suggests; prefer `chunkMode: 'auto'` and keep the budget
   conservative (`reserve`, `outputReserve`).
6. **4-bit merge artifacts.** Always merge to 16-bit before quantizing; quantizing
   the QLoRA shards directly loses quality.
7. **RU fluency collapse.** Mix 20–30% general translation samples into the
   dataset if the corpus is small.

---

## 10. Phasing

| Phase | Work | Exit criterion |
| --- | --- | --- |
| P0 | Enable `MT_TRANSLATE_PROMPT_LOG`, run sample2-practical end-to-end against a teacher model, keep run artifacts | ≥2 K clean triples |
| P1 | Smoke adapter (1–2 K samples), gates §7 on held-out | parse rate ≥98%, parity clean |
| P2 | Full adapter (10–20 K samples), mode-balanced | all gates green, retries ≈0 |
| P3 | Merge → GGUF → serve → `pnpm test:gpu` + sample2-practical parity | end-to-end book run, no fallbacks |
| P4 | Refresh loop keyed to prompt-block hash | retrain when prompts change |

---

## 11. Opportunities and cost

Prices below are a **snapshot taken 2026-11-08**, read with read-only queries: the
Vast.ai console offer API (`GET /api/v0/bundles/`, no account changes) and the
published Together AI price list. Nothing was rented, purchased or reserved.
Rates move; re-check before committing a budget.

### 11.1 What one adapter actually costs to train

Sizing from §5.5, assuming ~1.5 K tokens per sample:

| Dataset | Tokens processed | Together SFT (Qwen3.5 9B / Llama 3.1 8B) |
| --- | --- | --- |
| smoke — 1.5 K samples × 2 epochs | 4.5 M | $4.00 (minimum charge) |
| full — 15 K samples × 2 epochs | 45 M | **$15.30** |
| heavy — 30 K samples × 3 epochs | 135 M | $45.90 |

Dropping images took the vision bases out of contention: the same run on Gemma 4 31B
VLM would be $47.25 instead of $15.30, and a vision base also costs a projector plus
image tokens at inference. Text-only stays in the cheap lane.

Training this adapter is a **$4–50** decision, not a capital decision. The cost that
matters is iteration count and, above all, **serving** (§11.4).

### 11.2 Together AI — per-token fine-tuning, nothing to operate

Billed per 1 M tokens processed: `dataset tokens × epochs + validation tokens × evals`.
Per-model minimum charge; failed jobs are refunded in full; cancelled or
early-stopped jobs are charged for completed steps only.

| Model | SFT | DPO | Min charge |
| --- | --- | --- | --- |
| Qwen3.5 9B | $0.34 | $0.84 | $4.00 |
| Qwen3.5 4B / 2B / 0.8B | $0.34 | $0.84 | $4.00 |
| gpt-oss-20B | $0.40 | $1.00 | $4.00 |
| Gemma 4 31B (incl. VLM variant) | $1.05 | $2.62 | $4.00 |
| Qwen3.5 27B / Qwen3.6 27B / Qwen3.8 27B | $1.05 | $2.62 | $4.00 |
| Full fine-tune (not LoRA) | +$0.04/1 M on the same models | — | $4.00 |

Estimate before spending: `tg fine-tuning create` prints a price and asks for
confirmation; the console's new-job page shows it once a model and dataset are
chosen; the API has `estimate_price`. Packing on/off changes how tokens are counted
(off: `dataset_length × max_seq_length`).

**Key lever:** `tg fine-tuning download <job> --checkpoint-type merged|adapter`
exports the weights. So the cheap pattern is *train on Together per token, download
the merged weights, serve locally* — no recurring endpoint bill.

Also available: **Post-Training** (sessions + model resources) billed per minute per
active resource on B200 at $11.00/GPU/hr ($9.00 promo to 2026-12-14) — roughly
$54–66 for a 6-hour run. Overkill for a 7–9 B adapter; it exists for larger models.

### 11.3 Vast.ai — rent the GPU by the hour

Live marketplace, 1 GPU, `verification` not `deverified`, host reliability ≥ 0.98,
sampled on 2026-11-08. "Bid" = interruptible; on-demand = fixed.

| GPU | VRAM | On-demand min / median | Bid min / median | 45 M-token run (bid median) |
| --- | --- | --- | --- | --- |
| RTX 3090 | 24 GB | $0.105 / $0.218 | $0.093 / $0.160 | ~10.4 h → **$1.67** |
| RTX 4090 | 24 GB | $0.301 / $0.469 | $0.187 / $0.360 | ~6.0 h → **$2.14** |
| RTX 5090 | 32 GB | $0.456 / $0.744 | $0.238 / $0.507 | ~4.8 h → **$2.44** |
| RTX A6000 | 48 GB | $0.376 / $0.457 | $0.107 / $0.333 | ~7.4 h → **$2.45** |

Same day, earlier pass, for the two cards not re-sampled above: A100 PCIE 40 GB bid
$0.148–0.200, L40S 45 GB bid $0.333–0.400. Prices move by ~10–20 % between passes.

With images out of scope, **24 GB is enough**: 8 B QLoRA at 4 K fits comfortably and
even 8–16 K sequences fit. The 48 GB rows only matter for 16–32 K training samples or
for serving with an unquantized KV cache.

Run time is an **assumption**, not a measurement: 1.2–3.5 K tokens/s effective for
QLoRA on these cards at 4 K sequence length. Add disk (~$0.10–0.25 per 50 GB per day)
and bandwidth (offers quote ~$0.003/GB up, ~$0.002/GB down). The same box can then
serve the model for ~$2.50–5.25/day at 24/7 — cheaper than a dedicated endpoint, at
the price of reliability risk.

Cheapest reliable combinations that fit this workload:

| Need | Pick | Cost |
| --- | --- | --- |
| Iterate on prompt/data without renting anything | the existing 2×16 GB box | ~$0.27 electricity per 6 h |
| One clean adapter, zero ops | Together Qwen3.5 9B or Llama 3.1 8B SFT, then download weights | $15.30 |
| Cheapest possible, tolerate restart | Vast A100 40 GB or RTX 3090 bid, checkpoint every 30 min | ~$0.71–1.70 |
| Long samples (16–32 K), no local VRAM | Vast A6000 48 GB bid | ~$2.45 |
| Native 128 K without chunk mode | Llama 3.1 8B (131 072 ctx) served locally | $0 marginal |
| Serving after training | local GGUF (§3), not a rented endpoint | $0 marginal |

### 11.4 Decision rule

1. **Local first.** The 2×16 GB box is already paid for; use it for P0–P2 and every
   data-format experiment. 45 M tokens at ~1.2 K tokens/s is ~10 h of wall clock that
   costs nothing but electricity.
2. **Rent only for throughput or VRAM.** A 48 GB card buys sequence length the local
   box cannot hold (16–32 K training samples, or an unquantized KV cache). Bid pricing
   on an A6000 is the cheapest way to touch 48 GB; for the 4 K text workload a 24 GB
   3090/4090 is already enough.
3. **Buy the managed run when the data is final.** Together's per-token price means
   no host hunting, no spot interruption, no CUDA stack, and a refund if the job
   fails. $15 for the full adapter is less than an hour of human time spent fixing a
   rented box.
4. **Never rent to serve.** Local GGUF with quantized KV cache handles 128 K at $0
   marginal; Together dedicated inference is $5.49/GPU/hr (H100) — $132/day.

### 11.5 Guardrails

- **Spot/bid interrupts.** An interrupted instance goes to `stopped`; disk keeps
  billing. Checkpoint to a volume every 30 min, or use on-demand for the final run.
- **Minimum charges.** Together: $4.00 per job. Do not split one dataset into five
  jobs to "test" — that is $20 for $5 of tokens.
- **Endpoint creep.** A deployed model bills per minute while idle. Download the
  weights instead, or delete the endpoint the same day.
- **Unverified hosts.** Filter `verification` ≠ `deverified` and reliability ≥ 0.98;
  the $0.09/hr outliers are often unusable for a multi-hour run.
- **Data transfer.** Uploading a 20 GB dataset costs bandwidth *and* time; stage data
  via a cheap volume, not a fresh copy per instance.
- **Set a hard cap.** Decide the ceiling per phase (P1 $5, P2 $25, P3 $10) and stop at
  it; the numbers above are small enough that a runaway loop, not a price, is what
  burns budget.

### 11.6 Observed account state (2026-11-08)

Both consoles are reachable from the browser with the existing sessions and were used
read-only: Together shows no fine-tuning jobs and no post-training sessions (credit
banner present); Vast shows a $0.00 balance. Nothing was launched or purchased.

---

## 12. Field notes — published recipes and data

Collected 2026-11-08 from the Saiga project (code + configs + dataset cards) and from
Habr write-ups by teams who ran this class of job. Numbers are the sources' own.

### 12.1 Saiga 8B SFT — a real, runnable Russian config

`github.com/IlyaGusev/saiga` (`src/train_unsloth.py`, `src/dataset.py`,
`configs/models/saiga_llama3_8b_sft_m11.json`, `configs/datasets/sft_d7.json`):

- QLoRA (`load_in_4bit`), Unsloth `FastLanguageModel`, bf16, `adamw_8bit`.
- r=32, alpha=16, dropout 0, targets `q,k,v,o,gate,up,down`, `modules_to_save ["lm_head"]`.
- batch 1 × grad-accum 128, lr 5e-5 cosine, warmup 8, 2 epochs, eval/save every 8 steps,
  `load_best_model_at_end`, weight_decay 0.05, max_grad_norm 1.0, `max_seq_length 8192`.
- `only_target_loss: true` — system/user tokens are labelled `-100`, loss only on assistant
  turns (message-by-message tokenisation, hard truncation at the length limit).
- Dataset pipeline (`scripts/compose_sft_dataset.py`): drop `is_bad_by_regex`, keep
  `opus_score >= 8`, dedupe by mmh3 hash of the message list, 97/3 train/val split by hash.
- Model family in use: `saiga_llama3_8b` (Llama-3 8B base), `saiga_gemma3_12b`,
  `saiga_nemo_12b`, `saiga_yandexgpt_8b` — all with GGUF exports.

### 12.2 Habr: budget-constrained Russian SFT (~$330 / ₽30 k, 30 k pairs)

"Как за 30 000р дообучить модель…" — Qwen3.5-27B, QLoRA r=64 alpha=128, Unsloth,
ShareGPT, 95/5 split, 6 h on a rented H200 at ~$3.80/h:

- Budget split: ~$310 data generation (batch APIs: 20 k pairs from one frontier model,
  10 k from another) + ~$23 GPU. **Data, not compute, is the cost.**
- Corpus building followed CRAFT (ACL 2025): public material as seeds → generate pairs.
- Filtering kept minimal: Jaccard > 0.85 dedupe removed 0.05 %; no LLM-as-filter because
  the filter would be weaker than the generator.
- Newer architecture beat a bigger one: 27B (newer) scored 3.21 vs 32B (older) 2.69 —
  with 3× less GPU time. Training loss did not predict benchmark quality.
- Caveat worth copying: they compare to a frontier model within 0.01 — call it parity,
  not a win.

### 12.3 Habr: MTS on minimal resources (2 GPUs)

- Data strategy: ready datasets (HF, translated) + synthetic generation from own material
  + a small hand-made set (80 captions was enough to move the needle).
- **Warning about translated corpora:** machine-translated datasets are often bad
  (they saw Python code "translated" into Russian syntax). Verify adequacy or filter.
- 8-bit LoRA trained faster in memory but **degraded grammar** and slowed training;
  fp16 LoRA was better.
- Hyperparameter tuning alone gave little; **LoRA + prefix tuning** was the step change,
  and **DPO on top gave +9–13 %**.
- Best checkpoint was often mid-epoch, not at epoch end.
- Evaluation: anonymised GPT-4o judge with judge ≠ reference model; human side-by-side
  remains the gold standard; never train on the public test sets you report on.

### 12.4 Habr: Yandex document-level LLM translator

- Why paragraph-level, not sentence-level: deixis, ellipsis and lexical cohesion break
  when sentences are translated in isolation; ~1 k-token blocks capture most of the
  needed context.
- Prompt-only LLM translation is fluent but under-translates (drops blocks) and
  over-translates (invents text) — task tuning is required for meaning fidelity.
- Full fine-tuning **adopts the dataset's flaws** (translationese); PEFT (LoRA / P-Tuning)
  beat both prompt engineering and full FT.
- Synthetic data recipes: document-level back-translation (smooth, consistent lexicon),
  multi-sentence resampling (robust to long inputs, fewer hallucinations), auto-aligned
  paragraph translations (noisy, needs filtering).
- **Fluency repair:** general LLM paraphrases the literal translation, yielding
  `(source, good, bad)` triplets — the same shape DPO needs.
- They then replaced plain DPO with **CPO** (contrastive preference optimisation on raw
  model probabilities) because DPO was unstable; peak quality unchanged, variance gone.
- **Curriculum on the alignment stage:** large sentence-triplet corpus first, document
  triplets only in the final phase — mixing them 1:1 is equivalent to training on
  sentences, because sentence data outnumbers document data by an order of magnitude.
- Reporting discipline: human MQM, major errors per segment — YandexGPT **0.56** vs the
  human reference **0.50**, i.e. the honest claim is "close to human", not "better".

### 12.5 Habr: low-resource bidirectional translator (Kabardian → RU)

61 M-parameter MarianMT, one model for both directions (direction token `>>kbd<<` /
`>>ru<<`), 6 h on one rented RTX 4090 for under $10, int8 ONNX = 80 MB on an iPhone.
chrF 57.4 (ru→kbd) / 50.2 (kbd→ru), v2 60.0 / 51.5.

Most of the value is in **corpus hygiene**, which applies directly to teacher-generated
pairs:

- Synthetic-side filters (all cheap regex/statistics, no LLM): identical text ("no
  translation"), near-copy (5-gram Jaccard ≥ 0.5 vs the real side), truncated
  translation (word ratio < 0.4), and repetition loops (an n-gram repeated 3× that the
  real side does not have). On 620,952 pairs this removed 6,904 (1.24 %).
- A character-n-gram language classifier (precision 0.999) removed 860 pairs that were
  the wrong language.
- **Test-leakage check first**: 78 % of their available test pairs already appeared in
  training, so they evaluated on FLORES-200 with 50 hand-checked sentences instead.
- **Splitting bug worth copying into our pipeline:** sentence-level splitting silently
  dropped years ("В 1 965 году…" → "гъэм…"), so the pairs taught the model to delete
  dates. 2,387 pairs were repaired, 1,285 discarded. Our chunker splits by
  paragraph → sentence → line, so add a post-split check that numbers, dates, bracketed
  notes and dialogue dashes survive.
- Method discipline: write the expected result before each run, then look at samples
  before trusting the number.

### 12.6 Habr: 16 GB constraint and theory

- 8B model at fp16 needs 24–27 GB just for inference; full FT needs 84–128 GB. That is
  the whole argument for QLoRA on a 16 GB card (NF4 + double quantisation).
- On unified-memory 16 GB machines the ceiling is ~1.5 B parameters for MPS-fp16 LoRA,
  while 4-bit QLoRA reaches 3 B at 4 k context with +109 MB going 1 k→4 k.
- 4-bit quantisation did not hurt convergence (val loss 0.462 fp16 vs 0.478 4-bit).
- Practical flag from that work: `completion_only_loss=True` in TRL's `SFTTrainer`
  (the same idea as Saiga's `only_target_loss`).

### 12.7 What this changes here

- §6 recipe now carries the Saiga hyperparameters (lr 5e-5, 2 epochs, r32/a16, 8 K,
  target-only loss, lm_head saved).
- §5.1 gained the public RU corpora; §5.2 gained seed→generate and triplet recipes.
- **Direction rule for pairs:** real Russian text always on the *target* side; machine
  output only ever as the *input*. Machine errors in the source are survivable, in the
  label they become the norm (Kabardian case: 4× data with zero new human pairs).
- **Post-split guard:** after our chunker splits a chapter, assert that numbers, dates,
  bracketed notes and dialogue dashes survive on both sides. The Kabardian run lost years
  this way and taught the model to delete dates.
- **Preference tuning:** plain DPO needs ~160 GB for 7B at 2 k context (§12.3) — use CPO
  (Yandex's fix for DPO instability) or ORPO/CPO-style single-model variants, or rent for
  that one step. Never train preference pairs on a model that still fails §7 gates.
- **Evaluation:** count MQM-style major errors per segment and use a blinded judge; BLEU
  and chrF reward literal translation, which is the opposite of the literary goal.


### 12.8 Russian model and dataset landscape (verified by API)

Checked on Hugging Face, 2026-11-08 — parameters, context and licence read from the
model metadata/config, not from blog text:

| Model | Params | Native ctx | Licence | Why it matters here |
| --- | --- | --- | --- | --- |
| `Vikhrmodels/Vikhr-Nemo-12B-Instruct-R-21-09-24` | 12.2 B | 1 024 000 | Apache-2.0 | strongest RU-tuned big-context option; GGUF quants exist |
| `Vikhrmodels/QVikhr-3-8B-Instruction` | 8.2 B | 40 960 | Apache-2.0 | Qwen3-based, 8 B class, permissive |
| `yandex/YandexGPT-5-Lite-8B-instruct` | 8.0 B | 32 768 | other | vendor RU model; also `-pretrain` checkpoint for continued pretraining |
| `ai-sage/GigaChat3.1-10B-A1.8B` | 11.5 B total / 1.8 B active (MoE) | 262 144 | MIT | MoE → cheapest inference per token, long ctx, GGUF available |
| `IlyaGusev/saiga_llama3_8b` | 8.0 B | **8 192** | other | the most-downloaded RU 8 B (415 k), but only an 8 K window |

Consequence for §2: if native 128 K stays a requirement, the RU-tuned field is
`Vikhr-Nemo-12B` (1 M, Apache-2.0) or `GigaChat3.1-10B-A1.8B` (262 K, MIT); plain
`Llama 3.1 8B` remains the cheapest 128 K base and needs the adapter to supply the
Russian behaviour. Saiga is a great recipe source but not a long-context base.

Verified RU datasets beyond §5.1: `Helsinki-NLP/opus-100` (en-ru subset),
`wmt/wmt19` (ru-en), `Den4ikAI/russian_instructions` + `russian_instructions_2`,
`Den4ikAI/russian_dialogues`, `Den4ikAI/russian_code_qa`.

**Two cautions from this crawl:**

- **LLM search answers invent repo ids.** An AI summary recommended
  `IlyaGusev/ru_turbofly` and `Den4ikAI/ru_instructions`; both return 401 (do not
  exist). The real ones are `ru_turbo_alpaca` / `ru_turbo_saiga` and
  `Den4ikAI/russian_instructions`. Always resolve a dataset id through the API before
  quoting it.
- **Generic hyperparameter tables disagree with real configs.** The same AI answer gave
  r=32–64, alpha=2r, lr 2e-4…3e-4, 2–3 epochs. The published Saiga run (§12.1) uses
  r=32, alpha=16, **lr 5e-5**, 2 epochs. Treat blog/AI ranges as a search space; the
  shipped config of a working model is the evidence.

### 12.9 Repos, collections and vendor models (verified)

Every entry below was resolved through the GitHub / Hugging Face APIs on 2026-11-08;
star counts and sizes are as returned.

**Reusable code and configs**

| Repo | What is inside | Use |
| --- | --- | --- |
| `github.com/IlyaGusev/saiga` (56★, Python) | Unsloth + transformers trainers, `configs/datasets/*.json`, `configs/models/*.json`, dataset composer with score filtering | the config source for §6 |
| `github.com/IlyaGusev/rulm` (466★, notebooks) | language-model pretraining + instruction tuning experiments, RuTurboAlpaca origins | pretraining/continued-pretraining recipes |
| `github.com/Koziev/NLP_Datasets` (393★, C#) | Russian NLP corpora and augmentation tooling | extra RU text material, not SFT triples |
| `github.com/PavelKoff2025/doobuchenie-fine-tuning-open-llm` (0★, Python) | a tutorial scaffold: data pipeline accepting `.json`/`.jsonl`, instruction-output and prompt-completion formats | a checklist, not a dependency |

Frameworks named by every source, in the order they are worth trying: **Unsloth** (speed on
one GPU), **Axolotl** (YAML configs, multi-GPU), **LLaMA-Factory** (UI + broad model support).

**Collections**

- `stukenov/ekitil-bilingual-kazakh-russian-language-models` — 7 items: Qwen3-based
  bilingual KK-RU bases at 123 M / 300 M / 600 M, a 64 k BPE vocabulary
  (`ekitil-vocab-bpe-64k-kkru-v1`), plus tokenized, annotated-KK and parallel KK-RU
  corpora. The template for "small bilingual SLM with its own tokenizer" — useful as a
  cheap pilot before touching a 7-9 B model, not as a production base.
- `opendev/russian-models` — 11 items, mostly dated (`yandex/yalm-100b`,
  `sambanovasystems/SambaLingo-Russian-*`, `CohereLabs/aya-23-8B/35B`, llava). Treat as
  historical, not as a shortlist.

**Vendor weights now open**

- `yandex/AliceAI-Foundation-80B-A3B-Base` — 81.3 B total / 3 B active MoE, 262 144 ctx,
  48 layers, 2 KV heads, **Apache-2.0**, trained from scratch (announced on Habr
  2026-09-21). Too large for a 16 GB card (Q4 ≈ 45 GB) and it is a *base* model, so it is
  a candidate teacher via API, not a local student. Yandex also published
  `yandex/AliceAI-T5-35B-A0.6B` and the ru factuality benchmarks `yandex/WikiWebFacts`
  (1 K–10 K QA) and `yandex/HardMultiQA` (100–1 K QA).
- `yandex/YandexGPT-5-Lite-8B-instruct` + `-pretrain` (+ GGUF) — the 8 B tier; the
  `-pretrain` checkpoint is the interesting one for continued pretraining on book text.
- `t-tech/T-Wix` — Russian hybrid-reasoning SFT set (~500 k samples per the paper; the
  card declares 100 M–1 B rows), ru+en.

Note on HF search: `yandex/yambda` ("Yambda-5B", 1 B–10 B rows, 21 k downloads) is a
recommender-systems interaction dataset, **not** text SFT — it keeps surfacing in
"yandex dataset" searches and is irrelevant here.

### 12.10 Habr: TorchTune 7B full FT, and why 6 k pairs was called thin

`habr.com/ru/articles/810473/` (efreelancer, 2024-04-26) — a Russian "toxification" model
whose purpose was to mass-generate synthetic detox training data:

- **Full fine-tuning**, not LoRA: TorchTune `full_finetune_single_device` with the
  `llama2/7B_full_low_memory` recipe, Llama-2-7b, 3 epochs, batch 10, **~3 h on an RTX 4090**.
- Data: `evilfreelancer/toxicator-ru` built from `russe_detox_2022` (~6 k rows) — for each row
  they kept the single neutral variant with the smallest Levenshtein distance and emitted
  Alpaca triples (`instruction`/`input`/`output`), loaded through `instruct_dataset` with
  `train_on_input: True`.
- **No lr, no seq length in the article**; no benchmark either — 100 hand-inspected samples
  were the entire evaluation.
- Failure mode worth knowing: on some inputs the tuned model **returns the input unchanged**.
  That is the same class as our "chatter / unrequested edits" failures — SFT on a narrow
  transformation teaches the identity shortcut, and the model must be pushed off it with
  contrastive examples.
- TorchTune (0.1.1) limits: one dataset at a time (no mixing), no custom model/dataset
  classes, and it writes tuned weights **into the download directory**, so files must be
  renamed before publishing, e.g. `hf_model_0001_2.pt` → `pytorch_model-00001-of-00002.bin`.

Reading for our plan: 7B full FT in 3 GPU-hours is real — but on a 24 GB RTX 4090, not on
16 GB, and with no reported lr to copy. Use it as the "full FT is affordable at 24 GB"
data point, and take the identity-shortcut warning seriously.

### 12.11 Habr / OTUS: the numbers behind the VRAM advice

`habr.com/ru/companies/otus/articles/1026700/` — a 2026 translation of a practical guide.
The parts that matter, verbatim figures:

- **VRAM:** full FT 7B needs 48 GB+; LoRA 16–24 GB; QLoRA 8–12 GB; 8B QLoRA fits **<10 GB at
  seq ≤512, batch 1** with gradient checkpointing; 13B needs 16 GB+ even with QLoRA.
  Memory math: 2 B/param bf16 (7B ≈ 14 GB weights) + ~8 B/param AdamW state + gradient buffers.
- **Time:** 5 000 examples × 3 epochs at seq 2048 — 1–2 h on a 4090, 2–4 h on a 4070 Ti.
- **Dataset size:** 500–1 000 examples already gives gains for formatting/classification;
  3 000–10 000 for instruction following or domain adaptation; beyond 10 000 returns diminish.
  Below 200–300 examples fine-tuning is overkill.
- **Pipeline:** SHA-256 dedupe on instruction+response, drop responses outside 50–4 000 chars,
  `val_ratio=0.1`, fixed seed.
- **Config named:** `unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit`, `max_seq_length=2048`,
  `r=16, lora_alpha=32, lora_dropout=0.05` on all seven projections, `use_gradient_checkpointing="unsloth"`,
  batch 4 × accum 4, `warmup_steps=50`, 3 epochs, lr 2e-4, `paged_adamw_8bit`, cosine,
  `packing=True`, `load_best_model_at_end` on `eval_loss`, torch 2.5.1 / transformers 4.48 /
  trl 0.14 / bitsandbytes 0.45.
- **Rank guidance:** 8 for format/style, 16–32 for moderate domain shift, 64 for new knowledge.
  **Epochs:** 1–3 above 5 000 examples, 3–5 below 1 000.
- **Pitfalls:** label leakage from answer-in-input; mixed Markdown/plain formatting teaching
  noise; loss not converging → lr too high or a broken chat template; catastrophic forgetting
  → cut epochs/lr/rank and mix 5–10 % general instruction data; OOM → batch first, then
  gradient accumulation, then seq length or rank.
- **Export:** merge in bf16 (`save_pretrained_merged`, `merged_16bit`), then
  `save_pretrained_gguf("q4_k_m")`; 8B sizes 4.9 / 5.7 / 8.5 GB for Q4_K_M / Q5_K_M / Q8_0.

### 12.12 Habr / Cloud.ru: the synthetic-data ceiling

`habr.com/ru/companies/cloud_ru/articles/875588/` — an analytics column, **no training run**
and no hyperparameters; it is cited here only for its argument:

- Web text for pretraining is treated as a spent resource; "more of the same" is not a lever.
- Augmentation stays tethered to real data; synthetic generation does not, and models cannot
  detect their own errors → documented model collapse (Nature s41586-024-07566-y).
- Synthetic data worked where synthesis was a **single controlled iteration** (protein
  folding); iterating synthesis on synthesis degrades.

Consequence for §5.2: generate teacher pairs **once**, from real source text, keep the real
targets (ficbook / librusec / opus-100) as anchors, and never train on pairs produced by a
model that was itself trained on model-produced pairs.

### 12.13 Sources

- Saiga training code and configs — github.com/IlyaGusev/saiga (`src/train_unsloth.py`,
  `src/dataset.py`, `configs/models/saiga_llama3_8b_sft_m11.json`, `configs/datasets/sft_d7.json`).
- Saiga models and dataset cards — huggingface.co/IlyaGusev (`saiga_llama3_8b`,
  `saiga_gemma3_12b`, `saiga_nemo_12b`; `saiga_scored`, `ficbook`, `librusec_full`, `gazeta`).
- "Как дообучать локальные LLM в 2026 году" — habr.com/ru/companies/otus/articles/1026700/
- "Квантизация больших языковых моделей: FP32, BF16, INT8, NF4 и QLoRA" — habr.com/ru/articles/1035626/
- "Как за 30 000р дообучить модель…" — habr.com/ru/articles/1026516/
- "Поиск данных, прокачанная тренировка и судейская оценка" (МТС) — habr.com/ru/companies/ru_mts/articles/844430/
- "Как мы создавали новый LLM-переводчик Яндекса" — habr.com/ru/companies/yandex/articles/884416/
- "Кабардинский переводчик, часть 2" — habr.com/ru/articles/1090776/
- "Дообучение модели токсичности на TorchTune" — habr.com/ru/articles/810473/
- "Данные для обучения моделей иссякли. Что будет дальше?" — habr.com/ru/companies/cloud_ru/articles/875588/
- "Как дообучать локальные LLM в 2026 году" — habr.com/ru/companies/otus/articles/1026700/
- "Открываем AliceAI-Foundation-80B-A3B-Base" — habr.com/ru/companies/yandex/articles/1083300/
- "PyTorch MPS против Apple MLX: дообучение на 16 ГБ" — habr.com/ru/companies/otus/articles/1090656/
- Model/dataset metadata (params, context, licence) — huggingface.co/api/models, huggingface.co/api/datasets

---

## 13. Link registry (verified 2026-11-08)

Everything here was resolved through an API, not copied from a summary. Row counts come
from `datasets-server.huggingface.co/info`; stars from the GitHub API; paper titles from
the arXiv API. Where a number could not be read, it says "not exposed" — that is a fact
about the dataset (script-based, no parquet), not a reason to guess.

### 13.1 Russian instruction / SFT datasets

| Dataset | Rows | Licence | What it is, and the caveat |
| --- | --- | --- | --- |
| `Vikhrmodels/GrandMaster-PRO-MAX` | 155 113 (151 822 train / 3 291 test) | Apache-2.0 | answers generated from scratch by GPT-4-Turbo-1106, **not** translated — the best-quality native RU SFT set of the ones checked |
| `d0rj/ru-instruct` | 753 650 | Apache-2.0 | large synthetic/translated instruction mix; volume, not curation |
| `Den4ikAI/russian_instructions` | 52 930 | MIT | compact general RU instruction set |
| `t-tech/T-Wix` | ~500 k samples (card declares 100 M–1 B rows) | see card | hybrid-reasoning SFT, ru+en |
| `Vikhrmodels/Veles-2.5` | not exposed | see card | OpenHermes-2.5 **translated** into Russian with GPT-3.5/4 → translationese risk |
| `IlyaGusev/ru_turbo_saiga` / `ru_turbo_alpaca` / `ru_sharegpt_cleaned` | not exposed | CC-BY-4.0 | the Saiga instruction lineage; small but clean |
| `nextdppr/russian-medical-100m` | not exposed (card claims 100 M pairs) | Apache-2.0 | medical domain; useful only as a terminology style sample |
| `DaniilMako/even-russian-instructions` | not exposed (card claims 113 k) | **CC-BY-NC-4.0** | non-commercial licence — check before shipping |
| `bond005/NEREL_instruct` | not exposed (<10 k) | MIT | NER/relations turned into prompts |
| `MERA-evaluation/MERA` | benchmark, 2 290 downloads | MIT | 20+ RU tasks in instruction form (§13.4) |

### 13.2 Literary, parallel and target-side prose

| Dataset | Rows | Licence | Use |
| --- | --- | --- | --- |
| `Imperius/ru-classic` | 6 903 506 | CC0-1.0 | 866 MB of clean 19th–early-20th c. Russian prose, 61 authors, from lib.ru — **real target-side style** |
| `IlyaGusev/ficbook` | 1 390 475 stories | see card | modern Russian prose, dialogue, names (§5.1) |
| `IlyaGusev/librusec_full` | 496 858 books | see card | broad genre coverage, translator credits |
| `KvaytG/en-ru-parallel-20m` | 20 000 000 | other | the biggest EN-RU pair pool found; must be filtered, not trusted |
| `limloop/ru_en_story_pairs` | 118 499 | MIT | RU-EN story pairs (~500–800 words each); card carries a content notice |
| `SagiAbd/KazLit-Parallel` | 71 096 pairs (card) | CC-BY-4.0 | KK/RU/EN literary alignment |
| `KvaytG/en-ru-parallel-books` | not exposed | Apache-2.0 | sci-fi books, sentence-aligned — small, clean |
| `issai/kazparc` | not exposed | see card | KK/RU/EN/TR, human + synthetic mix |
| `Helsinki-NLP/opus-100` | not exposed | CC-BY-4.0 | general EN-RU pairs (§12.8) |
| `wmt/wmt19` | not exposed | see card | news-domain EN-RU |
| `lab-ii/translate`, `RUCAIBox/Translation` | not exposed | CC-BY-4.0 / see card | exist; verify contents before use |

### 13.3 Proofreading, spelling and GEC

Counts below were read from the datasets server or the card, and the nesting is the point:
these collections overlap heavily, so adding rows across them double-counts.

| Dataset | Rows | Licence | What it actually is |
| --- | --- | --- | --- |
| `melsmm/spell-correction-ru` | 1 030 565 (999 998 `synth_1m` + 30 567 `ready_30k`) | Apache-2.0 | synth: injected char/word/punctuation corruption + **50 k identity no-ops**; `ready_30k` is human and is itself dreux (24 998) + MultidomainGold (3 569) + RUSpellRU (2 000) |
| `ai-forever/spellcheck_punctuation_benchmark` | 13 605 (RUSpellRU 2 000 / MultidomainGold 3 569 train + 4 106 test / MedSpellcheck 1 054 / GitHubTypoCorpusRu 868) | MIT | **human**, 2-stage Toloka annotation, punctuation re-annotated by professional editors; spelling + punctuation only, no grammar |
| `dreuxx26/russian_gec` | 24 998 (not 25 362) | CC-BY-4.0 | templated single-token agreement fixes, **max 19 tokens**; prompt prefix is Spanish ("corregir ruso:") — a bug |
| `RussianNLP/RuSpellGold` | 1 711 (literature shard only 260) | Apache-2.0 | human, spelling only, test-only, many no-op rows |
| `p1746-lingua/ru-gec-v1` | 707 261 claimed | Apache-2.0 | **gated (manual approval)** — could not be inspected; no provenance beyond an integer `source` |
| `DenisB99/russian-spell-correction-dataset` | 1 184 (word-level pairs) | none declared | no README, no licence, 64 % identity rows |

Distinct **human** sentences across all six are roughly **30–35 k**, not 1.8 M. Nothing here
has span/edit-level (M2/ERRANT) labels — every set is whole-sentence pairs, which teaches
paraphrase rather than minimal correction. And literary prose is essentially absent: those
sets stop at ~19–40 tokens with no dialogue dashes, no multi-voice paragraphing, no
long-range agreement. Dialogue punctuation and long-range agreement have to be synthesised
with rules and editor validation (§15.5).

### 13.4 Benchmarks

`MERA-evaluation/MERA` (MIT, 20+ tasks) · `RussianNLP/russian_super_glue` (lowercase id —
`RussianNLP/RussianSuperGlue` returns 401) · `zouhar/last-translation-benchmark` (CC-BY-4.0)
· `yandex/WikiWebFacts` (1 K–10 K) · `yandex/HardMultiQA` (100–1 K).

### 13.5 Models

§12.8 has the RU shortlist with parameters, licence and context. Additions verified here:
`yandex/AliceAI-Foundation-80B-A3B-Base` (81.3 B / 3 B active, Apache-2.0, 262 144 ctx) ·
`yandex/AliceAI-T5-35B-A0.6B` · `Vikhrmodels/Vikhr-Nemo-12B-Instruct-R-21-09-24` ·
`Vikhrmodels/QVikhr-3-8B-Instruction` · `ai-sage/GigaChat3.1-10B-A1.8B` (MIT, MoE) ·
`yandex/YandexGPT-5-Lite-8B-instruct` and `-pretrain` (+GGUF) · `IlyaGusev/saiga_llama3_8b`
(8 K ctx only).

### 13.6 Code and tooling

| Repo | ★ | Role |
| --- | --- | --- |
| `github.com/hiyouga/LlamaFactory` | 75 932 | UI + YAML recipes for 100+ models; `lora_rank`/`lora_alpha`/`quantization_bit` in one file |
| `github.com/axolotl-ai-cloud/axolotl` | 12 673 | YAML pipelines, packing, `paged_adamw_8bit`, multi-GPU |
| `github.com/pytorch/torchtune` | 5 821 | PyTorch-native recipes; `recipes/configs/llama3_1/8B_qlora_single_device.yaml` = r 8, alpha 16, lr 3e-4, batch 2, 1 epoch |
| `github.com/datajuicer/data-juicer` | 7 228 | corpus cleaning/filtering at scale (operators, not prompts) |
| `github.com/argilla-io/argilla` | 5 195 | human review/annotation of generated pairs |
| `github.com/argilla-io/distilabel` | 3 453 | pipeline framework for synthetic data with LLM judges |
| `github.com/batsresearch/bonito` | 829 | ungated local model that turns raw documents into SFT pairs |
| `github.com/argilla-io/synthetic-data-generator` | 589 | small helper for dataset generation |
| `github.com/TemporaryLoRA/Temp-LoRA` | 128 | inference-time LoRA for long-document generation (§13.7) |
| `github.com/IlyaGusev/saiga` / `rulm` | 56 / 466 | the config source for §6 |
| `github.com/Koziev/NLP_Datasets` | 393 | RU corpora and augmentation tooling |

### 13.7 Papers worth reading before you spend money

| arXiv | Date | Why it matters here |
| --- | --- | --- |
| `2601.14277` | 2026-01-11 | "Which Quantization Should I Use?" — unified llama.cpp quant evaluation on Llama-3.1-8B; decides Q4_K_M vs Q5_K_M on evidence |
| `2509.07829` | 2025-09-09 | EN→RO literary translation resources built with open models — closest published analogue to this project |
| `2409.16539` | 2024-09-25 | context-aware, style-related incremental decoding for discourse-level literary translation |
| `2401.11504` | 2024-01-21 | Temp-LoRA: inference-time training improves long-text generation (d-BLEU/PPL gains on a novel-translation benchmark) |
| `2605.09015` | 2026-05-09 | LLiMba: adapting a 3 B model to a low-resource language on one GPU — the tokenizer/corpus playbook |
| `2409.06820` | 2024-09-09 | PingPong: multi-model judge protocol (how to evaluate without a human panel) |
| `2406.12822` | 2024-06-18 | separates translation defects from knowledge gaps in multilingual instruction data (round-trip test) |
| `2405.13929` | 2024-05-22 | Vikhr: the Russian instruction-tuned family — tokenizer additions and RU SFT data |
| `2603.10351` | 2026-03-11 | translationese bias in LLM-as-judge, and how to disentangle it |
| `2603.12050` | 2026-03-12 | translationese as a rational response to task difficulty |
| `2605.14890` | 2026-05-14 | tokenizer fertility vs zero-shot quality (measured on legal text) |

### 13.8 How to check a link before trusting it

Three calls settle almost everything:

- **HF dataset exists and how big** — `huggingface.co/api/datasets/<id>` for metadata and
  licence, then `datasets-server.huggingface.co/info?dataset=<id>` for `num_examples`.
  `401` means the repo does not exist or is gated; `501` means it is script-based with no
  parquet, so read the card instead. Never quote a row count you did not read this way.
- **GitHub repo is real** — `api.github.com/repos/<owner>/<repo>` (stars, `pushed_at`,
  `archived`). A repo that exists with 0 stars and one commit is a tutorial, not a dependency.
- **Paper is real** — `export.arxiv.org/api/query?id_list=<id>` and read the `<entry>`
  `<title>`; a malformed id returns an entry saying "Error", which naive parsing misses.

This is not pedantry: of the identifiers produced by an AI summary during this research,
two did not exist (`IlyaGusev/ru_turbofly`, `Den4ikAI/ru_instructions`) and two numbers were
wrong (`limloop/ru_en_story_pairs` is 118 499 rows, not "1 K–10 K"; `dreuxx26/russian_gec`
is 24 998, not 25 362).

### 13.9 Aligning parallel text (for building the training pairs)

| Tool | ★ | Notes |
| --- | --- | --- |
| `github.com/bfsujason/bertalign` | 167 | LaBSE embeddings + two-step DP; built for literary texts where 1-to-many mappings are normal |
| `github.com/thompsonb/vecalign` | 204 | linear-time Vecalign reimplementation; good for large corpora |
| `github.com/danielvarga/hunalign` | 132 | dictionary-based, fast, still fine for clean sentence-per-line input |
| `github.com/xy-cypher/LF-aligner` | 4 | Perl, translator-facing GUI; not for pipelines |

For our case (chapter → paragraph → sentence), align at paragraph level with Bertalign and
keep sentence alignment only inside aligned paragraphs; alignment errors at sentence level
are exactly the "near-copy / truncated pair" failures that the Kabardian run filtered out
by hand (§12.5).

### 13.10 Enforcing the output protocol at inference

The `mt` protocol is strict (XML blocks, `N=text` properties, one `<terms>` JSON). Instead of
hoping the model complies, the grammar can be imposed:

- `github.com/ggml-org/llama.cpp/tree/master/grammars` — GBNF grammars for llama.cpp; a GBNF
  file can force the exact block order, line count and JSON shape.
- vLLM structured outputs (`choice` / `regex` / `json` / `grammar`) — same idea server-side.
- `outlines`, `guidance`, `xgrammar` — library-level constrained decoding if the runtime is
  Python rather than llama.cpp.

Constraining decoding removes structure-loss and schema-drift failures (§9) at zero training
cost, leaving SFT to fix semantics and style. It is not free: grammar enforcement can bias the
model toward short, degenerate output if the grammar is stricter than the natural reply, so
gate it with the same §7 checks.

### 13.11 Evaluation tooling

| Tool | Where | Cost profile |
| --- | --- | --- |
| `github.com/Unbabel/COMET` (789★) | local, `wmt22-comet-da` | reference-based, cheap on CPU/one GPU |
| `github.com/NL2G/xCOMET-lite` (7★) | local, 278 M params | reference-free, keeps most of the quality of the 10.7 B XXL variant |
| `google/metricx-24-hybrid-xl-v2p6` on HF (78 k downloads) | local | strong MQM correlation; heavier than xCOMET-lite |

Metric choice matters less than the protocol: report COMET **and** a blinded judge **and**
major-error counts on a hand-checked sample, because lexical metrics reward literal
translation, which is the opposite of the literary goal (§12.4).

---

## 14. Second sweep — serving numbers, tokenizer economics, SFT lessons, evaluation practice

Numbers below come from the 20 Habr posts read in the second sweep; each claim is attached
to the post that states it (§14.7). Where a source reports no measurement, it says so.

### 14.1 Serving 7–9B at 128 K on 16 GB — what is actually measured

- **Weights:** `Q4_K_M` is the default recommendation in the Russian quant survey; ~4.9 GB
  for 8 B. `Q5_K_M` when VRAM is spare, `Q8_0` near-lossless, `Q2_K` only for weak hardware.
- **KV on stock llama.cpp:** 128 KB/token × 131 072 = 16 GiB FP16, **8 GiB at `-ctk q8_0
  -ctv q8_0`** → with weights that is **~12.9 GiB**, which fits 16 GB with little slack and
  forbids a draft model. `-ctk q8_0 -ctv q4_0` (§3) is the tighter variant.
- **KV on the TurboQuant fork:** `-ctk tbqp3 -ctv tbq3` is advertised at **4.71×** less
  memory, i.e. ~3.4 GiB KV and **~9.3 GiB total** at 128 K. Measured on a 27 B model at
  256 K: ~18 GB stock 2-bit vs **~12 GB** with TurboQuant, **~45–50 tok/s**; the vendor
  claims the KV at that setting is ~8 % better than FP16 and 2-bit weights keep ~95 % of
  FP16 quality. Caveat: CUDA-only fork, no CPU/Vulkan backend, and `tbq*` does not exist in
  stock llama.cpp.
- **imatrix calibration (worth doing for a literary model):**
  `llama-imatrix -m model-F16.gguf -f calib.txt -o model.imatrix.gguf --n-gpu-layers 10`
  on ~500 samples of Russian Wikipedia (`wikimedia/wikipedia`, `20231101.ru`), then
  `llama-quantize --imatrix model.imatrix.gguf model-F16.gguf model-Q4_K_M.gguf Q4_K_M`.
  The imatrix file is 1–2 MB for dense models. The post's framing is useful: calibration is
  "LoRA in reverse" — quantisation error is weighted by what the production text actually
  exercises, so calibrate on *your* chapters, not on Wikipedia, if you can.
- **Weight quantisation, measured** (llama.cpp, Llama-3.1-8B-Instruct, FP16 = 14.96 GiB,
  13 schemes, GSM8K / HellaSwag / IFEval / MMLU / TruthfulQA / WikiText-2 PPL):

  | Quant | GiB | Avg score | IFEval | PPL |
  | --- | --- | --- | --- | --- |
  | F16 | 14.96 | 69.47 | 78.93 | 7.32 |
  | Q3_K_S | 3.41 | 65.49 (−5.7 %) | 73.89 | 8.96 |
  | Q3_K_M | 3.74 | 68.07 | 77.19 | 7.96 |
  | Q3_K_L | 4.02 | 68.78 | 79.14 | 7.81 |
  | Q4_0 | 4.33 | 67.98 | 77.46 | 7.74 |
  | **Q4_K_S** | **4.36** | **69.17** | **80.26** | 7.62 |
  | Q4_K_M | 4.58 | 69.15 | 79.06 | 7.56 |
  | Q5_0 | 5.21 | 69.92 | 80.14 | 7.43 |
  | Q5_K_M | 5.33 | 69.36 | 78.67 | 7.40 |
  | Q6_K | 6.14 | 69.23 | 77.63 | 7.35 |
  | Q8_0 | 7.95 | 69.41 | 78.79 | 7.33 |

  Everything from 4 to 8 bit is inside noise of FP16; **degradation starts at 3 bit**, and the
  first thing to break is *format compliance*, not reasoning: GSM8K strict-match collapses
  24.64 → 9.86 (Q3_K_M) and → 10.54 (Q3_K_L) while flexible-extract stays ~73–74. For a
  protocol model that is the failure mode that matters. **Q4_K_S is the smallest safe quant**
  (IFEval 80.26 vs 78.93 at F16), **Q5_0** buys margin for +0.85 GiB, and 3-bit is out. The
  study tested neither imatrix nor i-quants, so verify the parser end-to-end after quantising.
- **Practical command (stock build, 128 K, 8 B):**
  `llama-server -m model-Q4_K_M.gguf -c 131072 -ngl 99 -fa --no-context-shift -ctk q8_0 -ctv q4_0 --port 8080`.

Two warnings that came out of the same posts: the 27 B article's 8 GB/12 GB figures are for
2-bit weights, not for 8 B at Q4; and one Russian report had a GGUF export of a
sparse-attention model break past 128 tokens (PPL 10 → 50) until a patch was applied — after
any conversion, re-measure long-context perplexity instead of assuming parity (§14.3).

### 14.2 Tokenizer economics decides cost per character, not per token

Measured characters-per-token on Russian text, 11 tokenizers (higher = cheaper):

| Tokenizer | RU chars/token | RU/EN ratio |
| --- | --- | --- |
| YandexGPT 5 Lite | 5.11 | 0.91 |
| GigaChat 3 | 4.87 | 0.96 |
| Grok 4.7 / o200k / Gemini 3.7 Flash / GLM-5.3 | 4.05 / 4.01 / 3.98 / 3.89 | 1.18–1.23 |
| DeepSeek V3/V4 | 3.44 | 1.38 |
| Qwen 3 | 3.13 | 1.52 |
| Kimi K3 | 2.56 | 1.86 |
| cl100k (GPT-4) | 2.29 | 2.09 |
| Claude Opus 5 | **1.03** | **2.96** |

Consequences that matter for a Russian pipeline:

- A ~6-character Russian word is **~1.5 tokens** on o200k-class tokenizers but **~5.8 tokens**
  on the worst one — the same manuscript can cost 4–5× more context.
- A 500 k-character novel is ~125 k tokens on o200k and ~485 k on the worst tokenizer, so
  "does it fit in 128 K" is a property of the tokenizer as much as of the model.
- At equal list price per token, Russian costs **3.9×** more on the worst tokenizer than on
  GPT-5.5-class (531.8 vs 137.7 ₽ per million characters). Price per token is not the
  decision variable — price per million characters is.
- Russian-native tokenizers (YandexGPT, GigaChat) put *more* Russian than English per token,
  so a RU-heavy pipeline can be cheaper per character at a higher per-token price.
- Tooling: `github.com/donseo-info/ru-token-tax` (★2) — the measurement harness behind that
  table.
- **Data and vocabulary beat parameters for a narrow direction.** The VK RU↔KK system is a
  197 M-parameter T5 trained from scratch on 9 054 960 pairs (after cleaning down from
  ~12.3 M), joint SentencePiece vocabulary of **8 000** — a 16 000-unit vocabulary was
  measurably worse — and it beat T5-Large (738 M) and every NLLB size on RU→KK chrF
  (+22.16 chrF over NLLB-200 3.3 B on the LoResMT 2026 test set). Two takeaways: aggressive
  near-duplicate removal (MinHash-LSH) *hurt* and was dropped, and for one narrow translation
  direction a small model plus a curated corpus is competitive. Models: `deepvk/kazRush-ru-kk`,
  `deepvk/kazRush-kk-ru` (0.2 B each).

### 14.3 What SFT actually changes — evidence from Russian runs

- **Template beats prose.** In the ruGPT-3 XL 1.3B SFT run, `<|user|>…<|assistant|>…<|endoftext|>`
  converged better and was more stable than «Вопрос:/Ответ:», and evaluation prompts had to
  reproduce the template exactly, trailing role marker included.
- **Select checkpoints by generation, not by loss.** The WH40K SFT run went from loss 3.7 to
  2.1 while output degraded into loops, tautology and entity swaps; 15 epochs on a small QA
  set is overfitting with a falling loss curve.
- **SFT costs domain ability.** The 112 M Russian model reports BPC before → after SFT:
  web 1.18 → 1.22, articles 1.02 → 1.07, chat 0.92 → 0.91. Chat improves, everything else
  regresses — so log prose BPC on held-out chapters, not only instruction-following scores.
- **Scale of the SFT set matters less than curation, but the ceiling is real.** A working
  chat model came from 31 k curated records (42 M tokens, 2 epochs, ~1.5 h/epoch on
  ruGPT-3 XL), while full FT on 1.8 M records (0.92 B tokens) wrecked the same model
  (forgetting, keyword soup, topic drift). At 7–9 B, use LoRA/QLoRA for any large or mixed
  set; full FT only on curated prose.
- **Prompt length as a data problem.** The Yandex Cloud LoRA run (Qwen-class base,
  YandexGPT Lite) reached **9.5/10** on strict-format tasks from **~1 000 pairs**, against
  6/10 for prompt-tuning with 10–100 examples; 90 % of the gain came from the first 20 % of
  examples, which is an argument for diversity over volume. Its failures were not Russian
  grammar but over-long, overloaded instructions and format drift (§9).
- **DoRA is a dead end here.** 2–2.7× slower and **no GGUF conversion** in that run.

### 14.4 Preference tuning: the real memory numbers

| Method | Models in memory | 7 B memory (FP16) | Data |
| --- | --- | --- | --- |
| RLHF + PPO | 4 (policy, ref, reward, critic) | ~112 GB peak | tens of thousands of pairs |
| DPO | 2 (policy + frozen ref) | ~56 GB | preference pairs |
| SimPO / ORPO | 1 (no ref model) | below DPO | preference pairs |
| KTO | 2 | — | binary good/bad labels |

DPO settings named: lr **5e-7…5e-6** (5–50× below SFT), beta 0.1–0.5 (start 0.1), r 16,
1–3 epochs, batch 4–8. Data rule: **2 000 pairs over 1 000 distinct prompts beats 10 000
pairs over 500 prompts**; inter-annotator agreement below 70 % means the pairs are noise
(use IPO instead). Reported DPO gains: parity with RLHF within ±1–2 %, but a 10–15 %
off-distribution drop to watch for.

This is stricter than the "~160 GB" figure quoted earlier from the MTS post: 56 GB is the
FP16 estimate for 7 B, 160 GB is what the MTS team measured for their setup. Either way the
conclusion holds — DPO does not fit 16 GB at 8 K context; it fits only with a much shorter
`max_length` and a 4-bit policy, or on a single-model variant (SimPO/ORPO).

### 14.5 Evaluation practice worth copying

- **Three judges from different vendors, never one**, and never let a model judge its own
  output. The measured self-judging bias was **+0.7** (one vendor) and **+1.1** (another);
  after excluding self-judging the ranking changed. Per-question disagreement above 2 points
  ran at 25 % / 21 % / 7 % / 4 % across the four weaker models — that spread is the error bar
  your single-judge number hides.
- **Add an explicit target-language dimension** scoring grammar, terminology and *absence of
  calques*, with hard floors: a refusal caps the accuracy score, a non-Russian answer scores
  zero on that dimension. This is the one dimension that separates "fluent" from "translated".
- **Rank error types by frequency, then work the top bucket.** The localization post's
  taxonomy — translation errors >80 %, idiom errors, omissions — maps almost directly onto
  literary work: idiom/proverb, culture-bound realia, dialogue register, allusion, and
  terminology consistency across chapters.
- **The glossary is a precondition, not an output.** Two documented failures: «брак» read as
  "marriage" instead of "defective goods" without context, and a translator's
  «Северус Снегг» → «Злодеус Злей», which changed how readers experienced the character.
  Names, nicknames, invented terms and honorifics must be fixed before generation and
  re-checked after.
- **Fix the harness before believing a score:** reproducible stratified sampling with a seed,
  temperature 0, reference answers with citations, and a token budget that survives reasoning
  models. Reported harness failures: a non-ASCII header killed 400/400 requests; reasoning
  truncation produced 77/200 empty answers; a judge returned truncated JSON on 200/200 calls.
- Benchmark to copy the protocol from: `github.com/csylabs-org/lii-sport-bench-ru` (655
  expert questions, 4-dimension judging prompt, ~$150 for the whole 3-judge run).

### 14.6 Data sizing and protocol-specific rules

- **30–50** validated examples are enough for style transfer with a strong model; converting a
  base model into an instruct model takes tens of thousands. For a *protocol* (structure, not
  tone) start at **300–500 hand-validated triples** — ~10× the style floor, ~1 % of the
  instruct scale.
- **Schema-validity rate is the primary metric**, not accuracy: an executable gate
  (parser/regex/JSON schema) discards non-conforming replies, and the pass rate is the number
  you optimise.
- **Packing only with an explicit per-sample EOS/terminator**, otherwise the protocol boundary
  leaks between packed samples. Saiga's per-message tokenisation with `-100` labels is the
  same idea from the other side.
- **Negatives are first-class data**: inputs that must yield a refusal or a fixed error
  envelope. Both named failure modes ("correct but inadequate", "accuracy fluctuates on edge
  cases") come from an unconstrained output space, not from too few positive examples.
- **If the set is model-generated, check it structurally** before training: marker n-grams,
  reply-length distribution, per-field value entropy. The Sber series formalises the test —
  a node with α > 0.5 of its neighbours inside its own block, a Laplacian spectrum clustered
  near zero, a marker token with Pr(T) ≈ ε on real data and ≫ ε on synthetic.
- **Prefix tuning is worth exactly one arm.** The published 0.1 %-of-parameters result
  (≈ full FT in low-data regimes) is GPT-2-era and about style/context steering; it cannot be
  merged into weights, so it costs permanent inference overhead. One 1–2 day A/B against
  QLoRA on identical data, otherwise skip.
- **If you extend the tokenizer, train `embed_tokens` and `lm_head`.** With an unchanged
  tokenizer (the plan here) leave both alone.

### 14.7 Sources for this section

`habr.com/ru/companies/raft/articles/932504/` (Qwen3-8B QLoRA on a 4090, seven runs) ·
`habr.com/ru/companies/otus/articles/935286/` (LoRA/QLoRA overview) ·
`habr.com/ru/articles/1059792/` (27 B at 256 K in 8–12 GB, TurboQuant) ·
`habr.com/ru/companies/cloud_ru/articles/1069004/` (quantisation ladder) ·
`habr.com/ru/articles/953682/` (imatrix calibration) ·
`habr.com/ru/companies/vk/articles/1103230/` (kazRush, data over parameters) ·
`habr.com/ru/articles/1089148/` (tokenizer cost per character) ·
`habr.com/ru/articles/1002298/` (RLHF → DPO → GRPO ladder) · `habr.com/ru/articles/972722/` (SFT vs RL) ·
`habr.com/ru/articles/1060976/`, `1098612`, `1016148`, `1045724` (Russian SFT / from-scratch runs) ·
`habr.com/ru/articles/1005160/`, `925886`, `791966` (PEFT comparison) ·
`habr.com/ru/companies/yandex_cloud_and_infra/articles/884336/`, `habr.com/ru/articles/886762/`, `1036448` (evaluation practice) ·
`habr.com/ru/articles/829324/`, `829318`, `habr.com/ru/companies/sberbank/articles/943168/` (SFT data and synthetic-data validation).

Models/artifacts referenced: `deepvk/kazRush-ru-kk`, `deepvk/kazRush-kk-ru` (0.2 B each) ·
`prism-ml/Ternary-Bonsai-27B-gguf` (306 k downloads) · `AmesianX/TurboQuant` (★92) ·
`donseo-info/ru-token-tax` · `csylabs-org/lii-sport-bench-ru` · `Golden-Gekko/LinguaLaboratoriumMechanicus`
(★2) + `GoldenGekko/LinguaLaboratoriumMechanicus` · `lubenkov/jarvis` (★5) + `Eragon1/jarvis-112m` ·
`EvilFreelancer/rugpt3xl-convert` (★2) + `evilfreelancer/ruGPT3XL` (1.42 B) ·
`shannonkun/rugpt3xl-1.3b-sft` (1.42 B; the `-dpo` repo does not exist) ·
`artem-durynin/Unsloth_article` (the Qwen3-8B run's dataset) ·
`ai-forever/fbc3_aij2023` (★21, METEOR metric notes).

---

## 15. Deep dives — the papers that answer the open questions

### 15.1 A published template for exactly this job: EN→RO literary translation (arXiv 2509.07829)

The closest published analogue to this project (fables rather than novels, but the same
shape). Four stages, in their order:

1. **Benchmark 13 systems on a small judged sample** — GPT-o3, GPT-4.1, Gemini, Grok, DeepL,
   EuroLLM-9B, Qwen3-14B, Gemma-3-12B/4B/1B. GPT-o3 won the 5-dimension rubric (4.92/5).
2. **Buy references once, not data forever** — 15 000 English fables translated **once** by
   the best system → a seed set, split 12 000 / 1 500 / 1 500.
3. **LoRA-tune 1B, 4B and 12B on that seed** — LoRA on q/k/v/o + gate/up/down, **r 32, alpha 32,
   dropout 0.05**, adapters merged at inference, loss masked to the target language only,
   AdamW + cosine, early stopping on held-out val loss. Hardware: 1×L40S ~1 h (1B), 1×L40S
   2–3 h (4B), 1×H100 ~2 h (12B).
4. **Mass-translate with the tuned model** — 3 M fables, vLLM + FlashAttention-2, 8×H100
   **~31 h, ≈ $350**, against $13 500 for GPT-4.1, $24 300 for o3 and $270 000 for DeepL on
   the same volume.

Results: tuned Gemma-3-12B **4.83/5** against GPT-o3's 4.92, while the untuned Gemma-3-12B-it
scores 4.43 and the untuned 1B is unusable (2.02). 4B reaches 4.74, 1B only 3.75.

Findings that change how this project should be run:

- **BLEU is anti-correlated with quality here.** The 4B model beats the 12B on BLEU
  (0.1153 vs 0.0926), the *untuned* 4B beats the tuned 12B, and the distilled 1B has the
  highest BLEU of all at a lower rubric score. Judge with a rubric, not with BLEU.
- **Decode greedily (T=0) for corpus generation.** T=1.0 costs 0.2–0.3 rubric points, mostly
  in accuracy and cultural fit; a quantised 4B showed a BLEU collapse at T=0.2 that looked
  like a quality loss and was a decoding artefact.
- **Judge and reference must come from different families**, otherwise self-preference biases
  the score — the paper flags this in its own design.
- **Error modes to build gates for:** dropped details, literal phrasing, wrong gender/tense,
  and entity corruption (a species becoming a different animal). These are exactly the
  failures a literary translator must not make, and only a human spot-check on 40 items
  surfaced them.

Artifacts (verified): `klusai/tf2-1b`, `klusai/tf2-4b`, `klusai/tf2-12b` (+ `-gguf`),
`klusai/tf2-en-ro-15k`, `klusai/ds-tf1-en-3m`, code `github.com/klusai/tinyfabulist-tf2`
(★2, MIT). **`klusai/tf2-en-ro-3m` does not resolve (401)** — the 3 M-pair dataset is not
publicly downloadable, so the seed set is the reusable part.

### 15.2 Long-document consistency without 128 K of context

Two papers attack the same problem — a novel is longer than any window you can serve — and
both matter because they weaken the 128 K requirement in §1.

**Incremental decoding** (arXiv 2409.16539, WMT24 discourse-level literary track, zh→en):
prompt-only, no weight updates, no KV tricks. For each sentence the prompt carries the
previous n source/translation pairs *plus* style-related pairs retrieved by sentence and
keyword similarity from a datastore, then a one-line instruction. Gain over the same
SFT'd model without it: **+0.06 to +1.34 d-BLEU** across four test sets; the pipeline's real
gain (+3.0 s-BLEU / +3.56 d-BLEU) comes from continued pretraining and SFT, not decoding.

**Temp-LoRA** (arXiv 2401.11504): store context in *parameters* instead of the KV cache.
Generate in chunks with a bounded window, then train a temporary LoRA on
`(recent input → just-generated chunk)` and continue; the adapter is discarded at the end, so
base weights never change. Adapter: r 64, alpha 64, dropout 0.05, lr 5e-5, 2 epochs, bf16.
On GuoFeng novels (84 k–370 k tokens, zh→en and en→zh): PPL −24 % / −29 %, **BLEU +53 % /
+113 %**, COMET +6.1 / +5.6 points. Shrinking the window from 24 K to 4 K cost 3.4 % PPL but
saved **51 % memory and 60 % latency**; the adapter update costs ~1.7 s per chunk on an A800.
Code: `github.com/TemporaryLoRA/Temp-LoRA` (★128); weights and adapters not released.

Reading for this project:

- The 128 K requirement is a *serving* nicety, not a correctness requirement. A 4 K–8 K window
  plus previous-sentence context plus retrieved style pairs recovers most of what long context
  buys, and it runs on stock llama.cpp with no adapter training.
- Temp-LoRA is the stronger idea for **terminology and name consistency** — which is exactly
  what a translated novel needs — but it needs a custom serving loop (train → swap → continue)
  that stock runtimes don't provide, and its 18 GB figure is for 7B bf16. Treat it as a
  phase-2 experiment, not part of the first delivery.
- Both ideas compose with §13.10: constrain the output shape with a grammar, keep the window
  small, and feed consistency through the prompt.

### 15.3 Adapting a model to a low-resource language on one GPU (arXiv 2605.09015, LLiMba)

Qwen2.5-**3B-Instruct** → Sardinian, one RTX 4090. The most transferable full pipeline found
in this sweep:

- **Start from the instruct checkpoint, not the base.** Its instruction scaffold survives
  continued pretraining, so a small SFT pool re-anchors it; a base checkpoint would need a
  much larger SFT pool.
- **Do not touch the tokenizer** — vocab stays 151 936, no added tokens, and no fertility
  claims were needed.
- **Corpus:** 13.5 M tokens collected → **11.48 M** after dedup + language filter, from web
  (4.90 M), Wikipedia (2.58 M), CommonCrawl (1.77 M), translated books (2.01 M), period
  poetry with line breaks kept (0.18 M), bilingual text/lyrics (0.04 M). LID cannot detect a
  low-resource language, so the filter kept anything classified IT/ES/PT/CA and dropped only
  EN/DE/FR.
- **Replay = 21 % of the corpus** (2.44 M tokens of Italian/Spanish/Portuguese/Catalan
  Wikipedia), document-shuffled, **no language tag**.
- **Stage 1 — full-FT CPT:** bf16, FlashAttention 2, paged AdamW 8-bit, lr 5e-5 cosine,
  50 warmup, effective batch 16, **seq 4096, packing disabled** (cross-document attention
  leak degraded quality), grad checkpointing, 2 epochs. 22–23 GB peak, **5.5 h**.
- **Stage 2 — SFT:** 14 404 pairs (Capybara machine-translated with NLLB-200 3.3B at 10 517
  pairs, 2 020 translation pairs, 448 Claude-written + native-reviewed pairs upsampled ×5),
  completion-only loss, ChatML, 2 epochs. Five matched variants were compared; the shipped one
  is **rsLoRA r 256 / alpha 256, lr 2e-5**.
- **Result split:** CPT delivered **4–7× more of the total gain** than SFT; EN→SC BLEU went
  2.75 → 17.26 (CPT) → 28.47 (SFT). Full FT SFT (21.04) lost to every LoRA variant; plain
  LoRA r 64 got 23.60, rsLoRA r 128 25.33, DoRA r 256 23.00.
- **Loss and BLEU ordered the variants smoothly while behaviour differed categorically**
  (one variant leaked Chinese tokens) — evaluate with native-reader pairwise judgement and a
  held-out book-style PPL split, plus long unconstrained generation probes.

Transfer to 8B on 16 GB: the CPT stage becomes 4-bit QLoRA CPT (NF4 base ~5–6 GB + paged 8-bit
AdamW + gradient checkpointing) or one rented 48 GB day; keep `packing=False`, keep the 21 %
replay ratio as the anti-forgetting budget, keep completion-only loss, and expect the SFT
stage to be the cheap part.

### 15.4 Which Russian SFT mix is safe for a strict-format literary set

Read from the cards, with the filter rules that follow:

| Dataset | Verdict | Why, and the filter |
| --- | --- | --- |
| `Vikhrmodels/GrandMaster-PRO-MAX` | **mix, ≤10–15 %** | answers are native Russian (GPT-4-Turbo-1106, not translated) and prompt-deduped at cos 0.975, but the signature is CoT + Markdown (mean 720-token answers, "**Шаг 1**" headers). Keep only `answer_lang == "ru"` rows whose answer is plain prose |
| `t-tech/T-Wix` | conditional, small | reward-model-selected answers from DeepSeek-V3-0324 / Qwen3-235B; take `subset == "general"` only, drop `reasoning`/`long_context` and anything with LaTeX or numbered chains; it also contains English rows despite the "Russian SFT" framing |
| `d0rj/ru-instruct` | **do not mix** | fully machine-translated; system prompts push terse Q&A; residual artefacts ("How to say N in Arabic?") and a Python-snippet subset |
| `Vikhrmodels/Veles-2.5` | **do not mix** | translated OpenHermes-2.5, ~82 % via gpt-3.5, no filtering, no licence, ShareGPT `from`/`value` keys plus leftover English `original` fields |

Rule of thumb that follows: **the literary corpus stays ≥85 % of tokens**, instruction data is
the seasoning, everything is normalised to one chat template at tokenisation time, and the
merge is gated by measuring Markdown/bold-token rate and opening-phrase distribution before
and after.

### 15.5 Proofreading data: what exists and what has to be synthesised

The verified numbers are in §13.3. What matters for the design:

- **Volume is an illusion.** `melsmm`'s "1 M synthetic" plus `ready_30k` plus RuSpellGold plus
  the ai-forever benchmark overlap; distinct human sentences ≈ 30–35 k. Plan the proofreading
  task around ~30 k curated pairs plus synthetic corruption, not around a million.
- **Every set is whole-sentence pairs**, so the model learns to paraphrase. Minimal-edit
  behaviour needs span/edit labels (M2/ERRANT) or an explicit instruction contract
  ("change only what is wrong"), plus a **false-edit rate** metric next to F0.5.
- **There are no identity controls except melsmm's 50 k no-op rows.** Replicate that for
  literary text: pairs where the input is already correct and the right answer is the input.
  Without them, a model drifts toward editing everything — the same identity shortcut as
  §12.10, in reverse.
- **Nothing covers literary punctuation:** dialogue dashes, direct-speech quotes, ellipsis,
  vocatives, multi-voice paragraphing. This has to be synthesised with rules over literary
  dialogue and validated by an editor, with a punctuation-only metric.
- **Length is the hard gap:** the largest templated set stops at 19 tokens and the gold sets at
  ~30–40. Long-range agreement (case government across subordinate clauses) needs
  100–400-token paragraphs, which means mining edited manuscripts (§5.2), not downloading.

### 15.6 Sources for this section

`arxiv.org/abs/2509.07829` (EN→RO literary translation with open models) ·
`arxiv.org/abs/2409.16539` (incremental decoding, discourse-level) ·
`arxiv.org/abs/2401.11504` (Temp-LoRA) · `arxiv.org/abs/2605.09015` (LLiMba) ·
`arxiv.org/abs/2601.14277` (llama.cpp quantisation evaluation).
Datasets/models: `klusai/tf2-*`, `klusai/tf2-en-ro-15k`, `klusai/ds-tf1-en-3m`,
`github.com/klusai/tinyfabulist-tf2` · `lballore/llimba-3b-instruct`, `lballore/llimba-3b-instruct-cpt`,
`github.com/lballore/LLiMba` (★6) · the four SFT datasets and six GEC datasets named in
§13.1 and §13.3.


