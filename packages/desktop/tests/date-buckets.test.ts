import { describe, expect, it } from 'vitest';

import {
  addDays,
  buildMonthGrid,
  describeDue,
  dueBucket,
  endOfLocalDay,
  formatClock,
  formatDateKey,
  formatFullDate,
  formatHms,
  isSameLocalDay,
  shiftMonth,
  startOfLocalDay,
  startOfLocalWeek,
} from '../src/renderer/src/utils/date';

/**
 * 「日历天」的口径测试（M2：日历 / 我的待办）。
 *
 * 这组函数决定"什么算今天、什么算逾期"，而它用的是**本地时区** ——
 * 时区口径错一天，界面上不会报错，只会把任务放到错误的格子里，
 * 是最难靠肉眼发现的一类 bug。所以边界（当日 00:00:00.000 / 23:59:59.999、
 * 周一为周首、跨月）都写成测试。
 */

// 用本地时间构造，避免测试自己引入时区假设
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('本地日历天', () => {
  it('startOfLocalDay / endOfLocalDay 取的是当天的首尾', () => {
    const noon = at(2026, 9, 25, 12, 30);
    expect(new Date(startOfLocalDay(noon)).getHours()).toBe(0);
    expect(new Date(startOfLocalDay(noon)).getDate()).toBe(25);
    expect(new Date(endOfLocalDay(noon)).getHours()).toBe(23);
    expect(endOfLocalDay(noon)).toBeGreaterThan(startOfLocalDay(noon));
  });

  it('同一天的不同时刻算同一天', () => {
    expect(isSameLocalDay(at(2026, 9, 25, 0, 0), at(2026, 9, 25, 23, 59))).toBe(true);
    expect(isSameLocalDay(at(2026, 9, 25, 23, 59), at(2026, 9, 26, 0, 0))).toBe(false);
  });

  it('一周从**周一**开始（国内习惯）', () => {
    // 2026-09-25 是周五 → 本周一 = 09-21
    const weekStart = new Date(startOfLocalWeek(at(2026, 9, 25, 15)));
    expect(weekStart.getDate()).toBe(21);
    expect(weekStart.getDay()).toBe(1);
    // 周日也要落到同一周的周一（而不是下一天）
    const sunday = new Date(startOfLocalWeek(at(2026, 9, 27, 15)));
    expect(sunday.getDate()).toBe(21);
  });

  it('addDays 跨月正确', () => {
    expect(new Date(addDays(at(2026, 8, 31), 1)).getDate()).toBe(1);
    expect(new Date(addDays(at(2026, 1, 1), -1)).getDate()).toBe(31);
  });
});

describe('dueBucket', () => {
  const now = at(2026, 9, 25, 10);

  it('今天之前 = 逾期，今天之内 = 今天', () => {
    expect(dueBucket(at(2026, 9, 24, 23, 59), now)).toBe('overdue');
    expect(dueBucket(at(2026, 9, 25, 0, 0), now)).toBe('today');
    expect(dueBucket(at(2026, 9, 25, 23, 59), now)).toBe('today');
  });

  it('本周内（周一~周日）= week，更远 = later', () => {
    expect(dueBucket(at(2026, 9, 26, 9), now)).toBe('week'); // 周六
    expect(dueBucket(at(2026, 9, 27, 9), now)).toBe('week'); // 周日（本周最后一天）
    expect(dueBucket(at(2026, 9, 28, 9), now)).toBe('later'); // 下周一
  });

  it('没有截止日 = none', () => {
    expect(dueBucket(null, now)).toBe('none');
  });

  it('跨零点：同一时刻的"今天"取决于传入的 now，而不是系统时钟', () => {
    const dueAtMidnight = at(2026, 9, 26, 0, 0);
    // 25 号（周五）看它：26 号是**本周的周六**，所以是 week 而不是 later
    expect(dueBucket(dueAtMidnight, at(2026, 9, 25, 23, 59))).toBe('week');
    // 过了零点再看：它就是今天
    expect(dueBucket(dueAtMidnight, at(2026, 9, 26, 0, 1))).toBe('today');
    // 26 号之后再看：变成逾期（已经过去了）
    expect(dueBucket(dueAtMidnight, at(2026, 9, 27, 8))).toBe('overdue');
  });
});

