import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DeliveryService } from './delivery.service';
import { HookRunProcessor } from './hook-run.processor';
import { HookRunService } from './hook-run.service';
import { HookCdcService } from './hook-cdc.service';
import { HookStoreService } from './hook-store.service';
import { HookWatchProcessor } from './hook-watch.processor';
import { HookWatchService } from './hook-watch.service';
import { HooksController } from './hooks.controller';
import { RunRegistryService } from './run-registry.service';
import { HOOK_RUNS_QUEUE, HOOK_WATCH_QUEUE } from './hooks.types';

@Module({
  imports: [
    ConnectionsModule, // AdapterPoolService
    BullModule.registerQueue({ name: HOOK_RUNS_QUEUE }),
    BullModule.registerQueue({ name: HOOK_WATCH_QUEUE }),
  ],
  controllers: [HooksController],
  providers: [
    HookStoreService,
    HookRunService,
    HookWatchService,
    HookCdcService,
    DeliveryService,
    RunRegistryService,
    HookRunProcessor,
    HookWatchProcessor,
  ],
})
export class HooksModule {}
