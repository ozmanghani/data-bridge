'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  MousePointerClick,
  SkipForward,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { DeliveryStatus, HookDelivery } from '@relay/core';
import { ApiError } from '@/lib/api';
import { useHookDeliveries, useSkipDeliveries } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const CELLS_PER_PAGE = 600;

/** Visual state of a timeline cell. */
type CellState = DeliveryStatus | 'queued';

const CELL_STYLES: Record<CellState, string> = {
  success: 'bg-emerald-500 border-emerald-600/50 text-white',
  failed: 'bg-red-500 border-red-700/50 text-white',
  skipped: 'bg-amber-400 border-amber-600/50 text-amber-950',
  queued: 'bg-muted border-border text-muted-foreground',
};

const LEGEND: { state: CellState; label: string }[] = [
  { state: 'success', label: 'Delivered' },
  { state: 'failed', label: 'Failed' },
  { state: 'skipped', label: 'Skipped' },
  { state: 'queued', label: 'Queued' },
];

function pretty(text: string | null): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function DeliveryMonitor({
  hookId,
  runId,
  live,
  totalRows,
  batchSize,
  endpoint,
}: {
  hookId: string;
  runId: string;
  live: boolean;
  totalRows: number | null;
  batchSize: number;
  endpoint: { url: string; method: string };
}) {
  const cellCount = totalRows != null ? Math.ceil(totalRows / Math.max(1, batchSize)) : null;
  const pageCount = cellCount != null ? Math.max(1, Math.ceil(cellCount / CELLS_PER_PAGE)) : 1;

  const [page, setPage] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  useEffect(() => {
    setPage(0);
    setSelected(new Set());
    setOpenId(null);
    setSelectMode(false);
  }, [runId]);

  const windowStart = page * CELLS_PER_PAGE;
  const windowEnd =
    cellCount != null
      ? Math.min(windowStart + CELLS_PER_PAGE, cellCount)
      : windowStart + CELLS_PER_PAGE;

  // Fetch only the visible window's deliveries — keeps load flat on huge runs.
  const { data: deliveries } = useHookDeliveries(hookId, runId, live, {
    from: cellCount != null ? windowStart : undefined,
    to: cellCount != null ? windowEnd - 1 : undefined,
  });

  const bySeq = useMemo(() => {
    const m = new Map<number, HookDelivery>();
    for (const d of deliveries ?? []) m.set(d.sequence, d);
    return m;
  }, [deliveries]);

  // The sequences to render as cells this page.
  const sequences = useMemo(() => {
    if (cellCount != null) {
      return Array.from({ length: windowEnd - windowStart }, (_, i) => windowStart + i);
    }
    // Unknown total: render whatever deliveries we have, densely.
    return [...bySeq.keys()].sort((a, b) => a - b);
  }, [cellCount, windowStart, windowEnd, bySeq]);

  const skip = useSkipDeliveries(hookId, runId);
  const openDelivery = (deliveries ?? []).find((d) => d.id === openId) ?? null;

  function cellState(seq: number): CellState {
    return (bySeq.get(seq)?.status as CellState) ?? 'queued';
  }

  function onCellClick(seq: number, shift: boolean) {
    if (selectMode) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (shift && anchor != null) {
          const [lo, hi] = anchor < seq ? [anchor, seq] : [seq, anchor];
          for (let s = lo; s <= hi; s++) next.add(s);
        } else if (next.has(seq)) next.delete(seq);
        else next.add(seq);
        return next;
      });
      setAnchor(seq);
      return;
    }
    const d = bySeq.get(seq);
    if (d) setOpenId(d.id);
  }

  function selectQueuedOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const seq of sequences) if (!bySeq.get(seq)) next.add(seq);
      return next;
    });
  }

  async function runSkip(targets: number[]) {
    if (targets.length === 0) {
      toast.info('Nothing queued to skip there (settled rows can’t be skipped).');
      return;
    }
    if (targets.length > 10_000) {
      toast.error('Too many at once — skip up to 10,000 rows per action.');
      return;
    }
    try {
      const res = await skip.mutateAsync(targets);
      toast.success(`Skipped ${res.skipped.toLocaleString()} row${res.skipped === 1 ? '' : 's'}`);
      setSelected(new Set());
    } catch (err) {
      toast.error('Could not skip', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function skipRange() {
    const from = Number(rangeFrom);
    const to = Number(rangeTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      toast.error('Enter a valid range (from ≤ to).');
      return;
    }
    const targets: number[] = [];
    for (let s = Math.max(0, from); s <= to; s++) if (!bySeq.get(s)) targets.push(s);
    await runSkip(targets);
  }

  const selectedQueued = [...selected].filter((s) => !bySeq.get(s)).length;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-2">
          <div className="flex items-center gap-3 text-[11px]">
            {LEGEND.map((l) => (
              <span key={l.state} className="text-muted-foreground flex items-center gap-1">
                <span
                  className={cn('h-3 w-3 rounded-sm border', CELL_STYLES[l.state])}
                />
                {l.label}
              </span>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Range skip — for skipping many rows without clicking each */}
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-7">
                  <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                  Skip rows…
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-2">
                <p className="text-xs font-medium">Skip a range of queued rows</p>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    placeholder="from"
                    className="h-8"
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value)}
                  />
                  <span className="text-muted-foreground text-xs">to</span>
                  <Input
                    type="number"
                    placeholder="to"
                    className="h-8"
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  className="h-7 w-full"
                  disabled={skip.isPending}
                  onClick={skipRange}
                >
                  Skip range
                </Button>
                <p className="text-muted-foreground text-[11px]">
                  Skips queued rows whose sequence is in the range. Already-sent
                  rows are left untouched.
                </p>
              </PopoverContent>
            </Popover>

            <Button
              size="sm"
              variant={selectMode ? 'default' : 'outline'}
              className="h-7"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelected(new Set());
              }}
            >
              <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
              {selectMode ? 'Selecting' : 'Select'}
            </Button>
            {selectMode && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={selectQueuedOnPage}
                >
                  Select queued (page)
                </Button>
                {selected.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-7"
                  disabled={selectedQueued === 0 || skip.isPending}
                  onClick={() => runSkip([...selected].filter((s) => !bySeq.get(s)))}
                >
                  <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                  Skip {selectedQueued > 0 ? selectedQueued : ''}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sequences.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">No deliveries yet.</p>
          ) : (
            <div
              className="grid gap-1 p-3"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(1.9rem, 1fr))',
              }}
            >
              {sequences.map((seq) => {
                const state = cellState(seq);
                const isSel = selected.has(seq);
                const d = bySeq.get(seq);
                return (
                  <button
                    key={seq}
                    onClick={(e) => onCellClick(seq, e.shiftKey)}
                    title={`#${seq} · ${state}${d?.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}`}
                    className={cn(
                      'flex h-[30px] items-center justify-center rounded-md border text-[10px] font-semibold tabular-nums transition-transform hover:scale-105',
                      CELL_STYLES[state],
                      openDelivery?.sequence === seq && 'ring-foreground z-10 ring-2',
                      isSel && 'ring-primary z-10 ring-2',
                    )}
                  >
                    {seq}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {cellCount != null && pageCount > 1 && (
          <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-xs">
            <span>
              cells {windowStart}–{windowEnd - 1} of {cellCount.toLocaleString()}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-1">
                {page + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Detail */}
      {openDelivery && (
        <div className="bg-muted/20 w-[44%] min-w-[320px] border-l">
          <DeliveryDetail
            delivery={openDelivery}
            endpoint={endpoint}
            onClose={() => setOpenId(null)}
          />
        </div>
      )}
    </div>
  );
}

function DeliveryDetail({
  delivery: d,
  endpoint,
  onClose,
}: {
  delivery: HookDelivery;
  endpoint: { url: string; method: string };
  onClose: () => void;
}) {
  function copyCurl() {
    const parts = [
      `curl -X ${endpoint.method}`,
      `'${endpoint.url}'`,
      `-H 'content-type: application/json'`,
    ];
    if (d.requestBody) parts.push(`-d '${d.requestBody.replace(/'/g, "'\\''")}'`);
    void navigator.clipboard.writeText(parts.join(' \\\n  '));
    toast.success('Copied cURL to clipboard');
  }

  const tone =
    d.status === 'success'
      ? 'bg-emerald-500/15 text-emerald-600'
      : d.status === 'skipped'
        ? 'bg-amber-500/15 text-amber-600'
        : 'bg-destructive/15 text-destructive';

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-3 p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 font-medium capitalize', tone)}>
            {d.status}
          </span>
          {d.httpStatus != null && <span className="font-mono">HTTP {d.httpStatus}</span>}
          <div className="ml-auto flex items-center gap-1">
            {d.status !== 'skipped' && (
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copyCurl}>
                <Copy className="mr-1 h-3.5 w-3.5" /> cURL
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>
            seq <span className="text-foreground font-mono">{d.sequence}</span>
          </span>
          <span>
            row{' '}
            <span className="text-foreground font-mono">
              {d.rowIndex}
              {d.rowCount > 1 ? `–${d.rowIndex + d.rowCount - 1}` : ''}
            </span>
          </span>
          <span>
            attempts <span className="text-foreground">{d.attempts}</span>
          </span>
          {d.durationMs != null && (
            <span>
              took <span className="text-foreground">{d.durationMs}ms</span>
            </span>
          )}
        </div>

        {d.error && (
          <Block label="Error" tone="danger">
            {d.error}
          </Block>
        )}
        {d.status !== 'skipped' && (
          <>
            <Block label="Request body">{pretty(d.requestBody) || '—'}</Block>
            <Block label="Response">{pretty(d.responseBody) || '(empty)'}</Block>
          </>
        )}
        {d.status === 'skipped' && (
          <p className="text-muted-foreground">
            This row was skipped and never sent.
          </p>
        )}
      </div>
    </div>
  );
}

function Block({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-1">{label}</p>
      <pre
        className={cn(
          'max-h-60 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap',
          tone === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-muted',
        )}
      >
        {children}
      </pre>
    </div>
  );
}
