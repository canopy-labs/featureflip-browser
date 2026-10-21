import type { FlagValue } from './types';
import { SDK_HEADER, SDK_TOKEN } from './identity';

export interface EvaluateResponse {
  flags: Record<string, FlagValue>;
}

/** Tells the server this client reports its own reads via /v1/client/events. */
export const REPORTS_EVALUATIONS_HEADER = 'X-Featureflip-Reports-Evaluations';

function requestHeaders(clientKey: string, reportsReads: boolean, identity: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: clientKey,
    // Adds no preflight: Authorization above already makes these non-simple requests.
    [SDK_HEADER]: identity,
  };
  if (reportsReads) headers[REPORTS_EVALUATIONS_HEADER] = '1';
  return headers;
}

export async function evaluate(
  baseUrl: string,
  clientKey: string,
  context: Record<string, unknown>,
  signal?: AbortSignal,
  reportsReads = false,
  identity = SDK_TOKEN,
): Promise<EvaluateResponse> {
  const response = await fetch(`${baseUrl}/v1/client/evaluate`, {
    method: 'POST',
    headers: requestHeaders(clientKey, reportsReads, identity),
    body: JSON.stringify({ context }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Evaluate request failed with status ${response.status}`);
  }

  return response.json();
}

export async function identify(
  baseUrl: string,
  clientKey: string,
  context: Record<string, unknown>,
  connectionId?: string | null,
  reportsReads = false,
  identity = SDK_TOKEN,
): Promise<EvaluateResponse> {
  const headers = requestHeaders(clientKey, reportsReads, identity);
  if (connectionId) {
    headers['X-Connection-Id'] = connectionId;
  }

  const response = await fetch(`${baseUrl}/v1/client/identify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ context }),
  });

  if (!response.ok) {
    throw new Error(`Identify request failed with status ${response.status}`);
  }

  return response.json();
}
