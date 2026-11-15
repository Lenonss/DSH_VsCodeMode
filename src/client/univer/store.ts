/** Session-scoped optional capability and discovered-document registry. @author ddj 2026年11月12号 */
import { rpc } from '../rpc.js'
import type { UniverCapability, UniverFileState } from '../../shared/univer.js'

export interface UniverDocument {
  file: string
  source?: string
  sourceChanged?: boolean
  worktreeId?: string
  state?: UniverFileState
}
export interface SessionState {
  capability?: UniverCapability
  error?: string
  confirmed: boolean
  documents: Map<string, UniverDocument>
  listeners: Set<() => void>
  pending?: Promise<void>
  revision: number
}
const sessions = new Map<string, SessionState>()
let activeSession = ''

/** @private @author ddj 2026年11月12号 @param sessionId Scope. @returns Stable in-page session registry. */
function sessionState(sessionId: string): SessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { confirmed: false, documents: new Map(), listeners: new Set(), revision: 0 }
    sessions.set(sessionId, state)
  }
  return state
}

/** @private @author ddj 2026年11月12号 @param state Changed registry. Notifies subscribed components. */
function notify(state: SessionState): void {
  state.revision++
  for (const listener of state.listeners) listener()
}

/** @public @author ddj 2026年11月12号 @param sessionId Current session. Clears safety consent after session switches. */
export function activateUniver(sessionId: string): void {
  if (activeSession === sessionId) return
  if (activeSession) {
    const previous = sessionState(activeSession)
    previous.confirmed = false
    notify(previous)
  }
  activeSession = sessionId
}

/** @public @author ddj 2026年11月12号 @param sessionId Scope. @returns Current capability without triggering network or Gateway. */
export function univerCapability(sessionId: string): UniverCapability | undefined {
  return sessionState(sessionId).capability
}

/** @public @author ddj 2026年11月12号 @param sessionId Scope. @returns Snapshot for React rendering. */
export function univerSnapshot(sessionId: string): SessionState {
  return sessionState(sessionId)
}

/** @public @author ddj 2026年11月12号 @param sessionId Scope. @param listener Subscriber. @returns Cleanup. */
export function subscribeUniver(sessionId: string, listener: () => void): () => void {
  const state = sessionState(sessionId)
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}

/** @public @author ddj 2026年11月12号 @param sessionId Scope. @returns Coalesced non-mutating capability refresh. */
export function refreshUniver(sessionId: string): Promise<void> {
  const state = sessionState(sessionId)
  if (state.pending) return state.pending
  const refresh = async (): Promise<void> => {
    try {
      const result = await rpc('edrv.univer.capabilities', { sessionId })
      if (!result.ok) throw new Error(result.error)
      state.capability = result.capability
      state.error = undefined
      if (!result.capability.available || !result.capability.writable) state.confirmed = false
    } catch (error) {
      state.capability = undefined
      state.confirmed = false
      state.error = String(error)
    } finally {
      state.pending = undefined
      notify(state)
    }
  }
  state.pending = refresh()
  return state.pending
}

/** @public @author ddj 2026年11月12号 @param sessionId Scope. @param confirmed Explicit user consent. */
export function confirmUniver(sessionId: string, confirmed: boolean): void {
  const state = sessionState(sessionId)
  state.confirmed = confirmed && state.capability?.writable === true
  notify(state)
}

/** @public @author ddj 2026年11月13号 @param sessionId Scope. @param files Deleted managed containers. Removes only cached navigation state. */
export function forgetUniver(sessionId: string, files: string[]): void {
  const state = sessionState(sessionId)
  for (const file of files) state.documents.delete(file)
  notify(state)
}

/** @public @author ddj 2026年11月12号 @param sessionId Scope. @param document Discovered document; never scans workspace. */
export function trackUniver(sessionId: string, document: UniverDocument): void {
  const state = sessionState(sessionId)
  state.documents.set(document.file, { ...state.documents.get(document.file), ...document })
  notify(state)
}
