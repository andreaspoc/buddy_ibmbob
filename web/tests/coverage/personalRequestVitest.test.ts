// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { personalRequest } from '../../src/lib/personalRequest';

describe('personalRequest retry and error policies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('successfully executes GET and parses JSON response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tutorials_disabled: true }),
    });

    const data = await personalRequest('tutorials');
    expect(data).toEqual({ tutorials_disabled: true });
    expect(global.fetch).toHaveBeenCalledWith('/personalization/tutorials', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: undefined,
    });
  });

  it('retries on 503 status code for GET up to 3 times before succeeding', async () => {
    let attempt = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt < 3) {
        return Promise.resolve({
          ok: false,
          status: 503,
          body: { cancel: vi.fn().mockResolvedValue(undefined) },
          json: async () => ({ detail: 'Service Unavailable' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: 'recovered' }),
      });
    });

    const promise = personalRequest('settings', 'GET');
    // Fast forward retries
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ status: 'recovered' });
    expect(attempt).toBe(3);
  });

  it('throws session expired error on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Unauthorized' }),
    });

    await expect(personalRequest('profile')).rejects.toThrow('Your session has expired');
  });

  it('throws custom detail error on 400', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Invalid theme setting' }),
    });

    await expect(personalRequest('theme', 'POST', { color: 'invalid' })).rejects.toThrow('Invalid theme setting');
  });
});