describe('describeDue', () => {
  const now = at(2026, 9, 25, 10);

  it('给出相对说法', () => {
    expect(describeDue(at(2026, 9, 25, 18), now)).toBe('今天');
    expect(describeDue(at(2026, 9, 26, 9), now)).toBe('明天');
    expect(describeDue(at(2026, 9, 24, 9), now)).toBe('昨天');
    expect(describeDue(at(2026, 9, 22, 9), now)).toBe('逾期 3 天');
    expect(describeDue(at(2026, 9, 28, 9), now)).toBe('3 天后');
  });

  it('超过一周就给具体日期', () => {
    expect(describeDue(at(2026, 10, 20, 9), now)).toContain('月');
  });
});

describe('月份网格', () => {
  it('固定 6 行 × 7 列（翻月时高度不跳）', () => {
    const grid = buildMonthGrid(at(2026, 9, 15));
    expect(grid).toHaveLength(42);
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(30); // 2026 年 9 月 30 天
  });

  it('第一格是包含 1 号那一周的周一，且补位标记为上月', () => {
    const grid = buildMonthGrid(at(2026, 9, 15));
    expect(new Date(grid[0]!.ts).getDay()).toBe(1);
    // 2026-09-01 是周二 → 前面补 1 天（8 月 31 日）
    expect(grid[0]!.inMonth).toBe(false);
    expect(new Date(grid[1]!.ts).getDate()).toBe(1);
    expect(grid[1]!.inMonth).toBe(true);
  });

  it('2 月与闰年都能放下', () => {
    expect(buildMonthGrid(at(2028, 2, 10)).filter((c) => c.inMonth)).toHaveLength(29);
    expect(buildMonthGrid(at(2026, 2, 10)).filter((c) => c.inMonth)).toHaveLength(28);
  });

  it('shiftMonth 跨年正确', () => {
    expect(new Date(shiftMonth(at(2026, 12, 15), 1)).getMonth()).toBe(0); // 1 月
    expect(new Date(shiftMonth(at(2026, 1, 15), -1)).getMonth()).toBe(11); // 12 月
  });
});

/**
 * 打卡计时器与工作日志用到的格式化（0.2.x）。
 *
 * 这几条的口径要和服务端 `services/work-log.ts` 完全一致 —— 两处对不上时，
 * 界面上显示的工时与文档里写的工时就会不一样，而那种差异极难被发现。
 */
describe('时长与日期文案', () => {
  it('formatHms 定宽补零，小时不取模 24', () => {
    expect(formatHms(0)).toBe('00:00:00');
    expect(formatHms(999)).toBe('00:00:00');
    expect(formatHms(1000)).toBe('00:00:01');
    expect(formatHms(61_000)).toBe('00:01:01');
    expect(formatHms(3 * 3600_000 + 25 * 60_000 + 10_000)).toBe('03:25:10');
    // 连着开一整天时显示 25 小时，而不是"1 小时"（后者看起来像计时器重置了）
    expect(formatHms(25 * 3600_000)).toBe('25:00:00');
    // 时钟回拨等异常给负数时，宁可显示 0 也不要 "-1:-5:00"
    expect(formatHms(-1)).toBe('00:00:00');
  });

  it('formatDateKey 是本地时区的 YYYY-MM-DD（决定"今天"是哪天）', () => {
    expect(formatDateKey(at(2026, 9, 30, 0, 0))).toBe('2026-09-30');
    expect(formatDateKey(at(2026, 9, 30, 23, 59))).toBe('2026-09-30');
    // 与日历天口径一致：跨过本地零点就是新的一天
    expect(formatDateKey(at(2026, 10, 1, 0, 0))).toBe('2026-10-01');
  });

  it('formatFullDate 带中文星期', () => {
    // 2026-09-30 是星期三
    expect(formatFullDate(at(2026, 9, 30, 10, 0))).toBe('2026年9月30日 星期三');
    expect(formatFullDate(at(2026, 9, 27, 10, 0))).toBe('2026年9月27日 星期日');
  });

  it('formatClock 是本地 HH:MM', () => {
    expect(formatClock(at(2026, 9, 30, 9, 5))).toBe('09:05');
    expect(formatClock(at(2026, 9, 30, 23, 59))).toBe('23:59');
  });
});
