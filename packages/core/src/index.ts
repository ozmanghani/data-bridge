/**
 * Web-safe entry point: types, error classes, and validation schemas only.
 * Importing this never pulls in a native database driver, so it is safe for the
 * browser bundle. Server code that needs to open connections imports from
 * `@relay/core/adapters` instead.
 */
export * from './adapters/types';
export * from './errors';
export * from './validation';
export * from './hooks';

// Type-only re-exports of the driver metadata (no driver implementations are
// pulled in, so this stays safe for the browser bundle).
export type {
  DriverInfo,
  DriverField,
  DriverDefinition,
} from './adapters/registry';
