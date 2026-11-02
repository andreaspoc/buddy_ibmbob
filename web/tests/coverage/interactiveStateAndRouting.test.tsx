// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { matchesResponseRoute, acceptArtifactRevision } from '../../src/lib/responseRoute';
import { widgetDigest, useInteractiveState } from '../../src/lib/interactiveState';

function InteractiveHarness({
  source,
  identity,
  sessionId,
  readOnly,
  onState,
}: {
  source: string;
  identity: string;
  sessionId?: string;
  readOnly?: boolean;
  onState: (state: any, setState: any, status: string) => void;
}) {
  const { state, setState, status } = useInteractiveState(source, identity, sessionId, readOnly) as any;
  onState(state, setState, status);
  return <div id="interactive-box">{status}</div>;
}

describe('responseRoute matchesResponseRoute and acceptArtifactRevision', () => {
  it('matchesResponseRoute handles invalid payloads, historical events and exact routing metadata', () => {
    const route = {
      workspaceId: 'ws-1',
      jobId: 'job-1',
      correlationId: 'corr-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
    };

    // Invalid payload types
    expect(matchesResponseRoute(null, route)).toBe(false);
    expect(matchesResponseRoute(undefined, route)).toBe(false);
    expect(matchesResponseRoute('string-event', route)).toBe(false);
    expect(matchesResponseRoute([1, 2, 3], route)).toBe(false);

    // Historical event without metadata matches
    expect(matchesResponseRoute({}, route)).toBe(true);

    // Matching metadata
    const exactMatch = {
      workspace_id: 'ws-1',
      job_id: 'job-1',
      correlation_id: 'corr-1',
      user_message_id: 'user-1',
      assistant_message_id: 'asst-1',
    };
    expect(matchesResponseRoute(exactMatch, route)).toBe(true);

    // Mismatched field rejects
    expect(matchesResponseRoute({ ...exactMatch, job_id: 'other-job' }, route)).toBe(false);
    expect(matchesResponseRoute({ ...exactMatch, workspace_id: 'other-ws' }, route)).toBe(false);
    expect(matchesResponseRoute({ ...exactMatch, correlation_id: 'other-corr' }, route)).toBe(false);
  });

  it('acceptArtifactRevision accepts valid increasing event IDs and rejects stale revisions', () => {
    const versions = new Map<string, number>();

    // Initial safe integer event ID
    expect(acceptArtifactRevision(versions, 'doc-1', 10)).toBe(true);
    expect(versions.get('doc-1')).toBe(10);

    // Stale lower or equal event ID is rejected
    expect(acceptArtifactRevision(versions, 'doc-1', 10)).toBe(false);
    expect(acceptArtifactRevision(versions, 'doc-1', 5)).toBe(false);

    // Higher event ID is accepted
    expect(acceptArtifactRevision(versions, 'doc-1', 12)).toBe(true);
    expect(versions.get('doc-1')).toBe(12);

    // Non-number event ID accepted only if key absent
    expect(acceptArtifactRevision(versions, 'doc-1', null)).toBe(false); // key exists
    expect(acceptArtifactRevision(versions, 'doc-2', null)).toBe(true);  // key absent
  });
});

describe('interactiveState widgetDigest and useInteractiveState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('widgetDigest calculates sha-256 hex string', async () => {
    const digest = await widgetDigest('pricing-table-v1');
    expect(typeof digest).toBe('string');
    expect(digest.length).toBe(64);
  });

  it('useInteractiveState defaults to local when readOnly or no sessionId', async () => {
    let capturedStatus = '';
    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InteractiveHarness
          source="code"
          identity="widget-1"
          readOnly={true}
          onState={(_s, _set, status) => {
            capturedStatus = status;
          }}
        />
      );
    });

    expect(capturedStatus).toBe('local');
    act(() => root.unmount());
  });

  it('useInteractiveState loads state from backend and persists updates', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (!opts || opts.method === 'GET' || !opts.method) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ state: { selected: 1, done: [1] } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true }),
      });
    });

    let stateVal: any;
    let setStateFn: any;
    let statusVal = '';

    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InteractiveHarness
          source="interactive-source-code"
          identity="widget-alpha"
          sessionId="session-123"
          readOnly={false}
          onState={(state, setState, status) => {
            stateVal = state;
            setStateFn = setState;
            statusVal = status;
          }}
        />
      );
    });

    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(statusVal).toBe('saved');
    });
    expect(stateVal).toEqual({ selected: 1, done: [1] });

    // Update state
    await act(async () => {
      setStateFn({ selected: 2, done: [1, 2] });
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });
});
