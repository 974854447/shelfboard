<script setup lang="ts">
/**
 * 总览页：项目统计 + 今日工作内容 + 右侧若干小面板。
 *
 * ## 这一页要回答什么
 *
 * 「这个项目现在什么情况」。所以上半部分是四个数字，
 * 主体是**今日工作内容** —— 数字回答"多少"，列表回答"今天动了什么"。
 *
 * ## 为什么主体从关系数据图换成了今日工作内容
 *
 * 用户 2026-10-02 的明确要求：关系数据图看着热闹，但"今天该干什么、干了什么"
 * 才是每天打开这一页真正要看的东西。原先那张六边形图因此整块移除。
 *
 * 取数直接复用工作日志的那一套（`/work-log/preview`），
 * 于是这一页看到的内容与当天导出的日志文档**逐条同源**，不会出现两处口径打架。
 *
 * ## 数据从哪来
 *
 * 统计与右侧各面板全部由 `board.taskList`（项目任务的扁平列表）自己构树推导，
 * **没有一个写死的数字**。依赖边要多一次请求，原因见 `loadDependencies`。
 */

import { NButton, NSpin } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';

import type { StatusCategory } from '@pm-studio/shared';
import type {
  DependencyDto,
  MilestoneDto,
  ProjectRelationDto,
  TaskDto,
  WorkLogData,
  WorkflowStatusDto,
} from '@pm-studio/server';

import {
  milestones as milestonesApi,
  projectRelations as projectRelationsApi,
  projects as projectsApi,
  tasks as tasksApi,
  workLog as workLogApi,
} from '../api/endpoints';
import EmptyState from '../components/EmptyState.vue';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';

const board = useBoardStore();
const feedback = useFeedback();

/* ================================================================== */
/* 1) 建模：扁平任务列表 → 这一页需要的树                                */
/* ================================================================== */

/**
 * 归一化节点。
 *
 * 不直接在模板里读 `TaskDto` 是有原因的：DTO 上有一堆这一页用不到的可空字段，
 * 而这里要的是**已经算好的**东西（层级、子树规模、是否完成），
 * 否则模板里会散落一堆 `t.statusCategory === 'done'` 这类判空与推导。
 */
interface OvNode {
  id: string;
  title: string;
  parentId: string | null;
  /** 0 = 主任务，1 = 子任务，≥2 = 孙任务 */
  depth: number;
  statusId: string | null;
  category: StatusCategory | null;
  /** 是否已完成：以工作流分类为准（`completedAt` 只作为分类缺失时的兜底信号） */
  done: boolean;
  /** 未完成的前置任务数；> 0 表示被阻塞 */
  blockedByCount: number;
  tagIds: string[];
  childIds: string[];
  /** 最顶层祖先（主任务）的 id；自己就是主任务时等于自己 */
  rootId: string;
}

interface OvTree {
  byId: Map<string, OvNode>;
  /** 状态为空或指向已不存在的状态的任务数（数据异常兜底，要如实显示） */
  unassigned: number;
}

function buildTree(items: TaskDto[]): OvTree {
  const raw = new Map<string, TaskDto>();
  for (const t of items) raw.set(t.id, t);

  // 父指针：父任务不在当前列表里（被筛掉/被删）时按顶层处理 ——
  // 否则这些子任务会变成"谁的子节点都不是"的幽灵，从统计里整批消失
  const parentOf = (id: string): string | null => {
    const t = raw.get(id);
    if (!t || !t.parentId) return null;
    return raw.has(t.parentId) ? t.parentId : null;
  };

  /*
   * 环兜底。
   *
   * 服务端不该产生 parent_id 成环的数据，但一旦出现，构树会死循环、
   * 子树规模也会算成无穷大。这里显式判掉并把成环节点按顶层处理：
   * 图形最多难看一点，不会把整页拖死。
   */
  const isCyclic = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let cur = parentOf(id);
    while (cur) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parentOf(cur);
    }
    return false;
  };

  const parent = new Map<string, string | null>();
  for (const t of items) {
    const cyclic = isCyclic(t.id);
    parent.set(t.id, cyclic ? null : parentOf(t.id));
  }

  const childIdsOf = new Map<string, string[]>();
  for (const t of items) {
    const p = parent.get(t.id) ?? null;
    if (!p) continue;
    let arr = childIdsOf.get(p);
    if (!arr) {
      arr = [];
      childIdsOf.set(p, arr);
    }
    arr.push(t.id);
  }

  const doneOf = (t: TaskDto): boolean =>
    t.statusCategory === 'done' || (t.statusCategory === null && t.completedAt !== null);

  // 层级用 BFS：顺便得到"父在子之前"的顺序，后面算子树规模要倒着用
  const depth = new Map<string, number>();
  const order: string[] = [];
  for (const t of items) {
    if (parent.get(t.id) ?? null) continue;
    depth.set(t.id, 0);
    order.push(t.id);
  }
  for (let i = 0; i < order.length; i += 1) {
    const id = order[i];
    if (id === undefined) continue;
    const d = depth.get(id) ?? 0;
    for (const k of childIdsOf.get(id) ?? []) {
      depth.set(k, d + 1);
      order.push(k);
    }
  }

  const rootIdOf = (id: string): string => {
    let cur = id;
    for (let step = 0; step < 64; step += 1) {
      const p = parent.get(cur) ?? null;
      if (!p) return cur;
      cur = p;
    }
    return cur;
  };

  let unassigned = 0;
  const byId = new Map<string, OvNode>();
  for (const t of items) {
    const known = t.statusId !== null && board.statuses.some((s) => s.id === t.statusId);
    if (!known) unassigned += 1;
    byId.set(t.id, {
      id: t.id,
      title: t.title,
      parentId: parent.get(t.id) ?? null,
      depth: depth.get(t.id) ?? 0,
      statusId: t.statusId,
      category: t.statusCategory,
      done: doneOf(t),
      blockedByCount: t.blockedByCount,
      tagIds: t.tagIds,
      childIds: childIdsOf.get(t.id) ?? [],
      rootId: rootIdOf(t.id),
    });
  }

  return { byId, unassigned };
}

