import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { HookWatchService } from './hook-watch.service';
import { HOOK_WATCH_QUEUE, type HookWatchJob } from './hooks.types';

/** Each scheduled fire is one poll cycle for a watch hook. */
@Processor(HOOK_WATCH_QUEUE, { concurrency: 8 })
export class HookWatchProcessor extends WorkerHost {
  constructor(private readonly watch: HookWatchService) {
    super();
  }

  async process(job: Job<HookWatchJob>): Promise<void> {
    await this.watch.poll(job.data.hookId);
  }
}
