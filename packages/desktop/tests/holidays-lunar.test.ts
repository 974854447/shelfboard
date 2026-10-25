import { describe, expect, it } from 'vitest';

import {
  dayKeyOf,
  hasHolidayData,
  holidayMark,
  holidayYears,
  nextHoliday,
  parseDayKey,
} from '../src/renderer/src/data/holidays';
import { lunarDay } from '../src/renderer/src/utils/lunar';

/**
 * 农历 / 节气 / 法定节假日（M2 日历）。
 *
 * 这组数据的共同点是**单一来源、但很容易错一天**：
 * 农历错一天只有那天过生日的人看得出来；放假安排错一天，用户会对着一份
 * 官方通知怀疑软件。所以这里不测"实现细节"，只钉住几个**能和官方通知对上**的日期。
 *
 * 2026 年的日期全部对照《国务院办公厅关于2026年部分节假日安排的通知》：
 * 春节 2 月 15 日至 23 日、国庆节 10 月 1 日至 7 日、9 月 20 日与 10 月 10 日上班。
 */

// 用本地时间构造，避免测试自己引入时区假设
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('放假安排的日期解析', () => {
  it('YYYY-MM-DD 按本地时区解析，不会因为 UTC 挪一天', () => {
    const ts = parseDayKey('2026-10-01');
    const date = new Date(ts);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
    expect(date.getDate()).toBe(1);
    expect(date.getHours()).toBe(0);
    expect(dayKeyOf(ts)).toBe('2026-10-01');
  });
});

describe('法定节假日与调休', () => {
  it('国庆节第一天：是假期，并带上"第几天"', () => {
    const mark = holidayMark(at(2026, 10, 1));
    expect(mark).toMatchObject({ kind: 'holiday', name: '国庆节', index: 1, total: 7 });
  });

  it('国庆节最后一天仍在假期里', () => {
    expect(holidayMark(at(2026, 10, 7))).toMatchObject({ kind: 'holiday', index: 7, total: 7 });
  });

  it('国庆节后一天不是假期', () => {
    expect(holidayMark(at(2026, 10, 8))).toBeNull();
  });

  it('调休上班的周末被标成 workday（不是假期）', () => {
    // 2026-10-10 是周六，但那天要上班
    expect(holidayMark(at(2026, 10, 10))).toMatchObject({ kind: 'workday' });
    expect(holidayMark(at(2026, 9, 20))).toMatchObject({ kind: 'workday' });
  });

  it('春节是 9 天（2026-02-15 ~ 02-23）', () => {
    expect(holidayMark(at(2026, 2, 15))).toMatchObject({ kind: 'holiday', name: '春节', index: 1, total: 9 });
    expect(holidayMark(at(2026, 2, 23))).toMatchObject({ kind: 'holiday', index: 9, total: 9 });
  });

  it('内置数据只声明了已有通知的年份', () => {
    expect(hasHolidayData(2026)).toBe(true);
    expect(hasHolidayData(2024)).toBe(false);
    expect(holidayYears()).toContain(2026);
  });
});

describe('下一个假期', () => {
  it('假期还没开始时数"还有几天"', () => {
    const item = nextHoliday(at(2026, 9, 28));
    expect(item).toMatchObject({ name: '国庆节', daysUntil: 3, totalDays: 7 });
  });

  it('正在放假时说的是"当前这段假期"，而不是下一个', () => {
    // 2026-09-26 是中秋节假期的第 2 天（9/25 ~ 9/27）
    const item = nextHoliday(at(2026, 9, 26));
    expect(item).toMatchObject({ name: '中秋节', daysUntil: -1, daysLeft: 2, totalDays: 3 });
  });

  it('假期第一天：daysUntil 为 0，daysLeft 等于总天数', () => {
    const item = nextHoliday(at(2026, 10, 1));
    expect(item).toMatchObject({ name: '国庆节', daysUntil: 0, daysLeft: 7 });
  });

  it('数据表里没有的年份不编造，返回 null', () => {
    expect(nextHoliday(at(2027, 3, 1))).toBeNull();
  });
});

describe('农历与二十四节气', () => {
  it('2026-02-17 是正月初一（春节）', () => {
    const day = lunarDay(at(2026, 2, 17));
    expect(day.lunarMonth).toBe('正月');
    expect(day.lunarDay).toBe('初一');
    expect(day.label).toBe('春节');
    expect(day.festival).toBe(true);
  });

  it('2026-09-25 是八月十五（中秋节）', () => {
    const day = lunarDay(at(2026, 9, 25));
    expect(day.lunarMonth).toBe('八月');
    expect(day.lunarDay).toBe('十五');
    expect(day.label).toBe('中秋节');
  });

  it('节气当天给出节气名（2026-09-23 秋分）', () => {
    const day = lunarDay(at(2026, 9, 23));
    expect(day.jieQi).toBe('秋分');
    expect(day.label).toBe('秋分');
  });

  it('普通日子显示农历日，初一显示月名', () => {
    expect(lunarDay(at(2026, 9, 26)).label).toBe('十六');
    // 2026-09-11 是农历八月初一
    expect(lunarDay(at(2026, 9, 11)).label).toBe('八月');
  });

  it('闰月会写明"闰"字', () => {
    // 2025 年闰六月
    const day = lunarDay(at(2025, 7, 26));
    expect(day.lunarMonth.startsWith('闰')).toBe(true);
  });

  it('只用农历节日，不显示"主题日"（那类日子不放假、也不影响安排）', () => {
    // 2026-09-19 的"全民国防教育日"、09-10 的"教师节"都属于公历主题日：
    // 它们占掉格子上唯一那行位置，却没有任何安排含义
    expect(lunarDay(at(2026, 9, 19)).label).toBe('初九');
    expect(lunarDay(at(2026, 9, 10)).label).toBe('廿九');
  });

  it('法定节假日优先于节气与农历日（2026-10-01 是国庆节，不是廿一）', () => {
    // 这张表的优先级由 CalendarView 决定：先查放假安排，再退回农历那一层
    expect(holidayMark(at(2026, 10, 1))).toMatchObject({ kind: 'holiday', name: '国庆节' });
    expect(lunarDay(at(2026, 10, 1)).label).toBe('廿一');
  });
});