const tree = computed<OvTree>(() => {
  const projectId = board.currentProjectId;
  /*
   * 按 projectId 再筛一道。
   *
   * store 的 `selectProject` 会清空 `board` / `statuses` / `tags`，但**不清 `taskList`** ——
   * 新项目的数据到手之前，那份列表还是上一个项目的。不筛的话，切换项目的瞬间
   * 这一页会拿着旧任务画图（而且状态全成了"未分配"，因为新状态表里没有旧 id）。
   */
  const items = projectId
    ? board.taskList.filter((t) => t.projectId === projectId)
    : [];
  return buildTree(items);
});

const statusById = computed(() => {
  const map = new Map<string, WorkflowStatusDto>();
  for (const s of board.statuses) map.set(s.id, s);
  return map;
});

/* ================================================================== */
/* 2) 统计                                                             */
/* ================================================================== */

const stats = computed(() => {
  let main = 0;
  let mainDone = 0;
  let sub = 0;
  let subDone = 0;
  let grand = 0;
  let grandDone = 0;
  let done = 0;
  for (const n of tree.value.byId.values()) {
    if (n.done) done += 1;
    if (n.depth === 0) {
      main += 1;
      if (n.done) mainDone += 1;
    } else if (n.depth === 1) {
      sub += 1;
      if (n.done) subDone += 1;
    } else {
      grand += 1;
      if (n.done) grandDone += 1;
    }
  }
  const total = tree.value.byId.size;
  const junior = sub + grand;
  const juniorDone = subDone + grandDone;
  return {
    total,
    main,
    mainDone,
    sub,
    subDone,
    grand,
    grandDone,
    junior,
    juniorDone,
    done,
    pct: total ? Math.round((done / total) * 100) : 0,
  };
});

const pctOf = (a: number, b: number): number => (b ? Math.round((a / b) * 100) : 0);

interface StatCard {
  label: string;
  value: number;
  unit: string;
  hint: string;
  pct: number;
  tone: 'accent' | 'ok';
}

const statCards = computed<StatCard[]>(() => {
  const s = stats.value;
  return [
    {
      label: '总任务',
      value: s.total,
      unit: '',
      hint: `主任务 ${s.main} · 子任务 ${s.sub} · 孙任务 ${s.grand}`,
      pct: 100,
      tone: 'ok',
    },
    {
      label: '主任务',
      value: s.main,
      unit: '',
      hint: `已完成 ${s.mainDone}`,
      pct: pctOf(s.mainDone, s.main),
      tone: 'accent',
    },
    {
      label: '子任务',
      value: s.junior,
      unit: '',
      hint: `已完成 ${s.juniorDone}`,
      pct: pctOf(s.juniorDone, s.junior),
      tone: 'accent',
    },
    {
      label: '完成占比',
      value: s.pct,
      unit: '%',
      hint: `${s.done} / ${s.total} 个任务`,
      pct: s.pct,
      tone: 'ok',
    },
  ];
});

/** 状态分布：按工作流顺序列出**项目真实的**状态，不用硬编码的"待办/进行中" */
const statusBreakdown = computed(() => {
  const counts = new Map<string, number>();
  for (const n of tree.value.byId.values()) {
    const key = n.statusId && statusById.value.has(n.statusId) ? n.statusId : '__none__';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...board.statuses]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({ id: s.id, name: s.name, color: s.color, count: counts.get(s.id) ?? 0 }))
    .filter((r) => r.count > 0);
  if (tree.value.unassigned > 0) {
    rows.push({
      id: '__none__',
      name: '未分配状态',
      color: 'var(--pm-text-faint)',
      count: tree.value.unassigned,
    });
  }
  return rows;
});

/* ================================================================== */
/* 3) 依赖边                                                           */
/* ================================================================== */

