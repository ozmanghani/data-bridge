import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DeliveryService } from './delivery.service';
import { HookRunProcessor } from './hook-run.processor';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { HooksController } from './hooks.controller';
import { RunRegistryService } from './run-registry.service';
import { HOOK_RUNS_QUEUE } from './hooks.types';

@Module({
  imports: [
    ConnectionsModule, // AdapterPoolService
    BullModule.registerQueue({ name: HOOK_RUNS_QUEUE }),
  ],
  controllers: [HooksController],
  providers: [
    HookStoreService,
    HookRunService,
    DeliveryService,
    RunRegistryService,
    HookRunProcessor,
  ],
})
export class HooksModule {}
