/**
 * Server-internal hook types. The fully *resolved* config carries the decrypted
 * auth secret and is used only inside the runner — it is never serialized back
 * to a client (the API surface returns the redacted {@link Hook} from core).
 */
import type {
  HookDeliveryConfig,
  HookDestination,
  HookSource,
  HookTransformConfig,
} from '@relay/core';

/** A hook with its auth secret decrypted — server-internal use only. */
export interface ResolvedHook {
  id: string;
  name: string;
  source: HookSource;
  destination: HookDestination; // auth carries the real secret here
  transform: HookTransformConfig;
  delivery: HookDeliveryConfig;
  enabled: boolean;
}

/** Outcome of a single HTTP delivery attempt sequence. */
export interface DeliveryOutcome {
  status: 'success' | 'failed';
  httpStatus: number | null;
  attempts: number;
  error: string | null;
  responseSnippet: string | null;
  durationMs: number;
}

/** The BullMQ job payload for the `hook-runs` queue. */
export interface HookRunJob {
  runId: string;
  hookId: string;
}

export const HOOK_RUNS_QUEUE = 'hook-runs';