const deps = ref<DependencyDto[]>([]);
/** 依赖拿到没有：拿不到时只显示数量，并在右侧如实说明，而不是假装没有依赖 */
const depsReady = ref(false);

/**
 * 拉取项目的全部依赖边。
 *
 * 走 `endpoints.ts` 里的 `tasks.projectDependencies`（项目级批量接口）而不是
 * 逐个任务调 `dependencies(id)`：后者是 N+1，几百个任务的项目首屏就要几百次往返。
 */
async function loadDependencies(projectId: string): Promise<void> {
  try {
    deps.value = await tasksApi.projectDependencies(projectId);
    depsReady.value = true;
  } catch (error) {
    deps.value = [];
    depsReady.value = false;
    feedback.failure(error, '加载任务依赖关系失败');
  }
}

/** 任务 → 它的前置任务 id（只保留仍然存在的任务，删掉的任务不计入） */
const predecessorIdsOf = computed(() => {
  const map = new Map<string, string[]>();
  for (const d of deps.value) {
    if (!tree.value.byId.has(d.predecessorId) || !tree.value.byId.has(d.successorId)) continue;
    const arr = map.get(d.successorId);
    if (arr) arr.push(d.predecessorId);
    else map.set(d.successorId, [d.predecessorId]);
  }
  return map;
});

/* ================================================================== */
/* 4) 里程碑                                                           */
/* ================================================================== */

const milestones = ref<MilestoneDto[]>([]);
const loadingMeta = ref(false);
const milestoneRows = computed(() =>
  [...milestones.value]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => ({
      id: m.id,
      name: m.name,
      reached: m.reachedAt !== null,
      due: m.dueDate ? formatDate(m.dueDate) : '',
    })),
);

const reachedCount = computed(() => milestones.value.filter((m) => m.reachedAt !== null).length);

/* ------------------------------------------------------------------ */
/* 里程碑的就地增删改                                                  */
/* ------------------------------------------------------------------ */

/**
 * 为什么这些操作非做不可（而不是"以后再说"）：
 *
 * 新建项目时管理侧模板会**自动铺**里程碑（技术设计 §46），于是这个面板不再是空的了 ——
 * 用户马上会想改名字、标记达成、或者删掉一个不合适的。在此之前里程碑只有接口，
 * 界面上只能看 —— 那是典型的"功能只有 API 能碰"，正是这一版要避免的东西。
 */
const newMilestoneName = ref('');
const milestoneBusy = ref<string | null>(null);

async function reloadMilestones(): Promise<void> {
  const projectId = board.currentProjectId;
  if (!projectId) return;
  try {
    milestones.value = await milestonesApi.list(projectId);
  } catch (error) {
    feedback.failure(error, '加载里程碑失败');
  }
}

async function toggleMilestoneReached(row: { id: string; reached: boolean }): Promise<void> {
  milestoneBusy.value = row.id;
  try {
    await milestonesApi.reach(row.id, row.reached ? null : Date.now());
    await reloadMilestones();
  } catch (error) {
    feedback.failure(error, row.reached ? '取消达成失败' : '标记达成失败');
  } finally {
    milestoneBusy.value = null;
  }
}

async function removeMilestone(row: { id: string; name: string }): Promise<void> {
  milestoneBusy.value = row.id;
  try {
    await milestonesApi.remove(row.id);
    feedback.info(`已删除里程碑「${row.name}」`);
    await reloadMilestones();
  } catch (error) {
    feedback.failure(error, '删除里程碑失败');
  } finally {
    milestoneBusy.value = null;
  }
}

async function addMilestone(): Promise<void> {
  const projectId = board.currentProjectId;
  const name = newMilestoneName.value.trim();
  if (!projectId || name.length === 0) return;
  try {
    await milestonesApi.create(projectId, { name });
    newMilestoneName.value = '';
    await reloadMilestones();
  } catch (error) {
    feedback.failure(error, '新增里程碑失败');
  }
}

/* ------------------------------------------------------------------ */
/* 关系链（需求 §5.2.1）：只标一条关系、只做展示                        */
/* ------------------------------------------------------------------ */

const relations = ref<ProjectRelationDto[]>([]);
const newRelationTo = ref('');
const newRelationLabel = ref('');

/**
 * 能作为关系端点的项目：别的项目（不含自己、不含已归档的）。
 *
 * 已归档的项目不给选：关系是"当前在协作的东西"，归档项目出现在下拉里
 * 只会让人误选。已经有关系的归档项目**照样显示**（历史关系不该被藏起来）。
 */
const relationCandidates = computed(() =>
  board.projects.filter(
    (item) => item.id !== board.currentProjectId && item.status !== 'archived',
  ),
);

async function reloadRelations(): Promise<void> {
  const projectId = board.currentProjectId;
  if (!projectId) return;
  try {
    relations.value = await projectsApi.relations(projectId);
  } catch (error) {
    feedback.failure(error, '加载关系链失败');
  }
}

