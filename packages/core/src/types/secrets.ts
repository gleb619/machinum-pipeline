import type { MasterKeySource } from '../secrets.js'
export interface RotateEmbedKeysOptions extends EmbedKeyringOptions {
  /** New key id (default: next free `k<N>`). */
  kid?: string
  note?: string
  /** Re-seal every secret under the new key. */
  reencrypt?: boolean
}

export interface AddEmbedKeyOptions extends EmbedKeyringOptions {
  /** Key id (required). */
  kid: string
  /** Supplied encryption key text (see {@link parseSuppliedEmbedKey}). */
  key: string
  note?: string
  /** default true */
  activate?: boolean
}

export interface GenerateEmbedKeyOptions extends EmbedKeyringOptions {
  /** Key id (default: next free `k<N>`). */
  kid?: string
  note?: string
  /** default true: make it the active key for new writes */
  activate?: boolean
}

export interface EmbedKeyringOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
}

export interface RekeyEmbedOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Current master password; defaults to the resolution order (or the built-in default). */
  currentPassword?: string
  /** New master password (required, non-empty, different from the current one). */
  newPassword: string
}

export interface RotateEmbedSecretOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
}

export interface WriteMasterKeyOptions {
  /** Overwrite an existing file. Overwriting a key that sealed a store locks that store. */
  force?: boolean
  /** Key to write; defaults to {@link generateMasterKey}. */
  key?: string
}

export interface MasterKeyResolution {
  source: MasterKeySource
  /** File the password came from (`env-file`, `project`, `user`). */
  path?: string
  /** The master password. Never print or log it. */
  password: string
}

export interface MasterKeyPaths {
  project: string
  user: string
}

export interface SetEmbedSecretOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
  /** default false: an existing name is an error (CLI --force sets true) */
  overwrite?: boolean
  /** Seal with this encryption key (default: the active one). */
  kid?: string
}

export interface SetEmbedSecretInput {
  name: string
  secret: string
  username?: string
  url?: string
  notes?: string
}

export interface CreateEmbedOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
}

/** Encryption key metadata (never the key material). */
export interface EmbedKeyInfo {
  kid: string
  status: 'active' | 'retired'
  createdAt: string
  note?: string
  /** Number of secrets currently sealed with this key. */
  secrets: number
}

/** Entry metadata without the secret value (safe for list/status output). */
export interface EmbedEntryInfo {
  name: string
  /** Encryption key id this secret is sealed with. */
  kid: string
  /** ISO timestamp of first creation. */
  createdAt: string
  /** ISO timestamp of the last value rotation / overwrite. */
  rotatedAt?: string
  username?: string
  url?: string
  notes?: string
}

export interface EmbedSecret {
  name: string
  secret: string
  /** Encryption key id this secret is sealed with. */
  kid: string
  username?: string
  url?: string
  notes?: string
}
