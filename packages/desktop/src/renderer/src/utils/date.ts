/**
 * 日期与"日历天"工具（M2：日历 / 我的待办）。
 *
 * **一处口径**：所有"今天 / 本周 / 逾期"的判定都走这里，用的是**本地时区**的日历天。
 * 数据库里存的是 UTC 毫秒时间戳，而"今天到期"是本地概念 —— 两者之间的换算
 * 只在这个文件里做一次，避免各处自己 `new Date()` 拼出不一致的边界。
 *
 * 为什么服务端不参与：服务端没有用户时区信息，让它猜就是制造时区 bug。
 * 前端算好边界（`startOfLocalDay` / `endOfLocalDay`）传给接口，服务端只判断
 * "时间戳落没落在区间里"（见 services/task-query.ts）。
 */

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

/** 本周的第一天（**周一**，符合国内习惯），零点 */
export function startOfLocalWeek(ts: number): number {
  const d = new Date(startOfLocalDay(ts));
  const weekday = d.getDay(); // 0 = 周日
  const offset = weekday === 0 ? 6 : weekday - 1;
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

/**
 * 把任务归到哪一组。
 *
 * 规则：已完成的**不进逾期/今天**（做完了就不该再催）；没有截止日的单独一组。
 * `now` 显式传入而不是内部取当前时间 —— 这样它是个纯函数，可以直接单测，
 * 也不会出现"同一次渲染里跨了零点导致两条数据落在不同组"的怪现象。
 */
export function dueBucket(dueDate: number | null, now: number): DueBucket {
  if (dueDate === null) return 'none';
  const today = startOfLocalDay(now);
  if (dueDate < today) return 'overdue';
  if (dueDate <= endOfLocalDay(now)) return 'today';
  const weekEnd = addDays(startOfLocalWeek(now), 7) - 1;
  if (dueDate <= weekEnd) return 'week';
  return 'later';
}

export function formatDayDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDayShort(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatMonthTitle(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

/**
 * 毫秒 → `HH:MM:SS`（打卡计时器的显示格式）。
 *
 * 小时**不取模 24**：连着开一整天（或跨夜没关）时显示 `25:00:00` 而不是 `01:00:00` ——
 * 后者会让人以为计时器重置了。这一点与 `docs` 里工作日志的口径一致。
 */
export function formatHms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/** 时间戳 → 本地 `YYYY-MM-DD`（今天的日期键；与服务端的日期键同一口径） */
export function formatDateKey(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 时间戳 → `2026年9月29日 星期二` */
export function formatFullDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_NAMES[d.getDay()] ?? ''}`;
}

/** 时间戳 → 本地 `HH:MM` */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 相对日期的说法（今天 / 明天 / 昨天 / 3 天后 / 逾期 2 天）。
 * 用相对说法而不是绝对日期：这些列表的主要用途是"我现在该干什么"。
 */
export function describeDue(dueDate: number, now: number): string {
  const days = Math.round((startOfLocalDay(dueDate) - startOfLocalDay(now)) / DAY_MS);
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === -1) return '昨天';
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days <= 7) return `${days} 天后`;
  return formatDayDate(dueDate);
}

/** 一周 7 列的网格，含上下月补位；固定 6 行（42 格），月份切换时高度不跳 */
export function buildMonthGrid(monthAnchor: number): Array<{ ts: number; inMonth: boolean }> {
  const first = new Date(monthAnchor);
  first.setDate(1);
  first.setHours(0, 0, 0, 0);

  const month = first.getMonth();
  const start = startOfLocalWeek(first.getTime());
  const cells: Array<{ ts: number; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i += 1) {
    const ts = addDays(start, i);
    cells.push({ ts, inMonth: new Date(ts).getMonth() === month });
  }
  return cells;
}

/** 月份翻页：`delta` 为 ±1 */
export function shiftMonth(monthAnchor: number, delta: number): number {
  const d = new Date(monthAnchor);
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  return d.getTime();
}
