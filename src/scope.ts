/**
 * Execution-owned isolation scope for the memory seam.
 *
 * The invariant this module enforces: the MODEL chooses query, note, and
 * recall intent (the tool arguments); the HOST chooses tenant, principal,
 * agent, workspace, and session. Scope fields are resolved from the tool
 * execution context (the agent the call runs for, its session header, and
 * host settings), never from model-supplied arguments — a prompt-injected
 * model must not be able to search or write another principal's namespace.
 *
 * The scope is part of the provider-call contract from v1: every tool
 * invocation carries one to the provider, outside the tool's own argument
 * object, so adding or changing scope never silently collides with the
 * model-facing schema.
 * @module @zseven-w/dsh-noema/scope
 */
import type { NoemaMemorySettings } from './settings.js'

/**
 * One execution's isolation identity. All identifiers are host-derived.
 * `tenant` and `principal` route the memory namespace; `agent`, `session`,
 * and `workspace` attribute the caller for audit and provenance.
 */
export interface NoemaScope {
  /** Memory tenant namespace (settings override, else the host user). */
  tenant: string
  /** Principal within the tenant (settings override, else the agent/session identity). */
  principal: string
  /** Agent the tool call runs for, when the loop attached one. */
  agent?: string
  /** Live session id (same identity as the agent), when known. */
  session?: string
  /** Session workspace root, when the session header records one. */
  workspace?: string
}

/** Well-known envelope key carrying the scope beside the tool call arguments. */
export const MEMORY_SCOPE_ARG = 'memory_scope'

/** Minimal structural view of the tool execution context scope reads. */
export interface ScopeExecContext {
  agent?: {
    id?: unknown
    session?: {
      id?: unknown
      header?: {
        cwd?: string
        agentPreset?: string
      }
    }
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function fallbackPrincipal(): string {
  return asNonEmptyString(process.env.USER) ?? asNonEmptyString(process.env.USERNAME) ?? 'user'
}

/**
 * Resolve the isolation scope for one tool execution. Settings may pin the
 * tenant/principal (a deliberate host choice); everything else derives from
 * the execution context the agent loop attached to the call. The model has
 * no path into this value.
 */
export function resolveNoemaScope(exec: ScopeExecContext, config: NoemaMemorySettings): NoemaScope {
  const sessionId = asNonEmptyString(exec.agent?.session?.id) ?? asNonEmptyString(exec.agent?.id)
  const agentPreset = asNonEmptyString(exec.agent?.session?.header?.agentPreset)
  const workspace = asNonEmptyString(exec.agent?.session?.header?.cwd)
  const tenant = asNonEmptyString(config.tenant) ?? 'personal'
  const principal = asNonEmptyString(config.principal) ?? sessionId ?? agentPreset ?? fallbackPrincipal()
  return {
    tenant,
    principal,
    ...(sessionId === undefined ? {} : { agent: sessionId, session: sessionId }),
    ...(workspace === undefined ? {} : { workspace }),
  }
}

/**
 * Copy tool arguments with any model-supplied scope claim removed. Tool
 * schemas never declare {@link MEMORY_SCOPE_ARG}, so its presence in args
 * means the model (or a prompt injection) tried to steer isolation; it is
 * dropped before the call proceeds.
 */
export function stripModelScope(args: Record<string, unknown>): Record<string, unknown> {
  if (!(MEMORY_SCOPE_ARG in args)) return args
  const { [MEMORY_SCOPE_ARG]: _dropped, ...rest } = args
  return rest
}
