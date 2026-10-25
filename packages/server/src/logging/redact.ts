/**
 * 日志脱敏管道。
 *
 * 定位：**落库与落盘之前**的最后一道关卡，不可绕过、不可关闭。
 * 原因很实际 —— 日志里最容易泄露的三样东西是 `Authorization` 头、
 * 各平台的 Personal Access Token、以及用户目录里的用户名。这些一旦写进
 * 日志文件，用户导出诊断包发给别人时就变成了事故。
 *
 * 设计原则：
 * 1. **宁可多脱，不可漏脱**。误伤一段普通文本的代价，远小于泄露一个 token。
 * 2. **幂等**。脱敏两次结果必须一致（`***` 不会再被当成机密二次变形）。
 * 3. **永不抛异常**。日志系统自己崩溃是最糟的情况，任何异常都退化为安全输出。
 * 4. **不依赖外部包**。这层被日志管道最底层引用，依赖越少越好。
 *
 * 注意：`redactUserName` 可以配置开关，但**没有任何选项能关掉整体脱敏**。
 */

import type { LogLevel } from '@pm-studio/shared';

export const REDACTION_PLACEHOLDER = '***';

export interface RedactOptions {
  /** 是否把 `C:\Users\<名字>` 这类路径里的用户名替换为 `%USER%`（默认 true） */
  redactUserName?: boolean;
  /** 运行时已知的机密（例如本地 API 的一次性 Token），无条件整体替换 */
  knownSecrets?: readonly string[];
  /** 替换后的占位符，默认 `***` */
  placeholder?: string;
  /** 结构化值递归的最大深度，默认 6；超出部分丢弃为 `[max-depth]` */
  maxDepth?: number;
  /** 额外视为敏感的字段名（大小写不敏感，支持正则字符） */
  extraSensitiveKeys?: readonly string[];
}

interface RedactContext {
  placeholder: string;
  redactUserName: boolean;
  knownSecrets: readonly string[];
  sensitiveKeyRe: RegExp;
  maxDepth: number;
}

/* ------------------------------------------------------------------ *
 * 字段名：结构化日志里，这些 key 的**值**整体丢弃，不看内容
 * ------------------------------------------------------------------ */

const BASE_SENSITIVE_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'token',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'auth[_-]?token',
  'api[_-]?key',
  'apikey',
  'x-api-key',
  'secret',
  'client[_-]?secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'credential',
  'credentials',
  'private[_-]?key',
  'session[_-]?id',
] as const;

function buildSensitiveKeyRe(extra: readonly string[] = []): RegExp {
  const keys = [...BASE_SENSITIVE_KEYS, ...extra];
  return new RegExp(`^(?:${keys.join('|')})$`, 'i');
}

/** 判断一个字段名是否属于「值一律脱敏」的敏感字段 */
export function isSensitiveKey(key: string, options?: RedactOptions): boolean {
  return buildSensitiveKeyRe(options?.extraSensitiveKeys).test(key.trim());
}

/* ------------------------------------------------------------------ *
 * 文本规则
 * ------------------------------------------------------------------ */

/**
 * 各平台有固定前缀的令牌。
 *
 * `keepPrefixLen` 保留原始前缀是有意的：排查时需要一眼看出
 * "泄露的是 GitLab 的 PAT 还是 GitHub 的"，而不是笼统的 `***`。
 */
const PREFIXED_TOKEN_RULES: ReadonlyArray<{ re: RegExp; keepPrefixLen: number }> = [
  { re: /\bglpat-[A-Za-z0-9_-]{10,}/g, keepPrefixLen: 6 }, // GitLab PAT -> glpat-***
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, keepPrefixLen: 11 }, // GitHub 细粒度 -> github_pat_***
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, keepPrefixLen: 4 }, // GitHub 经典 -> ghp_***
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, keepPrefixLen: 3 }, // OpenAI 风格 -> sk-***
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, keepPrefixLen: 5 }, // Slack -> xoxb-***
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, keepPrefixLen: 4 }, // AWS Access Key -> AKIA***
  {
    // JWT：三段 base64url，第一段必然是 eyJ 开头
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    keepPrefixLen: 3,
  },
];

