/**
 * mt.json project configuration shape.
 */
export interface MtConfig {
  project: {
    name: string
  }
  book?: {
    name?: string
    author?: string
    year?: number
  }
  storage?: {
    root?: string
  }
  secrets?: {
    envFile?: string
  }
  router?: {
    port?: number
  }
  model?: {
    default?: string
  }
  defaults?: {
    retry?: {
      max?: number
      backoffMs?: number
      strategy?: 'fixed' | 'linear' | 'exp'
    }
    onError?: 'fail-run' | 'skip-item' | 'dead-letter'
    concurrency?: number
  }
  pipelines?: string[]
}

export const DEFAULT_MT_CONFIG: MtConfig = {
  project: {
    name: 'my-book-project',
  },
  book: {
    name: 'My Book',
  },
  storage: {
    root: '.mt',
  },
  secrets: {
    envFile: '.env',
  },
  router: {
    port: 7777,
  },
  defaults: {
    retry: {
      max: 3,
      backoffMs: 1000,
      strategy: 'exp',
    },
    onError: 'fail-run',
    concurrency: 4,
  },
  pipelines: ['./pipelines/example.ts'],
}
