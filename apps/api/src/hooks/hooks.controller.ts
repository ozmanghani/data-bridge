import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type Hook,
  type HookDelivery,
  type HookInputDTO,
  type HookPreview,
  type HookPreviewDTO,
  type HookRun,
  type StartRunDTO,
  type SkipDTO,
  type CdcReadiness,
  type CdcReadinessDTO,
  cdcReadinessSchema,
  hookInputSchema,
  hookPreviewSchema,
  renderRow,
  skipSchema,
  startRunSchema,
} from '@relay/core';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DeliveryService } from './delivery.service';
import { HookCdcService } from './hook-cdc.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { HookWatchService } from './hook-watch.service';

@Controller('hooks')
export class HooksController {
  constructor(
    private readonly store: HookStoreService,
    private readonly runs: HookRunService,
    private readonly watch: HookWatchService,
    private readonly cdc: HookCdcService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
  ) {}

  /* ----- CRUD ----- */

  @Get()
  list(): Promise<Hook[]> {
    return this.store.list();
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(hookInputSchema)) dto: HookInputDTO,
  ): Promise<Hook> {
    const hook = await this.store.create(dto);
    // Queue a draft run so the timeline shows the planned deliveries right away.
    await this.runs.prepare(hook.id).catch(() => undefined);
    return hook;
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Hook> {
    return this.store.get(id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(hookInputSchema)) dto: HookInputDTO,
  ): Promise<Hook> {
    const hook = await this.store.update(id, dto);
    // Refresh an existing draft so its queued timeline reflects the new config.
    await this.runs.prepare(id, { onlyExisting: true }).catch(() => undefined);
    return hook;
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    // Tear down any live listener BEFORE deleting (CDC drops its slot/publication).
    const hook = await this.store.get(id).catch(() => null);
    if (hook?.trigger.kind === 'cdc') await this.cdc.cleanup(id).catch(() => undefined);
    else if (hook?.trigger.kind === 'watch') await this.watch.stop(id).catch(() => undefined);
    await this.store.remove(id);
    return { id };
  }

  /* ----- payload preview (no delivery) ----- */

  @Post(':id/preview')
  async preview(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(hookPreviewSchema)) dto: HookPreviewDTO,
  ): Promise<HookPreview> {
    const hook = await this.store.resolve(id);
    const table = hook.source.kind === 'table' ? hook.source.table : '(query)';
    const now = new Date().toISOString();

    let rows: Record<string, unknown>[];
    let fromSource: boolean;
    if (dto.sampleRow) {
      rows = [dto.sampleRow];
      fromSource = false;
    } else {
      rows = await this.fetchSample(hook.source, dto.limit);
      fromSource = true;
    }

    const warnings = new Set<string>();
    const bodies = rows.map((row, index) => {
      const result = renderRow(row, hook.transform, { table, now, index });
      result.warnings.forEach((w) => warnings.add(w));
      return result.body;
    });

    return {
      method: hook.destination.method,
      url: hook.destination.url,
      headers: this.delivery.redactedHeaders(hook.destination),
      bodies,
      warnings: [...warnings],
      fromSource,
    };
  }

  private async fetchSample(
    source: Hook['source'],
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    if (source.kind === 'table') {
      const page = await this.pool.withAdapter(
        source.connectionId,
        source.database,
        (a) =>
          a.browse({
            schema: source.schema,
            table: source.table,
            filters: source.filters,
            sort: source.sort,
            limit,
            offset: 0,
          }),
      );
      return page.rows;
    }
    const result = await this.pool.withAdapter(
      source.connectionId,
      source.database,
      (a) => a.query(source.statement),
    );
    return result.rows.slice(0, limit);
  }

  /* ----- runs ----- */

  @Post(':id/runs')
  startRun(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(startRunSchema)) dto: StartRunDTO,
  ): Promise<HookRun> {
    return this.runs.start(id, dto);
  }

  /* ----- live listening (polling watch OR event-based CDC) ----- */

  @Post('cdc/readiness')
  cdcReadiness(
    @Body(new ZodValidationPipe(cdcReadinessSchema)) dto: CdcReadinessDTO,
  ): Promise<CdcReadiness> {
    return this.cdc.readiness(dto);
  }

  @Post(':id/watch/start')
  async startWatch(@Param('id') id: string): Promise<HookRun> {
    const hook = await this.store.get(id);
    return hook.trigger.kind === 'cdc' ? this.cdc.start(id) : this.watch.start(id);
  }

  @Post(':id/watch/stop')
  async stopWatch(@Param('id') id: string): Promise<HookRun | null> {
    const hook = await this.store.get(id);
    return hook.trigger.kind === 'cdc' ? this.cdc.stop(id) : this.watch.stop(id);
  }

  @Get(':id/runs')
  listRuns(@Param('id') id: string): Promise<HookRun[]> {
    return this.runs.listRuns(id);
  }

  @Get(':id/runs/:runId')
  getRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<HookRun> {
    return this.runs.getRun(id, runId);
  }

  @Post(':id/runs/:runId/retry-failed')
  retryFailed(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<HookRun> {
    return this.runs.resendFailed(id, runId);
  }

  @Post(':id/runs/:runId/cancel')
  cancelRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Promise<HookRun> {
    return this.runs.cancel(id, runId);
  }

  @Get(':id/runs/:runId/deliveries')
  listDeliveries(
    @Param('id') _id: string,
    @Param('runId') runId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<HookDelivery[]> {
    const valid = status === 'success' || status === 'failed' || status === 'skipped';
    return this.runs.listDeliveries(runId, {
      status: valid ? (status as 'success' | 'failed' | 'skipped') : undefined,
      from: from != null ? Number(from) : undefined,
      to: to != null ? Number(to) : undefined,
      offset: offset ? Number(offset) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post(':id/runs/:runId/skip')
  async skip(
    @Param('id') _id: string,
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(skipSchema)) dto: SkipDTO,
  ): Promise<{ skipped: number }> {
    const skipped = await this.runs.skipDeliveries(runId, dto.sequences);
    return { skipped };
  }
}
