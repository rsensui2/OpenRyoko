import { describe, expect, it } from 'vitest'
import { consumeUrlSessionSelection } from '../url-session-selection'

describe('consumeUrlSessionSelection', () => {
  it('applies a newly requested URL session once', () => {
    expect(consumeUrlSessionSelection('session-a', null, null)).toEqual({
      appliedMarker: 'session-a',
      sessionIdToSelect: 'session-a',
    })
  })

  it('does not force the old URL session back after a sidebar selection', () => {
    expect(consumeUrlSessionSelection('session-a', 'session-a', 'session-b')).toEqual({
      appliedMarker: 'session-a',
      sessionIdToSelect: null,
    })
  })

  it('allows the same URL session to be applied after the parameter is cleared', () => {
    const cleared = consumeUrlSessionSelection(null, 'session-a', 'session-b')
    expect(cleared.appliedMarker).toBeNull()
    expect(consumeUrlSessionSelection('session-a', cleared.appliedMarker, 'session-b').sessionIdToSelect).toBe('session-a')
  })
})
