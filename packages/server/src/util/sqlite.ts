/**
 * SQLite 错误识别。
 *
 * 存在的意义：把"唯一约束冲突"翻译成业务语义的 `CONFLICT`，
 * 而不是让 500 带着一句 `SQLITE_CONSTRAINT_UNIQUE` 糊到用户脸上。
 */

/** 是否是约束冲突（唯一索引 / 外键等） */
export function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** 是否是唯一索引冲突（比约束冲突更具体） */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.includes('UNIQUE')) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

/** 是否是外键约束失败 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('FOREIGN KEY constraint failed');
}
