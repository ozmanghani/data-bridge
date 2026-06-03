/**
 * In-process registry of `AbortController`s for currently-executing runs. The
 * BullMQ worker runs in this process, so aborting the controller here cancels
 * the in-flight `fetch` immediately (no Redis round-trip). State is intentionally
 * ephemeral — durability lives in Redis/Prisma, this is only for live abort.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class RunRegistryService implements OnModuleDestroy {
  private readonly controllers = new Map<string, AbortController>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  release(runId: string): void {
    this.controllers.delete(runId);
  }

  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  onModuleDestroy(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
