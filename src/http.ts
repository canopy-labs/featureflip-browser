import type { FlagValue } from './types';

export interface EvaluateResponse {
  flags: Record<string, FlagValue>;
}

export async function evaluate(
  baseUrl: string,
  clientKey: string,
  context: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<EvaluateResponse> {
  const response = await fetch(`${baseUrl}/v1/client/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: clientKey,
    },
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
): Promise<EvaluateResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: clientKey,
  };
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
