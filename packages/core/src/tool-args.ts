import type { ToolArg } from './types.js'

/** Shared configuration for the `ToolArg` smart constructors. */
export interface ItemArgConfig {
  name?: string
  type?: string
  required?: boolean
  description: string
  default?: string
}

export interface MetaArgConfig {
  name: string
  type?: string
  required?: boolean
  description: string
  default?: string
}

export interface VariableArgConfig {
  name: string
  type?: string
  required?: boolean
  description: string
  default?: string
  direction?: 'in' | 'out'
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/

function assertDescription(description: string): void {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error('tool arg description must be a non-empty string')
  }
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid tool arg name '${name}': must start with a letter and contain only letters, digits, '_', '.', or '-'`,
    )
  }
}

function isDirection(value: string): value is 'in' | 'out' {
  return value === 'in' || value === 'out'
}

/**
 * Declare the Exchange `item` payload. Defaults to name `'item'` and `required: true`, because a
 * tool almost always reads its input item.
 */
export function itemArg(config: ItemArgConfig): ToolArg {
  assertDescription(config.description)
  const name = config.name ?? 'item'
  assertName(name)
  return {
    name,
    target: 'item',
    type: config.type,
    required: config.required ?? true,
    description: config.description,
    default: config.default,
  }
}

/**
 * Declare an Exchange `meta` key. The target is implied, so names must not repeat the `'meta.'`
 * prefix. Defaults to `required: false`.
 */
export function metaArg(config: MetaArgConfig): ToolArg {
  assertDescription(config.description)
  assertName(config.name)
  if (config.name.startsWith('meta.')) {
    throw new Error(
      `invalid meta arg name '${config.name}': the meta target is implied, omit the 'meta.' prefix`,
    )
  }
  return {
    name: config.name,
    target: 'meta',
    type: config.type,
    required: config.required ?? false,
    description: config.description,
    default: config.default,
  }
}

/**
 * Declare an Exchange variable. Defaults to `required: false` and `direction: 'in'`; pass
 * `direction: 'out'` for a value the tool produces.
 */
export function variableArg(config: VariableArgConfig): ToolArg {
  assertDescription(config.description)
  assertName(config.name)
  const direction = config.direction ?? 'in'
  if (!isDirection(direction)) {
    throw new Error(`invalid variable arg direction '${direction}': expected 'in' or 'out'`)
  }
  return {
    name: config.name,
    target: 'variable',
    direction,
    type: config.type,
    required: config.required ?? false,
    description: config.description,
    default: config.default,
  }
}
