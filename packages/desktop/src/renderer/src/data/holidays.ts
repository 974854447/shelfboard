/**
 * 法定节假日（含调休上班日）—— **手工维护的数据表**。
 *
 * 为什么是一张写死的表，而不是算出来的：
 * 放假安排是**国务院每年发通知**定的（"今年春节从哪天放到哪天、哪个周末要补班"），
 * 它既不等于"周末必休"，也不等于"传统节日当天休"，没有任何算式能从日期推出来。
 * 想让它自动正确，唯一办法是每年通知发布后更新这个文件。
 *
 * 维护方式（每年一次，10 分钟）：
 * 1. 打开中国政府网的《国务院办公厅关于XXXX年部分节假日安排的通知》；
 * 2. 在 `HOLIDAYS` 里加一条 `{ year, source, holidays, workdays }`；
 * 3. `holidays` 写**放假的日期区间**（含调休连休），`workdays` 写**要补班的周末**；
 * 4. 日期一律写 `'YYYY-MM-DD'` 字符串 —— 用本地时区解析（见 `parseDayKey`），
 *    不会因为 UTC 差 8 小时把日期挪一天。
 *
 * 没写进来的年份**不会假装有数据**：日历上不标节假日，面板里直说
 * "这一年还没有内置的放假安排"。宁可空着，也不要标错日子。
 */

/** 一段连续放假日期 */
export interface HolidayRange {
  /** 假期的名字（春节 / 国庆节 …） */
  name: string;
  /** 首日（含），'YYYY-MM-DD' */
  from: string;
  /** 末日（含），'YYYY-MM-DD' */
  to: string;
}

export interface HolidayYear {
  year: number;
  /** 数据来源（出错了能自己回去核对） */
  source: string;
  holidays: HolidayRange[];
  /** 调休上班的日期（通常是周末） */
  workdays: string[];
}

export const HOLIDAYS: HolidayYear[] = [
  {
    year: 2026,
    source: '国务院办公厅关于2026年部分节假日安排的通知（2025-11-04）',
    holidays: [
      { name: '元旦', from: '2026-01-01', to: '2026-01-03' },
      { name: '春节', from: '2026-02-15', to: '2026-02-23' },
      { name: '清明节', from: '2026-04-04', to: '2026-04-06' },
      { name: '劳动节', from: '2026-05-01', to: '2026-05-05' },
      { name: '端午节', from: '2026-06-19', to: '2026-06-21' },
      { name: '中秋节', from: '2026-09-25', to: '2026-09-27' },
      { name: '国庆节', from: '2026-10-01', to: '2026-10-07' },
    ],
    workdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
];

/** 'YYYY-MM-DD' → 本地零点的毫秒时间戳（**不用 `Date.parse`**：那个按 UTC 解析） */
export function parseDayKey(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
}

/** 本地零点时间戳 → 'YYYY-MM-DD' */
export function dayKeyOf(ts: number): string {
  const date = new Date(ts);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export type HolidayMark =
  | { kind: 'holiday'; name: string; /** 这是假期的第几天（从 1 数） */ index: number; total: number }
  | { kind: 'workday'; name: string };

export interface UpcomingHoliday {
  name: string;
  from: number;
  to: number;
  /** 距离开始还有几天：> 0 还没开始；**= 0 今天开始**；**< 0 已经在假期里**（第 |n|+1 天） */
  daysUntil: number;
  /** 这段假期一共几天 */
  totalDays: number;
  /** 从今天算还能休几天（含今天）；假期已过完则为 0 */
  daysLeft: number;
}

/* ------------------------------------------------------------------ */
/* 查表：把所有年份摊平成 "日期 → 标记"，查的时候是 O(1)              */
/* ------------------------------------------------------------------ */

let cache: Map<string, HolidayMark> | null = null;

/** 一天加一日（用本地日历日加减，跨月跨年跨夏令时都不会错） */
function plusOneDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function buildIndex(): Map<string, HolidayMark> {
  const map = new Map<string, HolidayMark>();
  for (const year of HOLIDAYS) {
    for (const range of year.holidays) {
      const start = parseDayKey(range.from);
      const end = parseDayKey(range.to);
      const total = Math.round((end - start) / 86_400_000) + 1;
      let index = 1;
      // 逐日铺开：一段假期最多十几天，直接循环最不容易错
      for (let ts = start; ts <= end; ts = plusOneDay(ts)) {
        map.set(dayKeyOf(ts), { kind: 'holiday', name: range.name, index, total });
        index += 1;
      }
    }
    for (const key of year.workdays) {
      map.set(key, { kind: 'workday', name: '调休上班' });
    }
  }
  return map;
}

/** 这一天的节假日标记；没有（普通工作日/普通周末）返回 null */
export function holidayMark(ts: number): HolidayMark | null {
  cache ??= buildIndex();
  return cache.get(dayKeyOf(ts)) ?? null;
}

/** 这一年有没有内置的放假安排（没有的话界面上要如实说明） */
export function hasHolidayData(year: number): boolean {
  return HOLIDAYS.some((item) => item.year === year);
}

/** 内置数据的年份（从早到晚），用于界面提示"哪几年有数据" */
export function holidayYears(): number[] {
  return HOLIDAYS.map((item) => item.year).sort((a, b) => a - b);
}

/**
 * 从某天起的**下一个假期**。
 *
 * **假期中间的那几天也算"当前这个假期"**：9 月 26 日问"下一个假期"，
 * 答案应该是"你正在过中秋节"（而不是"国庆节还有 5 天"这种把眼前这段假吞掉的回答）。
 * 调用方按 `daysUntil` 的正负决定措辞：
 * - `> 0` 还没开始（"还有 N 天"）；
 * - `= 0` 今天开始；
 * - `< 0` 假期中（第 |n|+1 天，还剩 `daysLeft` 天）。
 *
 * 数据表里没有的年份直接跳过，找不到（未来没有内置数据）返回 null。
 */
export function nextHoliday(fromTs: number): UpcomingHoliday | null {
  const ranges = HOLIDAYS.flatMap((year) => year.holidays)
    .map((range) => ({ ...range, from: parseDayKey(range.from), to: parseDayKey(range.to) }))
    .sort((a, b) => a.from - b.from);

  for (const range of ranges) {
    if (range.to < fromTs) continue;
    const totalDays = Math.round((range.to - range.from) / 86_400_000) + 1;
    return {
      name: range.name,
      from: range.from,
      to: range.to,
      daysUntil: Math.round((range.from - fromTs) / 86_400_000),
      totalDays,
      daysLeft: Math.round((range.to - fromTs) / 86_400_000) + 1,
    };
  }
  return null;
}
