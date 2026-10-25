/**
 * 卡片上的状态显示（M2：日历 / 我的待办 / 全局搜索）。
 *
 * **为什么需要它**：这三页都是**跨项目**的列表，一张卡片一条任务、每条属于不同项目，
 * 而"状态是每个项目自己定义的数据"（名字、颜色、可选项都不同）。
 * 用当前项目的状态表去查别的项目，界面就会显示错的名字或者"未知状态"。
 *
 * 所以口径是：**状态名与颜色优先用接口跟着数据一起带回来的字段**
 * （`statusName` / `statusColor`，见 services/task-query.ts），
 * 只有接口没带的时候才回退到状态表查 id。下拉可选项必须按 `projectId` 过滤。
 */

import { computed, ref } from 'vue';

import type { ProjectStatusDto } from '../api/endpoints';

/** 卡片渲染需要的状态相关字段（跨项目列表的行都带这几项） */
export interface CardStatusTask {
  statusId: string | null;
  projectId: string;
  statusName?: string | null | undefined;
  statusColor?: string | null | undefined;
}

export function useCardStatus() {
  const statuses = ref<ProjectStatusDto[]>([]);

  const statusById = computed(() => new Map(statuses.value.map((status) => [status.id, status])));

  /**
   * 并入一批状态定义。三次请求（整月 / 本周 / 逾期）各自只带自己那部分项目，
   * 所以是**并集**而不是覆盖 —— 覆盖会让先到的那些项目的卡片失去下拉项。
   */
  function mergeStatuses(list: ProjectStatusDto[]): void {
    const merged = new Map(statuses.value.map((status) => [status.id, status]));
    for (const status of list) merged.set(status.id, status);
    statuses.value = [...merged.values()];
  }

  /** 下拉里只放**这张卡片所属项目**的状态：状态是项目级数据，不能跨项目改 */
  function optionsFor(task: CardStatusTask): Array<{ label: string; key: string }> {
    return statuses.value
      .filter((status) => status.projectId === task.projectId)
      .map((status) => ({ label: status.name, key: status.id }));
  }

  function nameOf(task: CardStatusTask): string {
    if (!task.statusId) return '无状态';
    return task.statusName ?? statusById.value.get(task.statusId)?.name ?? '未知状态';
  }

  function colorOf(task: CardStatusTask): string {
    if (!task.statusId) return 'var(--pm-text-faint)';
    return task.statusColor ?? statusById.value.get(task.statusId)?.color ?? 'var(--pm-text-faint)';
  }

  /** 状态标签的底色：淡色底 + 状态自身的颜色，与工作台一致 */
  function styleOf(task: CardStatusTask): Record<string, string> {
    const color = colorOf(task);
    return { color, background: `color-mix(in srgb, ${color} 14%, transparent)` };
  }

  /** 按 id 取名字（改完状态时用来写提示语） */
  function nameById(statusId: string): string {
    return statusById.value.get(statusId)?.name ?? '未知状态';
  }

  return { statuses, mergeStatuses, optionsFor, nameOf, colorOf, styleOf, nameById };
}