async function addRelation(): Promise<void> {
  const projectId = board.currentProjectId;
  const label = newRelationLabel.value.trim();
  if (!projectId || newRelationTo.value === '' || label.length === 0) return;
  try {
    await projectsApi.createRelation(projectId, { toProjectId: newRelationTo.value, label });
    newRelationTo.value = '';
    newRelationLabel.value = '';
    await reloadRelations();
  } catch (error) {
    // 服务端会挡住"重复的关系"与"连到自己"，这里原样转达
    feedback.failure(error, '建立关系失败');
  }
}

async function removeRelation(row: { id: string; label: string }): Promise<void> {
  try {
    await projectRelationsApi.remove(row.id);
    feedback.info(`已删除关系「${row.label}」`);
    await reloadRelations();
  } catch (error) {
    feedback.failure(error, '删除关系失败');
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/**
 * 被前置卡住的任务。
 *
 * 数据来自 `blockedByCount`（未完成的前置数）。依赖边到手后再补上"是谁挡着" ——
 * 只说"被 2 个前置卡住"没有可操作性；拿不到依赖边时（接口失败）就只显示数量，
 * 并在面板底部说明原因，而不是假装没有前置。
 */
const blockedRows = computed(() => {
  const rows: { id: string; title: string; count: number; who: string }[] = [];
  for (const n of tree.value.byId.values()) {
    if (n.done || n.blockedByCount <= 0) continue;
    const names = (predecessorIdsOf.value.get(n.id) ?? [])
      .map((id) => tree.value.byId.get(id))
      .filter((p): p is OvNode => p !== undefined && !p.done)
      .map((p) => p.title);
    rows.push({
      id: n.id,
      title: n.title,
      count: n.blockedByCount,
      who: names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 个` : names.join('、'),
    });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, 8);
});

/* ================================================================== */
/* 11) 交互：拖拽旋转、视角、自动旋转、Esc                              */
/* ================================================================== */

async function loadMeta(projectId: string): Promise<void> {
  loadingMeta.value = true;
  try {
    const [list] = await Promise.all([
      milestonesApi.list(projectId),
      loadDependencies(projectId),
      reloadRelations(),
    ]);
    milestones.value = list;
  } catch (error) {
    milestones.value = [];
    relations.value = [];
    feedback.failure(error, '加载里程碑失败');
  } finally {
    loadingMeta.value = false;
  }
}

watch(
  () => board.currentProjectId,
  (projectId) => {
    if (!projectId) {
      milestones.value = [];
      relations.value = [];
      deps.value = [];
      depsReady.value = false;
      todayWork.value = null;
      return;
    }
    void loadMeta(projectId);
    void loadTodayWork();
  },
);

onMounted(() => {
  const projectId = board.currentProjectId;
  if (!projectId) return;
  void loadMeta(projectId);
  void loadTodayWork();
  /*
   * 进这一页**总是重新拉一次**任务列表。
   *
   * 原因是 store 的写入是"打补丁"式的：改任务、拖状态只更新 `board.columns`，
   * 而本页读的是 `taskList`（扁平全量列表）—— 不重拉的话，刚在任务页改完状态回到总览，
   * 统计数字还是旧的。这一页是导航过来看的，多一次请求换数字准确，值。
   */
  if (!board.loading) void board.loadBoard();
});

/* ================================================================== */
/* 今日工作内容（取代原来的六边形关系数据图）                              */
/* ================================================================== */

/**
 * 用户 2026-10-02：「在总览中关系数据图改为今日工作内容，显示列表哪些内容今天有改动」。
 *
 * 数据直接取 `collectWorkLogData`（工作日志用的那套取数）：它天生回答的就是
 * "今天完成/推进/新建了哪些任务"，而且**与工作日志文档里的条目完全同源** ——
 * 从这一页看到的内容，就是当天日志里会写进去的内容。
 *
 * `projectId` 不过滤：这里要的是"今天全项目范围动了什么"，
 * 与今日待办（只看当前项目）刻意不同 —— 总览是给"今天整体干了什么"看的。
 */
const todayWork = ref<WorkLogData | null>(null);
const todayLoading = ref(false);

async function loadTodayWork(): Promise<void> {
  todayLoading.value = true;
  try {
    todayWork.value = await workLogApi.preview();
  } catch (error) {
    todayWork.value = null;
    feedback.failure(error, '加载今日工作内容失败');
  } finally {
    todayLoading.value = false;
  }
}

/** 今日工作内容按「完成 / 推进中 / 新建」分成三组（与工作日志的口径一致） */
const todayGroups = computed(() => {
  const data = todayWork.value;
  if (!data) return [];
  return [
    {
      key: 'completed' as const,
      label: '已完成',
      tone: 'ok' as const,
      items: data.completed as OverviewWorkEntry[],
    },
    {
      key: 'progressed' as const,
      label: '推进中',
      tone: 'busy' as const,
      items: data.progressed as OverviewWorkEntry[],
    },
    {
      key: 'created' as const,
      label: '今日新建',
      tone: 'new' as const,
      items: data.created as OverviewWorkEntry[],
    },
  ];
});

type OverviewWorkEntry = WorkLogData['completed'][number];

/** 今日有没有任何改动（空态判断用） */
const hasTodayWork = computed(() => todayGroups.value.some((group) => group.items.length > 0));

/**
 * 面板副标题：日期 + 三组数字。
 * 只列出**有内容**的组 —— 「推进中 0」这种零值写出来只是噪音。
 */
const todaySubtitle = computed(() => {
  const data = todayWork.value;
  if (!data) return '';
  const counts = todayGroups.value
    .filter((group) => group.items.length > 0)
    .map((group) => `${group.label} ${group.items.length}`);
  return [data.dateLabel, ...counts].join(' · ');
});

const loadingAll = computed(() => board.loading || loadingMeta.value);
</script>

<template>
  <!--
    四个分支都带 `data-view="overview"`：E2E 用"这个元素出现且有尺寸"判断路由内容挂载成功，
    而总览在不同数据状态下渲染的是不同根节点（没选项目 / 加载中 / 没任务 / 正常）。
    标记必须挂在**每个分支自己的根节点**上 —— 否则一种状态下测得过、另一种状态下判据失效。
  -->
  <div v-if="!board.currentProject" class="blank" data-view="overview">
    <EmptyState text="还没有选项目" hint="请在左侧选择项目，此处将显示其总览" />
  </div>

  <div v-else-if="loadingAll && stats.total === 0" class="blank" data-view="overview">
    <NSpin size="medium" />
  </div>

  <div v-else-if="stats.total === 0" class="blank" data-view="overview">
    <EmptyState
      text="这个项目还没有任务"
      hint="创建首个任务后，此处将统计任务分布与今日的工作内容"
    />
  </div>

  <div v-else class="page" data-view="overview">
    <!-- 统计卡：四个数字都由 taskList 现算，没有一个写死 -->
    <section class="stats">
      <article v-for="card in statCards" :key="card.label" class="stat">
        <div class="lb">{{ card.label }}</div>
        <div class="nm">
          {{ card.value }}<small v-if="card.unit">{{ card.unit }}</small>
        </div>
        <div class="lb hint">{{ card.hint }}</div>
        <div class="bar" :class="card.tone">
          <i :style="{ width: `${card.pct}%` }" />
        </div>
      </article>
    </section>

    <div class="grid">
      <!--
        ============ 今日工作内容 ============
        用户 2026-10-02：「在总览中关系数据图改为今日工作内容，显示列表哪些内容今天有改动」。
        数据来自 /work-log/preview —— 与当天的工作日志文档**同一套取数**，
        所以这里看到的就是日志里会写进去的内容。
      -->
      <section class="panel today-panel" data-field="today-work-panel">
        <header>
          <h2>今日工作内容</h2>
          <span class="sub" data-field="today-work-sub">{{ todaySubtitle }}</span>
          <span class="spacer" />
          <NButton
            size="tiny"
            quaternary
            data-field="today-work-refresh"
            :loading="todayLoading"
            @click="loadTodayWork"
          >
            刷新
          </NButton>
        </header>

        <div v-if="todayLoading && !todayWork" class="today-empty"><NSpin size="small" /></div>

        <div v-else-if="!hasTodayWork" class="today-empty" data-field="today-work-empty">
          <EmptyState
            compact
            text="今天还没有任务改动"
            hint="完成、推进或新建任务之后，这里会列出当天动过的内容"
          />
        </div>

        <div v-else class="today-groups">
          <section
            v-for="group in todayGroups"
            :key="group.key"
            class="today-group"
            :data-today-group="group.key"
          >
            <h3>
              <span class="dot" :class="group.tone" />
              {{ group.label }}
              <span class="n">{{ group.items.length }}</span>
            </h3>
            <ul>
              <li v-for="entry in group.items" :key="entry.taskId" data-field="today-work-item">
                <span class="t">{{ entry.title }}</span>
                <span class="who">{{ entry.projectName }}</span>
                <span class="st">{{ entry.statusName ?? '未设置状态' }}</span>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <!-- ============ 右侧小面板 ============ -->
      <div class="side">
        <section class="card">
          <h3>状态分布</h3>
          <div class="stackbar">
            <i
              v-for="row in statusBreakdown"
              :key="row.id"
              :style="{ width: `${(row.count / stats.total) * 100}%`, background: row.color }"
            />
          </div>
          <div class="legend">
            <div v-for="row in statusBreakdown" :key="row.id" class="it">
              <i :style="{ background: row.color }" />{{ row.name }}
              <span class="n">{{ row.count }}</span>
            </div>
          </div>
        </section>

        <section class="card">
          <h3>完成度</h3>
          <div class="kvrow">
            <span class="lb">主任务</span>
            <span class="track"><i class="ok" :style="{ width: `${pctOf(stats.mainDone, stats.main)}%` }" /></span>
            <span class="n">{{ stats.mainDone }}/{{ stats.main }}</span>
          </div>
          <div class="kvrow">
            <span class="lb">子任务</span>
            <span class="track"><i class="ok" :style="{ width: `${pctOf(stats.juniorDone, stats.junior)}%` }" /></span>
            <span class="n">{{ stats.juniorDone }}/{{ stats.junior }}</span>
          </div>
        </section>

        <section class="card">
          <h3>里程碑 <span class="n">已达成 {{ reachedCount }}/{{ milestones.length }}</span></h3>
          <div v-if="milestoneRows.length" class="mslist">
            <div v-for="row in milestoneRows" :key="row.id" class="ms" :class="{ done: row.reached }">
              <span class="nm" :class="{ done: row.reached }">{{ row.name }}</span>
              <span class="n">{{ row.reached ? '已达成' : row.due ? `截止 ${row.due}` : '未排期' }}</span>
              <button
                type="button"
                class="ms-act"
                :data-ms-reach="row.id"
                :disabled="milestoneBusy === row.id"
                :title="row.reached ? '取消达成' : '标记为已达成'"
                @click="toggleMilestoneReached(row)"
              >
                {{ row.reached ? '取消达成' : '达成' }}
              </button>
              <button
                type="button"
                class="ms-act danger"
                :data-ms-remove="row.id"
                :disabled="milestoneBusy === row.id"
                title="删除这个里程碑"
                @click="removeMilestone(row)"
              >
                删除
              </button>
            </div>
          </div>
          <EmptyState v-else compact :size="34" text="这个项目还没有里程碑" />

          <!--
            新增：管理侧模板会自动铺几个，但用户随时可能想加自己的。
            这里用**原生 input/button**：这一个视图整页都是原生控件 + 自己的 CSS，
            引入 Naive 的输入框只为了一个"新增里程碑"，样式反而要额外对齐。
            （教训：第一版写了 `<NInput>`，但本文件没有引入 Naive 组件，
              渲染出来是个没解析的 `<ninput>` 标签 —— 端到端报"输入框不存在"，
              用探针打出 outerHTML 才看明白。）
          -->
          <div class="ms-add">
            <input
              v-model="newMilestoneName"
              class="ms-input"
              type="text"
              placeholder="新增里程碑（例如：v1.0 上线）"
              data-field="milestone-new"
              @keyup.enter="addMilestone"
            />
            <button
              type="button"
              class="ms-add-btn"
              :disabled="newMilestoneName.trim().length === 0"
              data-field="milestone-add"
              @click="addMilestone"
            >
              添加
            </button>
          </div>

          <!--
            这里刻意不画"里程碑进度条"：任务与里程碑在数据模型里**还没有关联字段**，
            进度算不出来。摆一根假的进度条比留白更糟 —— 它会让人以为有这回事。
          -->
          <p v-if="milestoneRows.length" class="note">
            任务与里程碑之间尚无关联字段，因此此处仅显示里程碑自身状态。
          </p>
        </section>

        <section class="card">
          <h3>被前置卡住 <span class="n">{{ blockedRows.length ? `前 ${blockedRows.length} 个` : '' }}</span></h3>
          <ul v-if="blockedRows.length" class="risk">
            <li v-for="row in blockedRows" :key="row.id" :title="row.who ? `被 ${row.who} 挡着` : row.title">
              <span class="nm">{{ row.title }}</span>
              <span class="tag">前置 {{ row.count }}</span>
            </li>
          </ul>
          <EmptyState v-else compact :size="34" text="没有被前置卡住的任务" />
          <p v-if="!depsReady && stats.total > 0" class="note">
            依赖明细没取到，这里只显示数量，不列出具体的阻塞来源。
          </p>
        </section>

        <!--
          关系链（需求 §5.2.1）：整个系统里**唯一跨项目**的东西。
          它只做展示 —— 不共享任务/标签/状态/文档，也不做跨项目汇总，
          所以这里的说明必须写清楚，免得用户以为"标了关系就会联动"。
        -->
        <section class="card" data-field="relations-card">
          <h3>
            关系链
            <span class="n">{{ relations.length ? `共 ${relations.length} 条` : '' }}</span>
          </h3>

          <ul v-if="relations.length" class="rellist">
            <li v-for="row in relations" :key="row.id" :title="row.note ?? ''">
              <span class="rel-line">
                <template v-if="row.direction === 'outgoing'">
                  <span class="rel-me">本项目</span>
                  <span class="rel-arrow">→</span>
                  <span class="rel-label">{{ row.label }}</span>
                  <span class="rel-arrow">→</span>
                  <span class="rel-other" :style="{ color: row.to.color }">{{ row.to.name }}</span>
                </template>
                <template v-else>
                  <span class="rel-other" :style="{ color: row.from.color }">{{ row.from.name }}</span>
                  <span class="rel-arrow">→</span>
                  <span class="rel-label">{{ row.label }}</span>
                  <span class="rel-arrow">→</span>
                  <span class="rel-me">本项目</span>
                </template>
                <span v-if="row.direction === 'incoming' && row.from.archived" class="tag">已归档</span>
                <span v-else-if="row.direction === 'outgoing' && row.to.archived" class="tag">已归档</span>
              </span>
              <button
                type="button"
                class="rel-act"
                :data-rel-remove="row.id"
                title="删掉这条关系"
                @click="removeRelation(row)"
              >
                删除
              </button>
            </li>
          </ul>
          <EmptyState v-else compact :size="34" text="还没有和其他项目建立关系" />

          <!-- 新增：选另一个项目 + 自由填关系名（用户给的例子是「调用」「同属一个系统」） -->
          <div class="rel-add">
            <select v-model="newRelationTo" class="rel-input" data-field="relation-target">
              <option value="">选另一个项目…</option>
              <option v-for="item in relationCandidates" :key="item.id" :value="item.id">
                {{ item.name }}
              </option>
            </select>
            <input
              v-model="newRelationLabel"
              class="rel-input"
              type="text"
              maxlength="40"
              placeholder="关系名称（如：调用）"
              data-field="relation-label"
              @keyup.enter="addRelation"
            />
            <button
              type="button"
              class="rel-add-btn"
              :disabled="newRelationTo === '' || newRelationLabel.trim() === ''"
              data-field="relation-add"
              @click="addRelation"
            >
              建立关系
            </button>
          </div>

          <p class="note">
            关系链仅用于展示：不共享任务、标签、状态与文档，也不做跨项目汇总（需求 §5.2.1）。
          </p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 页面骨架 ---------- */
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100%;
  padding: 16px 18px 24px;
}

.blank {
  display: grid;
  place-items: center;
  min-height: 60vh;
  padding: 24px;
}

.faint {
  color: var(--pm-text-faint);
  font-size: 12px;
}

/* ---------- 统计卡 ---------- */
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.stat {
  min-width: 0;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  padding: 11px 13px 12px;
}

.stat .lb {
  color: var(--pm-text-faint);
  font-size: 11.5px;
}

.stat .nm {
  font-size: 25px;
  font-weight: 600;
  line-height: 1.25;
  margin-top: 3px;
  letter-spacing: -0.4px;
  color: var(--pm-text);
}

.stat .nm small {
  font-size: 12px;
  font-weight: 500;
  color: var(--pm-text-faint);
  margin-left: 3px;
  letter-spacing: 0;
}

.stat .hint {
  margin-top: 2px;
}

.stat .bar {
  height: 3px;
  border-radius: 2px;
  background: var(--pm-sunken);
  margin-top: 9px;
  overflow: hidden;
}

.stat .bar > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: color-mix(in srgb, var(--pm-accent) 62%, transparent);
  transition: width 0.5s cubic-bezier(0.22, 1.2, 0.36, 1);
}

.stat .bar.ok > i {
  background: color-mix(in srgb, var(--pm-ok) 66%, transparent);
}

/* ---------- 两栏 ---------- */
.grid {
  flex: 1;
  min-height: 520px;
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr);
  gap: 12px;
}

.panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  overflow: hidden;
}

.panel > header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--pm-border);
}

.panel > header h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel > header .sub {
  color: var(--pm-text-faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel > header .spacer {
  flex: 1;
}

/* ---------- 今日工作内容 ----------
   三段纵向排布（已完成 / 推进中 / 今日新建），一律弹性盒子：
   面板高度由内容决定，段多了整块面板跟右侧小面板一起滚动，不在内部各自滚动。 */
.today-panel {
  min-height: 260px;
}

.today-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 12px;
}

.today-groups {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
  overflow-y: auto;
}

.today-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.today-group h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--pm-text-muted);
}

.today-group h3 .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.today-group h3 .dot.ok {
  background: var(--pm-ok);
}

.today-group h3 .dot.busy {
  background: var(--pm-accent);
}

.today-group h3 .dot.new {
  background: var(--pm-warn);
}

.today-group h3 .n {
  margin-left: auto;
  font-weight: 400;
  color: var(--pm-text-faint);
}

.today-group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.today-group li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--pm-sunken);
  font-size: 11.5px;
  color: var(--pm-text);
}

.today-group li .t {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.today-group li .who,
.today-group li .st {
  flex: none;
  font-size: 10.5px;
  color: var(--pm-text-faint);
  white-space: nowrap;
}

.today-group li .st {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--pm-surface);
}


/* ---------- 右侧小面板 ---------- */
.side {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.card {
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  padding: 12px 13px 13px;
}

.card h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--pm-text);
}

.card h3 .n {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--pm-text-faint);
}

.stackbar {
  display: flex;
  height: 8px;
  border-radius: 5px;
  overflow: hidden;
  background: var(--pm-sunken);
}

.stackbar > i {
  display: block;
  height: 100%;
  transition: width 0.5s cubic-bezier(0.22, 1.2, 0.36, 1);
}

.legend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 10px;
  margin-top: 10px;
}

.legend .it {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--pm-text-muted);
  min-width: 0;
}

.legend .it i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex: none;
}

.legend .it .n {
  margin-left: auto;
  color: var(--pm-text-faint);
}

.kvrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--pm-text-muted);
}

.kvrow + .kvrow {
  margin-top: 8px;
}

.kvrow .lb {
  width: 58px;
  flex: none;
}

.kvrow .track {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--pm-sunken);
  overflow: hidden;
}

.kvrow .track > i {
  display: block;
  height: 100%;
  border-radius: 2px;
}

.kvrow .track > i.ok {
  background: color-mix(in srgb, var(--pm-ok) 66%, transparent);
}

.kvrow .n {
  color: var(--pm-text-faint);
  white-space: nowrap;
}

.mslist {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.mslist .ms {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--pm-text-muted);
}

.mslist .ms .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mslist .ms .nm.done {
  color: var(--pm-text);
}

.mslist .ms .n {
  margin-left: auto;
  color: var(--pm-text-faint);
  white-space: nowrap;
}

/*
 * 行内操作：默认淡淡的，悬停整行才显出来。
 *
 * 为什么不一直显眼：这一栏是"看节奏"的地方，两个按钮一直亮着会把里程碑名字压成配角。
 * 但也不能藏到找不着 —— 所以整行悬停就出现，并且鼠标指针保持可点（不是纯图标装饰）。
 */
.mslist .ms .ms-act {
  border: 1px solid transparent;
  background: transparent;
  color: var(--pm-text-faint);
  font: inherit;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.mslist .ms:hover .ms-act,
.mslist .ms .ms-act:focus-visible {
  opacity: 1;
}

.mslist .ms .ms-act:hover {
  color: var(--pm-text);
  border-color: var(--pm-border);
}

.mslist .ms .ms-act.danger:hover {
  color: var(--pm-danger);
  border-color: var(--pm-danger);
}

.mslist .ms .ms-act:disabled {
  cursor: default;
  opacity: 0.4;
}

/* 已达成的里程碑：整行压暗，一眼能看出哪些还没到 */
.mslist .ms.done .nm {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--pm-ok) 60%, transparent);
}

/* ---------- 关系链（纯展示） ---------- */

.rellist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.rellist li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--pm-text-muted);
}

.rel-line {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex-wrap: wrap;
}

.rel-me {
  color: var(--pm-text-faint);
  white-space: nowrap;
}

.rel-other {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 12em;
}

.rel-label {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--pm-sunken);
  color: var(--pm-text);
  white-space: nowrap;
}

.rel-arrow {
  color: var(--pm-text-faint);
}

/* 删除按钮：悬停整行才显出来（和里程碑那一栏同一套手感） */
.rel-act {
  margin-left: auto;
  border: 1px solid transparent;
  background: transparent;
  color: var(--pm-text-faint);
  font: inherit;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.rellist li:hover .rel-act,
.rel-act:focus-visible {
  opacity: 1;
}

.rel-act:hover {
  color: var(--pm-danger);
  border-color: var(--pm-danger);
}

/* 新增关系：两个输入 + 一个按钮（也是弹性盒子，与整页一致） */
.rel-add {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}

.rel-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  background: var(--pm-surface);
  color: var(--pm-text);
  font: inherit;
  font-size: 12px;
}

.rel-input:focus {
  outline: none;
  border-color: var(--pm-accent);
}

.rel-add-btn {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  background: var(--pm-surface);
  color: var(--pm-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.rel-add-btn:hover:not(:disabled) {
  border-color: var(--pm-accent);
  color: var(--pm-accent);
}

.rel-add-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 新增里程碑：一行输入 + 按钮（弹性盒子，与整页的排布方式一致） */
.ms-add {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}

.ms-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  background: var(--pm-surface);
  color: var(--pm-text);
  font: inherit;
  font-size: 12px;
}

.ms-input:focus {
  outline: none;
  border-color: var(--pm-accent);
}

.ms-add-btn {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  background: var(--pm-surface);
  color: var(--pm-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ms-add-btn:hover:not(:disabled) {
  border-color: var(--pm-accent);
  color: var(--pm-accent);
}

.ms-add-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.risk {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.risk li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--pm-text-muted);
}

.risk li .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.risk li .tag {
  margin-left: auto;
  flex: none;
  font-size: 10.5px;
  color: var(--pm-warn);
  background: color-mix(in srgb, var(--pm-warn) 13%, transparent);
  border-radius: 4px;
  padding: 0 5px;
}

.note {
  margin: 10px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--pm-text-faint);
}

.empty {
  color: var(--pm-text-faint);
  font-size: 11.5px;
}
</style>
