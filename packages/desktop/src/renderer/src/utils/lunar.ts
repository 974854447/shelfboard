/**
 * 农历、节气、传统节日（M2 日历）。
 *
 * **为什么不自己写那张"农历十六进制表"**：1900–2100 的农历数据是一张压缩过的
 * 201 项常量表，抄错一项就会在某个闰月前后整体错一天，而且错得很难发现
 * （只有那一天的人会对不上）。这里用 `lunar-typescript`（6tail，MIT，无第三方依赖），
 * 它同时给农历、二十四节气、传统节日与干支，且和官方放假通知对得上：
 * 2026-02-17 = 正月初一（春节）、2026-09-25 = 八月十五（中秋）——
 * 与《国务院办公厅关于2026年部分节假日安排的通知》里的日期一致。
 *
 * 这一层只做三件事：**取出来、拼成界面上要显示的一行字、把优先级定死**。
 * 优先级：法定节假日（`data/holidays.ts`，调用方插在最前面） > 节气 > 农历传统节日 > 农历日期
 * （同一天可能既是节气又是节日，格子里只有一行位置，得有个明确的规矩）。
 */

import { Solar } from 'lunar-typescript';

export interface LunarDay {
  /** 格子里那一行字：节日名 / 节气 / 农历月日 */
  label: string;
  /** 是"节日"（法定节假日或传统节日）而不是普通农历日 —— 界面上会加重颜色 */
  festival: boolean;
  /** 二十四节气名（当天不是节气时为 null） */
  jieQi: string | null;
  /** 农历日的中文写法（初一、十六 …） */
  lunarDay: string;
  /** 农历月的中文写法（正月、闰六月 …） */
  lunarMonth: string;
  /** 干支纪年（丙午 …） */
  ganZhiYear: string;
  /** 生肖 */
  zodiac: string;
}

/** 农历日名：初二、廿三 …（库直接给，不用自己数） */
function lunarOf(ts: number): LunarDay {
  const date = new Date(ts);
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();

  const jieQi = lunar.getJieQi() || null;
  const lunarFestivals = lunar.getFestivals();

  const month = lunar.getMonth(); // 负数表示闰月
  const lunarMonth = `${month < 0 ? '闰' : ''}${lunar.getMonthInChinese()}月`;
  const lunarDay = lunar.getDayInChinese();

  /*
   * 这里**只用农历节日**（春节、元宵、端午、中秋、重阳、腊八…），
   * 刻意**不用库里的公历节日表**：那张表里混着一堆"主题日"
   * （全国科普日、世界湿地日…），它们不放假、也不影响任何安排，
   * 却会把格子上唯一那一行位置占掉 —— 而放假的日子由 `data/holidays.ts`
   * 那份**对着国务院通知维护**的表负责，准确度更高。
   */
  const festivalName = lunarFestivals[0] ?? null;

  let label: string;
  let festival = false;
  if (festivalName) {
    label = festivalName;
    festival = true;
  } else if (jieQi) {
    label = jieQi;
    festival = true;
  } else if (lunar.getDay() === 1) {
    // 初一只显示月名，否则格子里会出现"八月初一"这种占满一行的四字
    label = lunarMonth;
  } else {
    label = lunarDay;
  }

  return {
    label,
    festival,
    jieQi,
    lunarDay,
    lunarMonth,
    ganZhiYear: lunar.getYearInGanZhi(),
    zodiac: lunar.getYearShengXiao(),
  };
}

/** 带缓存的查询：一屏 42 个格子，翻月时会重复算同一天 */
const cache = new Map<number, LunarDay>();

export function lunarDay(ts: number): LunarDay {
  const key = new Date(ts).setHours(0, 0, 0, 0);
  const hit = cache.get(key);
  if (hit) return hit;
  const value = lunarOf(key);
  cache.set(key, value);
  return value;
}

/** 完整的中文日期写法，用于面板标题：2026年9月26日 星期六 · 八月十六 */
export function describeLunarDay(ts: number): string {
  const info = lunarDay(ts);
  return `${info.lunarMonth}${info.lunarDay}`;
}
