/**
 * persistent store for saved connections, backed by Prisma (SQLite).
 * secrets (password, connection string) are encrypted at rest. callers get a
 * redacted view unless they explicitly resolve the full config
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Connection as ConnectionRow } from '@prisma/client';
import {
  type ConnectionConfig,
  type ConnectionInput,
  DEFAULT_WORKSPACE_ID,
  NotFoundError,
} from '@data-bridge/core';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';

const REDACTED = '********';

@Injectable()
export class ConnectionStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  private toConfig(row: ConnectionRow, includeSecrets: boolean): ConnectionConfig {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      engine: row.engine as ConnectionConfig['engine'],
      color: row.color ?? undefined,
      host: row.host ?? undefined,
      port: row.port ?? undefined,
      user: row.user ?? undefined,
      password:
        includeSecrets && row.passwordEnc
          ? this.crypto.decrypt(row.passwordEnc)
          : row.passwordEnc
            ? REDACTED
            : undefined,
      database: row.database ?? undefined,
      ssl: row.ssl,
      connectionString:
        includeSecrets && row.connectionStringEnc
          ? this.crypto.decrypt(row.connectionStringEnc)
          : row.connectionStringEnc
            ? REDACTED
            : undefined,
      options: row.optionsJson
        ? (JSON.parse(row.optionsJson) as Record<string, unknown>)
        : undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async getRow(id: string): Promise<ConnectionRow> {
    const row = await this.prisma.connection.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(`Connection "${id}" not found`);
    return row;
  }

  async list(workspaceId?: string): Promise<ConnectionConfig[]> {
    const rows = await this.prisma.connection.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toConfig(r, false));
  }

  async get(id: string): Promise<ConnectionConfig> {
    return this.toConfig(await this.getRow(id), false);
  }

  /** full config including decrypted secrets, server-internal use only */
  async resolve(id: string): Promise<ConnectionConfig> {
    return this.toConfig(await this.getRow(id), true);
  }

  async create(input: ConnectionInput): Promise<ConnectionConfig> {
    const row = await this.prisma.connection.create({
      data: {
        id: randomUUID(),
        name: input.name,
        workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
        engine: input.engine,
        color: input.color ?? null,
        host: input.host ?? null,
        port: input.port ?? null,
        user: input.user ?? null,
        passwordEnc: input.password ? this.crypto.encrypt(input.password) : null,
        database: input.database ?? null,
        ssl: input.ssl ?? false,
        connectionStringEnc: input.connectionString
          ? this.crypto.encrypt(input.connectionString)
          : null,
        optionsJson: input.options ? JSON.stringify(input.options) : null,
      },
    });
    return this.toConfig(row, false);
  }

  async update(id: string, input: ConnectionInput): Promise<ConnectionConfig> {
    const existing = await this.getRow(id);

    // keep stored secrets when the client sends the redaction sentinel
    const passwordEnc =
      input.password === REDACTED
        ? existing.passwordEnc
        : input.password
          ? this.crypto.encrypt(input.password)
          : null;
    const connectionStringEnc =
      input.connectionString === REDACTED
        ? existing.connectionStringEnc
        : input.connectionString
          ? this.crypto.encrypt(input.connectionString)
          : null;

    const row = await this.prisma.connection.update({
      where: { id },
      data: {
        name: input.name,
        engine: input.engine,
        color: input.color ?? null,
        host: input.host ?? null,
        port: input.port ?? null,
        user: input.user ?? null,
        passwordEnc,
        database: input.database ?? null,
        ssl: input.ssl ?? false,
        connectionStringEnc,
        optionsJson: input.options ? JSON.stringify(input.options) : null,
      },
    });
    return this.toConfig(row, false);
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id); // 404s if missing
    await this.prisma.connection.delete({ where: { id } });
  }
}
