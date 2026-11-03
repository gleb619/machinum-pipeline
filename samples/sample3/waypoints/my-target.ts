/**
 * Sample-defined waypoint scheme: `my-target://<base-dir>`.
 *
 * `mt.json` → `"uris".ru` points at `my-target://./chapters`, and the pipelines
 * write chapter files through it (`chapters/<lang>/chapter<N>.md`). The scheme is
 * sample-owned, so the sample registers it itself at module load — `mt run` imports
 * the pipeline module (and therefore this file) before any URI is resolved.
 *
 * Behaviour is the stock language-folder chapter layout from `@mt/waypoint`
 * (`createChapterOutputSource` / `createChapterOutputTarget`): `meta.lang` picks the
 * subdirectory, `meta.chapterNum` the filename, writes are atomic. Registering the
 * factories under a new scheme name is what makes the URI resolvable.
 *
 * Importing this module is a side effect — keep `import '../waypoints/my-target.js'`
 * in every pipeline file that names `my-target://` (directly or through `@ru`).
 */
import { registry } from '@mt/core'
import { createChapterOutputSource, createChapterOutputTarget } from '@mt/waypoint'

export const MY_TARGET_SCHEME = 'my-target'

registry.registerSource(MY_TARGET_SCHEME, createChapterOutputSource)
registry.registerTarget(MY_TARGET_SCHEME, createChapterOutputTarget)
