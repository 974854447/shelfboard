/**
 * 统一响应包构造器。
 *
 * 前后端共用同一份定义，避免两边各写一套 `{ ok, data }` 的字面量
 * 而在某次改动后悄悄错位。
 */

import type { ApiFailure, ApiSuccess } from './types.js';

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function fail(
  code: string,
  message: string,
  extra?: { details?: unknown; traceId?: string },
): ApiFailure {
  const error: ApiFailure['error'] = { code, message };
  if (extra?.details !== undefined) error.details = extra.details;
  if (extra?.traceId !== undefined) error.traceId = extra.traceId;
  return { ok: false, error };
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === 'object'
  );
}