/** PEM 私钥块：整块吃掉 */
const PEM_PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** `Bearer xxx` / `Basic xxx` —— 认证方案是公开信息，凭证不是 */
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Digest)\s+([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * 敏感头部整行：值一律吃到行尾。
 *
 * 单独成一条规则是必须的 —— 通用的 `key: value` 规则按空白截断，
 * 遇到 `Authorization: Token abc123` 这种「方案 + 凭证」写法只会抹掉 `Token`，
 * 把真正的凭证 `abc123` 完整留在日志里。这是最容易漏的一处泄露。
 */
const HEADER_LINE_RE =
  /\b((?:Authorization|Proxy-Authorization|X-Api-Key|Api-Key|X-Auth-Token|Cookie|Set-Cookie)\s*:\s*)([^\r\n]+)/gi;

/** `key=value` / `key: value` / `"key": "value"` 形式的赋值 */
const ASSIGNMENT_KEYS =
  'authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?id|client[_-]?secret|secret|password|passwd|pwd|passphrase|credential[s]?|private[_-]?key|token';

const ASSIGNMENT_RE = new RegExp(
  `(["']?(?:${ASSIGNMENT_KEYS})["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;&)}\\]]+)`,
  'gi',
);

/**
 * 用户目录：用户名替换为 %USER%（机器级路径，必然在工作区之外）。
 *
 * 这里有三条规则而不是一条，原因是**同一个路径在不同载体里的形态不同**：
 *
 * 1. 原样文本：`C:\Users\someone\...`
 * 2. **JSON 序列化后**：`C:\\Users\\someone\\...` —— JSON 会把反斜杠转义成两个，
 *    只匹配单反斜杠的规则会**完全漏掉这一种**。
 *    而日志的 `detail` 字段恰恰就是把对象序列化成 JSON 存的，
 *    所以这条不是"以防万一"，而是主路径。
 * 3. 正斜杠形式：`C:/Users/someone/...`
 */
const WINDOWS_USER_PATH_RE = /([A-Za-z]:\\Users\\)([^\\\s"';|,]+)/g;
const WINDOWS_USER_PATH_JSON_RE = /([A-Za-z]:\\\\Users\\\\)([^\\\s"';|,]+)/g;
const WINDOWS_USER_PATH_FORWARD_RE = /([A-Za-z]:\/Users\/)([^/\s"';|,]+)/g;
const UNIX_USER_PATH_RE = /(\/(?:home|Users)\/)([^/\s"';|,]+)/g;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactTextOnce(input: string, ctx: RedactContext): string {
  let out = input;

  // 1) 运行时已知机密最优先：它们可能不符合任何模式
  for (const secret of ctx.knownSecrets) {
    if (secret.length < 8) continue; // 太短的串整体替换会误伤正常文本
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), ctx.placeholder);
  }

  // 2) PEM 私钥块
  out = out.replace(PEM_PRIVATE_KEY_RE, `-----BEGIN PRIVATE KEY-----${ctx.placeholder}-----END PRIVATE KEY-----`);

  // 3) 有固定前缀的令牌（保留前缀，只抹凭证）
  for (const { re, keepPrefixLen } of PREFIXED_TOKEN_RULES) {
    out = out.replace(re, (match) => `${match.slice(0, keepPrefixLen)}${ctx.placeholder}`);
  }

  // 4) 敏感头部整行（必须先于通用赋值规则，否则形如
  //    `Authorization: Token abc` 的凭证会漏网）
  out = out.replace(HEADER_LINE_RE, (_m, head: string) => `${head}${ctx.placeholder}`);

  // 5) 裸认证方案 + 凭证（如命令行回显、curl 参数里的 Bearer xxx）
  out = out.replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${ctx.placeholder}`);

  // 6) key=value / key: value —— 保留原有引号风格，便于结构化日志仍可读
  out = out.replace(ASSIGNMENT_RE, (_m, head: string, rawValue: string) => {
    const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : '';
    return `${head}${quote}${ctx.placeholder}${quote}`;
  });

  // 7) 用户目录（三种载体形态都要覆盖，见上面的规则说明）
  if (ctx.redactUserName) {
    out = out
      .replace(WINDOWS_USER_PATH_JSON_RE, (_m, head: string) => `${head}%USER%`)
      .replace(WINDOWS_USER_PATH_RE, (_m, head: string) => `${head}%USER%`)
      .replace(WINDOWS_USER_PATH_FORWARD_RE, (_m, head: string) => `${head}%USER%`)
      .replace(UNIX_USER_PATH_RE, (_m, head: string) => `${head}%USER%`);
  }

  return out;
}

/**
 * 对一段文本脱敏。
 *
 * 内部会重复执行直到结果稳定（最多 3 轮），以防某条规则的处理结果
 * 恰好又构成另一条规则的输入（例如 `Bearer token=abc` 这种嵌套写法）。
 */
export function redactText(input: string, options: RedactOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) return input;

  const ctx: RedactContext = {
    placeholder: options.placeholder ?? REDACTION_PLACEHOLDER,
    redactUserName: options.redactUserName ?? true,
    knownSecrets: options.knownSecrets ?? [],
    sensitiveKeyRe: buildSensitiveKeyRe(options.extraSensitiveKeys),
    maxDepth: options.maxDepth ?? 6,
  };

  try {
    let current = input;
    for (let i = 0; i < 3; i += 1) {
      const next = redactTextOnce(current, ctx);
      if (next === current) break;
      current = next;
    }
    return current;
  } catch {
    // 脱敏逻辑本身出错时，绝不能把原文放出去
    return `[redaction-failed:${input.length}chars]`;
  }
}

/* ------------------------------------------------------------------ *
 * 结构化值
 * ------------------------------------------------------------------ */

function stringifyForDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 对任意值做深度脱敏，返回**可安全写日志**的形态。
 *
 * - 字符串走 `redactText`
 * - 字段名命中敏感名单 → 整个值替换为占位符（不看内容）
 * - Error → 保留 name/message/stack，均经脱敏
 * - Buffer/TypedArray → 只留长度
 * - 循环引用 → `[circular]`；超深 → `[max-depth]`
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const placeholder = options.placeholder ?? REDACTION_PLACEHOLDER;
  const maxDepth = options.maxDepth ?? 6;
  const sensitiveKeyRe = buildSensitiveKeyRe(options.extraSensitiveKeys);
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;

    const t = typeof input;
    if (t === 'string') return redactText(input as string, options);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return input;
    if (t === 'symbol' || t === 'function') return `[${t}]`;

    if (depth >= maxDepth) return '[max-depth]';

    if (input instanceof Error) {
      return {
        name: input.name,
        message: redactText(input.message, options),
        stack: input.stack ? redactText(input.stack, options) : undefined,
      };
    }

    if (input instanceof Date) return input.toISOString();
    if (input instanceof RegExp) return input.toString();

    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
      const len =
        input instanceof ArrayBuffer
          ? input.byteLength
          : (input as ArrayBufferView).byteLength;
      return `[binary ${len} bytes]`;
    }

    if (typeof input === 'object') {
      const obj = input as object;
      if (seen.has(obj)) return '[circular]';
      seen.add(obj);

      try {
        if (Array.isArray(input)) {
          return input.map((item) => walk(item, depth + 1));
        }
        if (input instanceof Map) {
          return Object.fromEntries(
            [...input.entries()].map(([k, v]) => [
              String(k),
              sensitiveKeyRe.test(String(k)) ? placeholder : walk(v, depth + 1),
            ]),
          );
        }
        if (input instanceof Set) {
          return [...input.values()].map((item) => walk(item, depth + 1));
        }

        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
          out[key] = sensitiveKeyRe.test(key) ? placeholder : walk(val, depth + 1);
        }
        return out;
      } finally {
        seen.delete(obj);
      }
    }

    return input;
  };

  try {
    return walk(value, 0);
  } catch {
    return '[redaction-failed]';
  }
}

/**
 * 把任意 detail 转成存入 `app_logs.detail` 的字符串。
 *
 * 这是写入路径上的统一入口 —— 任何要落库/落盘的细节都必须走它，
 * 不允许调用方自己 `JSON.stringify` 后直接塞进去。
 */
export function redactDetail(detail: unknown, options: RedactOptions = {}): string | null {
  if (detail === undefined || detail === null) return null;

  try {
    if (typeof detail === 'string') return redactText(detail, options);
    return redactText(stringifyForDetail(redactValue(detail, options)), options);
  } catch {
    return '[redaction-failed]';
  }
}

/** 供日志约定使用的级别判断：error 级别必须附带 detail，便于定位 */
export function shouldIncludeDetail(level: LogLevel): boolean {
  return level === 'error' || level === 'warn';
}
