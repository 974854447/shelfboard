/**
 * 排序列的计算。
 *
 * 策略：`sort_order` 用间隔 1000 的整数，插入到两条之间时取**中点**。
 * 这样绝大多数拖拽只更新一行；只有当间隙耗尽（相邻两数差 ≤ 1）时，
 * 才由调用方重排整列。对比"每次拖拽都重写整列"，这是数量级的差别，
 * 而且重排整列在并发下更容易出现顺序错乱。
 */

import { SORT_GAP } from '@pm-studio/shared';

/** 追加到末尾时的下一个序号 */
export function nextSortOrder(existingMax: number | null | undefined): number {
  return (existingMax ?? 0) + SORT_GAP;
}

/**
 * 计算"插到 prev 与 next 之间"的序号。
 *
 * 返回 `null` 表示**间隙不足，调用方必须重排整列** ——
 * 刻意不在这里自动重排：重排是写操作，应该由掌握整列信息的服务层
 * 在一个事务里完成，而不是藏在一个纯函数里偷偷改数据。
 */
export function orderBetween(
  prev: number | undefined,
  next: number | undefined,
): number | null {
  if (prev === undefined && next === undefined) return SORT_GAP;
  // 插到最前
  if (prev === undefined) return (next as number) - 1;
  // 插到最后
  if (next === undefined) return prev + SORT_GAP;

  const gap = next - prev;
  if (gap <= 1) return null;
  return prev + Math.floor(gap / 2);
}

/** 整列重排后的序号序列（间隔 SORT_GAP，从 1000 起） */
export function rebalancedOrders(count: number, start = SORT_GAP): number[] {
  return Array.from({ length: count }, (_, index) => start + index * SORT_GAP);
}
