/** Options for {@link readJsonOrThrow}. */
export interface ReadJsonOptions {
  /** Yield `undefined` instead of throwing when the file does not exist. */
  ignoreMissing?: boolean
}
