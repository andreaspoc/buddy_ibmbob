import { isGatewayReady, submitViaGateway } from './gatewaySocket';

/**
 * Submit chat request via zero-polling Gateway WebSocket if connected,
 * with seamless, automatic fallback to HTTP stream.
 */
export async function submitChatRequest(options: RequestInit): Promise<Response> {
  if (isGatewayReady() && options.body && typeof options.body === 'string') {
    try {
      return await submitViaGateway(options);
    } catch (gatewayErr) {
      if (options.signal?.aborted || (gatewayErr instanceof Error && gatewayErr.name === 'AbortError')) {
        throw gatewayErr;
      }
      console.warn('Gateway WebSocket error, falling back to HTTP stream:', gatewayErr);
    }
  }

  try {
    return await fetch('/chat/stream', options);
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return fetch('/chat/stream', options);
  }
}
