import { describe, expect, it } from 'vitest';

import {
  isSensitiveKey,
  REDACTION_PLACEHOLDER,
  redactDetail,
  redactText,
  redactValue,
} from '../src/logging/redact';

const P = REDACTION_PLACEHOLDER;

describe('redactText — 平台令牌', () => {
  it('GitLab PAT 保留前缀、抹掉凭证', () => {
    expect(redactText('clone via glpat-ABCDEFGHIJKLMNOPQRST')).toBe('clone via glpat-***');
  });

  it('GitHub 细粒度 PAT', () => {
    const out = redactText('token github_pat_11ABCDEFG0123456789_abcdefghijklmnop');
    expect(out).toContain('github_pat_***');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('GitHub 经典 PAT', () => {
    const out = redactText('using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(out).toContain('ghp_***');
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redactText(`Authorization failed for ${jwt}`);
    expect(out).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it('AWS Access Key ID', () => {
    expect(redactText('key AKIAIOSFODNN7EXAMPLE leaked')).toBe('key AKIA*** leaked');
  });

  it('OpenAI 风格 sk- 密钥', () => {
    expect(redactText('sk-abcdefghijklmnopqrstuvwxyz')).toBe('sk-***');
  });

  it('PEM 私钥整块抹掉', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefghij',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(pem);
    expect(out).not.toContain('MIIEowIBAAKCAQEA1234567890abcdefghij');
    expect(out).toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('redactText — 头部与赋值', () => {
  it('Authorization 头整行抹掉（含方案 + 凭证写法）', () => {
    // 这是最容易漏的一种：通用赋值规则按空白截断，只会抹掉 "Token"，
    // 把真正的凭证留在日志里。
    expect(redactText('Authorization: Token abc123secretvalue')).toBe(`Authorization: ${P}`);
    expect(redactText('Authorization: Bearer abc123def456')).toBe(`Authorization: ${P}`);
  });

  it('裸 Bearer（无冒号，如命令行回显）', () => {
    expect(redactText('curl -H "Bearer abc123def456" api')).toBe('curl -H "Bearer ***" api');
  });

  it('Cookie 整行抹掉', () => {
    expect(redactText('Cookie: session=abc123; theme=dark')).toBe(`Cookie: ${P}`);
    expect(redactText('Set-Cookie: sid=xyz; HttpOnly')).toBe(`Set-Cookie: ${P}`);
  });

  it('query string 里的 token 只抹值、保留其他参数', () => {
    expect(redactText('GET /api?token=abc123&page=2')).toBe('GET /api?token=***&page=2');
  });

  it('password= 形式', () => {
    expect(redactText('password=hunter2')).toBe(`password=${P}`);
  });

  it('JSON 里的敏感字段，保留引号风格', () => {
    expect(redactText('{"password": "hunter2", "user": "bob"}')).toBe(
      `{"password": "***", "user": "bob"}`,
    );
  });

  it('单引号风格同样保留', () => {
    expect(redactText("token='abc123'")).toBe("token='***'");
  });
});

describe('redactText — 用户目录', () => {
  it('Windows 用户目录里的用户名替换为 %USER%', () => {
    expect(redactText('写入 C:\\Users\\ZhuanZ\\AppData\\Local\\npm-cache 失败')).toBe(
      '写入 C:\\Users\\%USER%\\AppData\\Local\\npm-cache 失败',
    );
  });

  it('macOS / Linux 用户目录同样处理', () => {
    expect(redactText('/home/zhuanz/project/src/index.ts')).toBe('/home/%USER%/project/src/index.ts');
    expect(redactText('/Users/zhuanz/x')).toBe('/Users/%USER%/x');
  });

  /**
   * 回归用例：日志的 detail 字段是把对象 JSON.stringify 后存的，
   * 而 JSON 会把反斜杠转义成两个。只匹配单反斜杠的规则会**完全漏掉**这种形态，
   * 于是"路径里的用户名脱敏"在最常见的载体上失效。
   */
  it('JSON 序列化后的 Windows 路径同样脱敏（反斜杠被转义成两个）', () => {
    const json = JSON.stringify({ cwd: 'C:\\Users\\ZhuanZ\\AppData\\Local\\npm-cache' });
    // 先确认测试数据确实是转义形态，否则这条用例会假通过
    expect(json).toContain('C:\\\\Users\\\\ZhuanZ');

    const out = redactText(json);
    expect(out).not.toContain('ZhuanZ');
    expect(out).toContain('%USER%');
  });

  it('正斜杠形式的 Windows 路径同样脱敏', () => {
    const out = redactText('C:/Users/ZhuanZ/project');
    expect(out).not.toContain('ZhuanZ');
    expect(out).toContain('%USER%');
  });

  it('可用选项关闭用户名脱敏（仅此一项可配，整体脱敏不可关闭）', () => {
    const out = redactText('C:\\Users\\ZhuanZ\\file.txt', { redactUserName: false });
    expect(out).toBe('C:\\Users\\ZhuanZ\\file.txt');
  });
});

describe('redactText — 性质保证', () => {
  const samples = [
    'Authorization: Bearer abc123def456',
    'glpat-ABCDEFGHIJKLMNOPQRST',
    'password=hunter2',
    'C:\\Users\\ZhuanZ\\AppData',
    'C:\\\\Users\\\\ZhuanZ\\\\AppData',
    '/home/bob/x',
    '{"token": "abc123", "n": 1}',
    'Cookie: a=b; c=d',
  ];

  it('幂等：脱敏两次结果一致', () => {
    for (const s of samples) {
      const once = redactText(s);
      expect(redactText(once)).toBe(once);
    }
  });

  it('不误伤普通文本', () => {
    const normal = 'GET /api/v1/projects 200 12ms traceId=tr_m1x2y3z4_a1b2c3d4e5';
    expect(redactText(normal)).toBe(normal);
    // "Token bucket" 是算法术语，不应被当成认证方案
    expect(redactText('Token bucket rate limiting')).toBe('Token bucket rate limiting');
  });

  it('knownSecrets 无条件整体替换（即使不符合任何模式）', () => {
    const runtimeToken = 'aa11bb22cc33dd44ee55ff66';
    const out = redactText(`本地 API 请求用 ${runtimeToken} 认证`, {
      knownSecrets: [runtimeToken],
    });
    expect(out).not.toContain(runtimeToken);
    expect(out).toContain(P);
  });

  it('过短的 knownSecrets 被忽略，避免误伤正常文本', () => {
    expect(redactText('abc', { knownSecrets: ['abc'] })).toBe('abc');
  });

  it('空串、超长输入、异常输入都不抛异常', () => {
    expect(redactText('')).toBe('');
    expect(() => redactText('x'.repeat(500_000))).not.toThrow();
    // @ts-expect-error 故意传错类型，验证兜底
    expect(redactText(null)).toBe(null);
  });
});

describe('redactValue — 结构化值', () => {
  it('敏感字段名的值整体替换，不看内容', () => {
    const out = redactValue({ password: 'hunter2', token: 'anything', user: 'bob' });
    expect(out).toEqual({ password: P, token: P, user: 'bob' });
  });

  it('嵌套对象与数组递归处理', () => {
    const out = redactValue({
      req: { headers: { authorization: 'Bearer xyz123456' }, url: '/api' },
      items: [{ apiKey: 'k1' }, { note: 'ok' }],
    });
    expect(out).toEqual({
      req: { headers: { authorization: P }, url: '/api' },
      items: [{ apiKey: P }, { note: 'ok' }],
    });
  });

  it('Error 对象保留 name/message/stack 且全部脱敏', () => {
    const err = new Error('请求失败 glpat-ABCDEFGHIJKLMNOPQRST');
    err.stack = 'Error: 请求失败 glpat-ABCDEFGHIJKLMNOPQRST\n    at foo';
    const out = redactValue(err) as { name: string; message: string; stack: string };
    expect(out.name).toBe('Error');
    expect(out.message).toContain('glpat-***');
    expect(out.stack).not.toContain('ABCDEFGHIJKLMNOPQRST');
  });

  it('循环引用不栈溢出', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('二进制内容只保留长度', () => {
    expect(redactValue(Buffer.from('secret'))).toBe('[binary 6 bytes]');
  });

  it('超过深度上限的部分丢弃', () => {
    const deep = { a: { b: { c: { d: { e: 'x' } } } } };
    expect(redactValue(deep, { maxDepth: 3 })).toEqual({ a: { b: { c: '[max-depth]' } } });
  });

  it('Map 的敏感键同样处理', () => {
    const m = new Map<string, unknown>([['password', 'hunter2'], ['user', 'bob']]);
    expect(redactValue(m)).toEqual({ password: P, user: 'bob' });
  });
});

describe('redactDetail — 落库/落盘统一入口', () => {
  it('null / undefined 返回 null', () => {
    expect(redactDetail(null)).toBeNull();
    expect(redactDetail(undefined)).toBeNull();
  });

  it('字符串直接脱敏', () => {
    expect(redactDetail('token=abc123')).toBe('token=***');
  });

  it('对象序列化后仍不残留机密', () => {
    const out = redactDetail({ authorization: 'Bearer abc123def456', glpat: 'glpat-ABCDEFGHIJKLMNOP' });
    expect(out).not.toContain('abc123def456');
    expect(out).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('Error 转成可读字符串', () => {
    expect(redactDetail(new Error('boom'))).toContain('boom');
  });
});

describe('isSensitiveKey', () => {
  it('识别常见敏感字段（大小写不敏感）', () => {
    for (const k of ['password', 'Password', 'api_key', 'apiKey', 'Authorization', 'glpat']) {
      if (k === 'glpat') continue; // 不是字段名，单独验证下面的反例
      expect(isSensitiveKey(k)).toBe(true);
    }
  });

  it('不把正常字段当敏感字段', () => {
    for (const k of ['traceId', 'jobId', 'message', 'level', 'user', 'name', 'glpat']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });

  it('支持追加自定义敏感字段', () => {
    expect(isSensitiveKey('cookieJar')).toBe(false);
    expect(isSensitiveKey('cookieJar', { extraSensitiveKeys: ['cookieJar'] })).toBe(true);
  });
});
