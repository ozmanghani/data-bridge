'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import { useHookDeliveries } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function DeliveryLog({
  hookId,
  runId,
  live,
}: {
  hookId: string;
  runId: string;
  live: boolean;
}) {
  const { data: deliveries, isLoading } = useHookDeliveries(hookId, runId, live);

  if (isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading deliveries…</p>;
  }
  if (!deliveries || deliveries.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No deliveries recorded yet.
      </p>
    );
  }

  return (
    <ScrollArea className="h-full">
      <Table>
        <TableHeader className="sticky top-0 bg-background">
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead className="w-20">Status</TableHead>
            <TableHead className="w-20">Code</TableHead>
            <TableHead className="w-16">Rows</TableHead>
            <TableHead className="w-20">Tries</TableHead>
            <TableHead className="w-20">Time</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {d.sequence}
              </TableCell>
              <TableCell>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-xs font-medium',
                    d.status === 'success' ? 'text-emerald-600' : 'text-destructive',
                  )}
                >
                  {d.status === 'success' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  {d.status}
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {d.httpStatus ?? '—'}
              </TableCell>
              <TableCell className="font-mono text-xs">{d.rowCount}</TableCell>
              <TableCell className="font-mono text-xs">{d.attempts}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {d.durationMs != null ? `${d.durationMs}ms` : '—'}
              </TableCell>
              <TableCell className="max-w-[1px] truncate font-mono text-xs text-muted-foreground">
                {d.error ?? d.responseSnippet ?? ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
