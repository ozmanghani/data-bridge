import { Module } from '@nestjs/common';
import { HooksModule } from '../hooks/hooks.module';
import { WorkspaceStoreService } from './workspace-store.service';
import { WorkspacesController } from './workspaces.controller';

// PrismaService comes from the global CommonModule. HooksModule is imported so
// we can stop a workspace's live bridges before deleting it.
@Module({
  imports: [HooksModule],
  controllers: [WorkspacesController],
  providers: [WorkspaceStoreService],
  exports: [WorkspaceStoreService],
})
export class WorkspacesModule {}
