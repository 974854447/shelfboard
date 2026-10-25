/**
 * SSE 帧解析与消费。
 *
 * 为什么自己解析而不是用原生 `EventSource`：
 * **`EventSource` 不支持自定义请求头**，令牌只能塞进查询参数（于是会进入 URL、
 * 进入访问日志）。用 `fetch` 流式读取可以把令牌留在 `Authorization` 头里。
 *
 * 解析规则照 SSE 规范实现，其中两条容易漏：
 * - 以 `:` 开头的是**注释行**（我们用它们做心跳），必须忽略；
 * - 一个事件可能由**多个 `data:` 行**组成，要用换行拼接。
 */

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** 解析一个 SSE 帧（不含结尾的空行分隔符） */
export function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split('\n');
  let event = 'message';
  const dataLines: string[] = [];
  let id: string | null = null;
  let hasField = false;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    // 注释行：心跳用，直接忽略
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    // 规范规定字段值前面最多去掉一个空格
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        event = value;
        hasField = true;
        break;
      case 'data':
        dataLines.push(value);
        hasField = true;
        break;
      case 'id':
        id = value;
        hasField = true;
        break;
      case 'retry':
        hasField = true;
        break;
      default:
        break;
    }
  }

  if (!hasField) return null;
  return { event, data: dataLines.join('\n'), id };
}

export interface ConsumeOptions {
  onEvent: (event: SseEvent) => void;
  signal: AbortSignal;
}

/** 持续读取响应流并派发事件，直到 abort 或服务端关闭 */
export async function consumeSse(response: Response, options: ConsumeOptions): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('SSE 响应没有可读流');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!options.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) options.onEvent(parsed);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
