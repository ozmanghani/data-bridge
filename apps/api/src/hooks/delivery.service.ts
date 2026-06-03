/**
 * Single-request HTTP delivery with retries, exponential backoff and a hard
 * per-request timeout. Pure transport: it knows nothing about runs, rows, or
 * persistence — the caller supplies the body and records the outcome.
 *
 * Auth secrets are applied to headers at send time and never logged; only a
 * truncated response snippet is retained.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { HookDeliveryConfig, HookDestination } from '@relay/core';
import type { DeliveryOutcome } from './hooks.types';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RESPONSE_LIMIT = 16_384;

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger('HookDelivery');

  /** Build request headers, merging static headers with the auth scheme. */
  buildHeaders(
    dest: HookDestination,
    idempotencyKey?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(dest.headers ?? {}),
    };
    if (dest.auth.type === 'bearer' && dest.auth.token) {
      headers['authorization'] = `Bearer ${dest.auth.token}`;
    } else if (dest.auth.type === 'header' && dest.auth.value) {
      headers[dest.auth.name] = dest.auth.value;
    }
    if (idempotencyKey && dest.idempotency) {
      headers['idempotency-key'] = idempotencyKey;
    }
    return headers;
  }

  /** Headers with the auth secret redacted — safe for preview/UI. */
  redactedHeaders(dest: HookDestination): Record<string, string> {
    const headers = this.buildHeaders(dest);
    if (dest.auth.type === 'bearer' && headers['authorization']) {
      headers['authorization'] = 'Bearer ********';
    } else if (dest.auth.type === 'header' && dest.auth.name in headers) {
      headers[dest.auth.name] = '********';
    }
    return headers;
  }

  /**
   * Send one request, retrying transient failures up to `maxAttempts`. Resolves
   * with an outcome describing success or terminal failure — it does not throw
   * for HTTP errors (the run decides whether to continue). It re-throws only if
   * the run's abort signal fires, so the caller can finalize as canceled.
   */
  async send(
    body: unknown,
    dest: HookDestination,
    delivery: HookDeliveryConfig,
    runSignal: AbortSignal,
    idempotencyKey?: string,
  ): Promise<DeliveryOutcome> {
    const headers = this.buildHeaders(dest, idempotencyKey);
    const payload = JSON.stringify(body ?? null);
    const requestBody = payload.slice(0, RESPONSE_LIMIT);
    const started = performance.now();
    let lastError: string | null = null;
    let lastStatus: number | null = null;
    let lastResponse: string | null = null;

    for (let attempt = 1; attempt <= delivery.maxAttempts; attempt++) {
      if (runSignal.aborted) throw new DOMException('Run canceled', 'AbortError');

      const timeout = AbortSignal.timeout(delivery.timeoutMs);
      const signal = AbortSignal.any([runSignal, timeout]);
      try {
        const res = await fetch(dest.url, {
          method: dest.method,
          headers,
          body: payload,
          signal,
        });
        lastStatus = res.status;
        lastResponse = (await res.text().catch(() => '')).slice(0, RESPONSE_LIMIT);

        if (res.ok) {
          return {
            status: 'success',
            httpStatus: res.status,
            attempts: attempt,
            error: null,
            requestBody,
            responseBody: lastResponse || null,
            durationMs: Math.round(performance.now() - started),
          };
        }

        lastError = `HTTP ${res.status} ${res.statusText}`.trim();
        if (RETRYABLE_STATUS.has(res.status) && attempt < delivery.maxAttempts) {
          await this.backoff(attempt, delivery, res.headers.get('retry-after'));
          continue;
        }
        break; // non-retryable HTTP error
      } catch (err) {
        // A run-level abort must propagate; a timeout/network error is retryable.
        if (runSignal.aborted) throw err;
        lastError = describeFetchError(err);
        lastStatus = null;
        if (attempt < delivery.maxAttempts) {
          await this.backoff(attempt, delivery, null);
          continue;
        }
      }
    }

    return {
      status: 'failed',
      httpStatus: lastStatus,
      attempts: delivery.maxAttempts,
      error: lastError ?? 'Delivery failed',
      requestBody,
      responseBody: lastResponse,
      durationMs: Math.round(performance.now() - started),
    };
  }

  /** Exponential backoff with jitter, honoring a numeric `Retry-After`. */
  private async backoff(
    attempt: number,
    delivery: HookDeliveryConfig,
    retryAfter: string | null,
  ): Promise<void> {
    let delay = Math.min(
      delivery.backoffMaxMs,
      delivery.backoffMs * 2 ** (attempt - 1),
    );
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
    if (Number.isFinite(retryAfterMs)) {
      delay = Math.max(delay, Math.min(retryAfterMs, delivery.backoffMaxMs));
    }
    const jitter = delay * 0.2 * Math.random();
    await sleep(delay + jitter);
  }
}

/**
 * Turn an opaque `fetch failed` into something actionable. Node's `fetch`
 * (undici) wraps the real reason in `error.cause` — surface its `code`,
 * `address`/`port` and message so a delivery log says e.g.
 * "fetch failed (ECONNREFUSED 127.0.0.1:8000)" instead of just "fetch failed".
 */
export function describeFetchError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return 'Request timed out';
  }
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause as
    | { code?: string; address?: string; port?: number; message?: string }
    | undefined;
  if (!cause) return err.message;
  const where = cause.address
    ? ` ${cause.address}${cause.port ? `:${cause.port}` : ''}`
    : '';
  const detail = cause.code ? `${cause.code}${where}` : (cause.message ?? '');
  return detail ? `${err.message} (${detail.trim()})` : err.message;
}

/** Sleep that resolves early if the signal aborts — keeps cancel responsive. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
