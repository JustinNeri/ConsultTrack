const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Thin fetch wrapper for the ConsultTrack Express API.
 * Attaches the bearer token and unwraps `{ error }` bodies into ApiError.
 */
export async function api(path, { method = 'GET', body, raw, token, signal } = {}) {
  // `raw` is a Blob or File sent as-is -- attachments go up as bytes rather
  // than as base64 inside JSON, which would inflate them by a third and blow
  // past the API's JSON body limit.
  const sendingRaw = raw != null;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      signal,
      headers: {
        ...(sendingRaw
          ? { 'Content-Type': 'application/octet-stream' }
          : body
            ? { 'Content-Type': 'application/json' }
            : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: sendingRaw ? raw : body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server. Is the API running?', 0);
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    throw new ApiError(payload.error || `Request failed (${response.status})`, response.status);
  }
  return payload;
}
