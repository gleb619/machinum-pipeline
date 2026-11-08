import type { MdOutputEntry } from '@mt/core'

/** Why a target cannot honour the `mdOutputs` write intents on an envelope. */
export type MdOutputsRejection =
  /** Single-file mode — the intents have no per-file destination. */
  | 'file-mode'
  /** `?series=true` in dir mode — a series part has no unambiguous filename. */
  | 'series'
  /** The target writes one chapter per envelope and never per-file intents. */
  | 'unsupported'

/**
 * Build the rejection error for `mdOutputs` intents a target cannot honour.
 * The intent names are listed so the tool author sees which slots were dropped.
 */
export function mdOutputsRejectionError(
  targetLabel: string,
  raw: string,
  outputs: MdOutputEntry[],
  rejection: MdOutputsRejection,
): Error {
  const names = outputs.map((output) => output.name).join(', ')
  switch (rejection) {
    case 'file-mode':
      return new Error(
        `${targetLabel} '${raw}': file mode cannot be combined with mdOutputs intents (${names})`,
      )
    case 'series':
      return new Error(
        `${targetLabel} '${raw}': ?series=true cannot be combined with mdOutputs intents (no unambiguous filenames)`,
      )
    case 'unsupported':
      return new Error(
        `${targetLabel} '${raw}': mdOutputs intents (${names}) are not supported — write them to an md:// target`,
      )
  }
}
