import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  type Workspace,
  type WorkspaceInputDTO,
  workspaceInputSchema,
} from '@data-bridge/core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { HookStoreService } from '../hooks/hook-store.service';
import { HookWatchService } from '../hooks/hook-watch.service';
import { HookCdcService } from '../hooks/hook-cdc.service';
import { WorkspaceStoreService } from './workspace-store.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly store: WorkspaceStoreService,
    private readonly hooks: HookStoreService,
    private readonly watch: HookWatchService,
    private readonly cdc: HookCdcService,
  ) {}

  @Get()
  list(): Promise<Workspace[]> {
    return this.store.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(workspaceInputSchema)) dto: WorkspaceInputDTO,
  ): Promise<Workspace> {
    return this.store.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Workspace> {
    return this.store.get(id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(workspaceInputSchema)) dto: WorkspaceInputDTO,
  ): Promise<Workspace> {
    return this.store.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    // stop any live listeners in this workspace before the cascade delete, so
    // CDC slots get dropped and watch schedulers stop cleanly (no zombies).
    const hooks = await this.hooks.list(id).catch(() => []);
    for (const hook of hooks) {
      if (hook.trigger.kind === 'cdc') {
        await this.cdc.cleanup(hook.id).catch(() => undefined);
      } else if (hook.trigger.kind === 'watch') {
        await this.watch.stop(hook.id).catch(() => undefined);
      }
    }
    await this.store.remove(id);
    return { id };
  }
}
