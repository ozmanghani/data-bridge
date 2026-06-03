import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { redisConnectionOptions } from './common/runtime-config';
import { ConnectionsModule } from './connections/connections.module';
import { DriversModule } from './drivers/drivers.module';
import { HooksModule } from './hooks/hooks.module';

@Module({
  imports: [
    CommonModule,
    BullModule.forRoot({ connection: redisConnectionOptions() }),
    ConnectionsModule,
    DriversModule,
    HooksModule,
  ],
})
export class AppModule {}
