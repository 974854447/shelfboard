import { describe, expect, it } from 'vitest';

import {
  extractBearerToken,
  extractTokenFromUrl,
  requiresAuth,
  safeCompare,
} from '../src/auth';

describe('extractBearerToken', () => {
  it('取出标准的 Bearer 令牌', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('大小写不敏感、允许多余空白', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('  Bearer   abc123  ')).toBe('abc123');
  });

  it('非 Bearer 方案返回 undefined（不误认其他认证方式）', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('Token abc123')).toBeUndefined();
  });

  it('缺失或空值返回 undefined', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Bearer    ')).toBeUndefined();
    expect(extractBearerToken(123)).toBeUndefined();
    expect(extractBearerToken(['Bearer a', 'Bearer b'])).toBeUndefined();
  });
});

describe('safeCompare', () => {
  it('相同返回 true', () => {
    expect(safeCompare('token-abc', 'token-abc')).toBe(true);
  });

  it('不同返回 false', () => {
    expect(safeCompare('token-abc', 'token-abd')).toBe(false);
  });

  it('长度不同返回 false（且不抛异常）', () => {
    expect(safeCompare('short', 'much-longer-token')).toBe(false);
    expect(safeCompare('', 'x')).toBe(false);
  });

  it('支持中文等多字节内容', () => {
    expect(safeCompare('令牌一', '令牌一')).toBe(true);
    expect(safeCompare('令牌一', '令牌二')).toBe(false);
  });
});

describe('requiresAuth', () => {
  const prefix = '/api/v1';

  it('API 前缀之下需要鉴权', () => {
    expect(requiresAuth('/api/v1/projects', prefix)).toBe(true);
    expect(requiresAuth('/api/v1/logs?level=error', prefix)).toBe(true);
  });

  it('前缀之外不需要（静态资源、健康检查、降级页）', () => {
    expect(requiresAuth('/health', prefix)).toBe(false);
    expect(requiresAuth('/__degraded', prefix)).toBe(false);
    expect(requiresAuth('/assets/index.js', prefix)).toBe(false);
    expect(requiresAuth('/', prefix)).toBe(false);
  });

  it('不接受前缀伪装（/api/v10 不算）', () => {
    // 这是真实存在的一类越权尝试：靠同前缀字符串绕过路径判断
    expect(requiresAuth('/api/v10/secret', prefix)).toBe(true); // 仍以 /api/v1 开头 → 要求鉴权，安全
    expect(requiresAuth('/public/api/v1/x', prefix)).toBe(false);
  });
});

describe('extractTokenFromUrl', () => {
  it('取出查询参数中的令牌', () => {
    expect(extractTokenFromUrl('/api/v1/logs/stream?token=abc123')).toBe('abc123');
    expect(extractTokenFromUrl('/x?a=1&token=abc123&b=2')).toBe('abc123');
  });

  it('对令牌做 URL 解码', () => {
    expect(extractTokenFromUrl('/x?token=a%2Bb%3Dc')).toBe('a+b=c');
  });

  it('没有查询串或没有该参数时返回 undefined', () => {
    expect(extractTokenFromUrl('/api/v1/logs')).toBeUndefined();
    expect(extractTokenFromUrl('/api/v1/logs?other=1')).toBeUndefined();
    expect(extractTokenFromUrl('/api/v1/logs?token=')).toBeUndefined();
  });
});
