# T206 — Docs: reserve mt-translate.test for HTTP fixtures, no native-translate promise

## Keywords

Keywords: mt-translate.test, browser-translate, TL247, PAGE_ENDPOINT, translate_whitelists, docs/ideas, docs/steering/tools.md, hosts file, RFC 6761

## Goal

Idea section 2. Docs-only: reserve hostname `mt-translate.test` (RFC 6761) for HTTP fixtures/examples; state clearly that Chrome 156 headless did NOT natively translate any local/private variant (localhost, lvh.me, nip.io, LAN IP, proxy, host-resolver-rules), so no doc may promise native translation from it. Point readers to the working path: `browser-translate` (TL247) calling `translate.googleapis.com` from the page (`PAGE_ENDPOINT` in `packages/tools/src/modification/browser-translate.ts`).

Defaults: no code change. No SKILL.md change unless the text lands in an area SKILL.md already documents (check `grep -n translate docs/SKILL.md`; if browser-translate is described there, add one sentence and bump skill-version + gen:skill, else skip).

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 30m

## Steps

- [ ] `grep -rn "mt-translate\|native.*translat\|lvh.me" docs packages samples --include=*.md --include=*.ts` to find promises/uses
- [ ] `docs/steering/tools.md` browser-translate section: add "Reserved hostname" note (`mt-translate.test`, `/etc/hosts` line, fixtures only, no native-translation guarantee, verified-limitation list)
- [ ] Any example/test fixture hostnames that use other names -> switch to `mt-translate.test` only if trivial; otherwise leave
- [ ] Idea doc section 2: mark "Decision recorded" with date and link to tools.md
- [ ] `pnpm lint` (md not linted; ensure no code touched); report SKILL.md decision

## Done when

- tools.md contains the reservation + limitation; no doc promises native Chrome translation
- lint passes; gates per change-workflow for docs-only: lint + `pnpm test` smoke + `pnpm ci:local` reported (test:gpu still required by the merge rule; run and report)

Deps: none (independent). Simple task: may be done directly on `main` per CLAUDE.md "simple tasks: stay put".
