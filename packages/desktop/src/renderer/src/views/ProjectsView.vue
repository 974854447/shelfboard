<script setup lang="ts">
/**
 * 项目列表与新建。
 *
 * 新建走**弹窗 + 项目类型选择**，而不是把表单摊在页面上：
 *
 * - 页面顶部只留一个按钮，列表本身才是主体；
 * - 类型选择用卡片而不是下拉：四种类型的差别（要不要生成代码、生成几套）
 *   用下拉说不清，卡片配一行说明才讲得明白。
 *
 * 关于"代码类项目"：数据模型里早有 `code_kind` 字段，所以现在就能把类型**记下来**；
 * 但真正的代码骨架生成属于 M4（环境检测 + 官方脚手架调用 + 依赖安装），
 * 所以卡片上如实标注，而不是假装已经能生成。
 */

import {
  NAlert,
  NButton,
  NCard,
  NColorPicker,
  NInput,
  NModal,
  NSkeleton,
  NSpin,
  NTag,
  NTooltip,
} from 'naive-ui';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import AppIcon, { type IconName } from '../components/AppIcon.vue';
import ProjectWizard from '../components/ProjectWizard.vue';
import EmptyState from '../components/EmptyState.vue';
import { jobs as jobsApi, projects as projectsApi, type ProjectDto } from '../api/endpoints';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';

/*
 * 运行面板宽度。
 *
 * 用户 2026-10-01 反馈「这里太宽了，调窄一点」（原来是 Naive 的默认宽度，约 700px）。
 *
 * **为什么写在 JS 常量里、用 `:style` 传进去，而不是写在下面的 `<style scoped>` 里**：
 * `preset="card"` 的 NModal 自己生成 `.n-card` 节点，`class="run-panel"` 是通过属性透传
 * 贴上去的，而这个节点**拿不到 scoped 样式的 `data-v-*` 属性**（实测 `hasAttribute` 为 false）
 * —— 于是 `.run-panel[data-v-…] { width: … }` 是一条**永远不会命中的死规则**，
 * 面板宽度一直由 Naive 的默认样式决定。用内联 style 则一定生效（优先级也最高）。
 * 踩这个坑的代价是一次"改了没反应"，所以留这段注释。
 *
 * 600px 这个值：面板里唯一"想要宽度"的是启动输出，而它是 `pre-wrap + break-all`，
 * 长路径会自己折行（有 e2e 断言盯着它不横向溢出），所以不需要靠宽度去容纳；
 * 同时它和页面里其它弹窗（新建项目 620px）是同一档观感。
 */
const RUN_PANEL_WIDTH = 'min(600px, calc(100vw - 60px))';

const board = useBoardStore();
const feedback = useFeedback();
const router = useRouter();

/* ------------------------------------------------------------------ */
/* 项目类型                                                            */
/* ------------------------------------------------------------------ */

type CodeKind = 'frontend' | 'backend' | 'fullstack';

interface ProjectType {
  /** null 表示纯管理项目（不生成代码） */
  kind: CodeKind | null;
  label: string;
  icon: IconName;
  summary: string;
  detail: string;
  /** 是否属于"需要生成代码"的类型（M4 才真正生成） */
  needsScaffold: boolean;
}

const PROJECT_TYPES: ProjectType[] = [
  {
    kind: null,
    label: '纯管理项目',
    icon: 'folder',
    summary: '只管理任务与文档',
    detail: '不生成任何代码，适合学习计划、装修、运营活动这类没有代码仓库的项目。',
    needsScaffold: false,
  },
  {
    kind: 'frontend',
    label: '前端项目',
    icon: 'board',
    summary: 'Vue3 + TS + Vite',
    detail: '创建一个只含前端的代码骨架，并与本项目管理关联。',
    needsScaffold: true,
  },
  {
    kind: 'backend',
    label: '后端项目',
    icon: 'terminal',
    summary: 'NestJS 或 Python',
    detail: '创建一个只含后端的代码骨架，并与本项目管理关联。',
    needsScaffold: true,
  },
  {
    kind: 'fullstack',
    label: '前后端项目',
    icon: 'rows',
    summary: 'frontend/ + backend/',
    detail: '一次生成前后端两套骨架，放在同一个项目目录下的两个子目录。',
    needsScaffold: true,
  },
];

const TYPE_LABEL: Record<string, string> = {
  frontend: '前端',
  backend: '后端',
  fullstack: '前后端',
};

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/** 每个项目的关系链小结（项目卡片上的标记用；一次请求拿全部） */
const relationSummary = ref<Record<string, { count: number; labels: string[] }>>({});
const all = ref<ProjectDto[]>([]);
const loading = ref(false);
const includeArchived = ref(false);

async function reload(): Promise<void> {
  loading.value = true;
  try {
    all.value = await projectsApi.list({ includeArchived: includeArchived.value });
  /*
   * 关系链小结单独拉一次（一个请求拿全部项目的条数与名称）：
   * 卡片上要显示"和谁有关系"，按项目循环请求会变成 N 次。
   */
  relationSummary.value = await projectsApi.relationSummary().catch(() => ({}));
  await loadRunState();
  } catch (error) {
    feedback.failure(error, '加载项目列表失败');
  } finally {
    loading.value = false;
  }
}

onMounted(reload);

/* ------------------------------------------------------------------ */
/* 新建弹窗                                                            */
/* ------------------------------------------------------------------ */

const showCreate = ref(false);

/**
 * 打开向导。
 *
 * 表单状态（项目类型、技术栈、名称…）**都在向导组件里**（`ProjectWizard.vue`），
 * 这一页只负责"打开它"和"建完刷新列表" —— 否则同一个表单的状态会分裂在两处，
 * 改一个字段还得先想清楚改的是哪一份。
 */
function openCreate(): void {
  showCreate.value = true;
}

/** 向导里项目已经建好了（可能还生成了代码、装了依赖）：刷新列表并进工作台 */
async function onCreated(projectId: string): Promise<void> {
  await board.loadProjects();
  await reload();
  await board.selectProject(projectId);
  void router.push({ name: 'workbench' });
}

/* ------------------------------------------------------------------ */
/* 行内操作                                                            */
/* ------------------------------------------------------------------ */
async function toggleArchive(project: ProjectDto): Promise<void> {
  const archiving = project.status !== 'archived';

  try {
    if (archiving) {
      await projectsApi.archive(project.id);
      feedback.success(`已归档「${project.name}」`);
    } else {
      await projectsApi.unarchive(project.id);
      feedback.success(`已取消归档「${project.name}」`);
    }

    /*
     * 归档的如果正是"当前项目"，必须把当前项目清掉。
     *
     * 归档后它不再出现在项目列表里（列表按 includeArchived=false 拉取），
     * 而侧栏的项目选择框仍拿着这个 id —— Naive 找不到对应选项时会把**原始 value
     * 当标签显示**，于是界面上出现一串项目 id（看起来就是乱码）。
     * 删除项目那条路径本来就清了，归档这条之前漏了。
     */
    if (archiving && board.currentProjectId === project.id) {
      await board.selectProject(null);
    }

    await board.loadProjects();
    await reload();
  } catch (error) {
    feedback.failure(error, '操作失败');
  }
}

async function remove(project: ProjectDto): Promise<void> {
  /*
   * **正在运行的项目不许删**（用户 2026-10-01 的要求）。
   *
   * 先现拉一次运行状态再判断，而不是用界面上那份（它是轮询来的，最长可能差一两秒）：
   * 用户刚点过"启动"就立刻来删，界面上的集合还是旧的，提示就漏了。
   * 服务端还会再挡一次（那条才是权威判断），这里只是把话说在用户点下去之前。
   */
  await loadRunState();
  if (runningProjectIds.value.has(project.id)) {
    await feedback.alert({
      title: '项目正在运行',
      content: `「${project.name}」的开发服务器正在运行，请先停止后再删除。\n\n停止方式：点击该卡片上的「停止」，或打开卡片上的「运行详情」面板。`,
    });
    return;
  }

  const confirmed = await feedback.confirm({
    title: '删除项目',
    content: project.folder
      ? `确定将「${project.name}」移入回收站？该项目的任务与文档会一并隐藏，可随时还原。\n\n项目文件夹「${project.folder}」将原样保留（其中可能已有代码或附件，不会代为删除）。`
      : `确定将「${project.name}」移入回收站？该项目的任务与文档会一并隐藏，可随时还原。`,
    positiveText: '移入回收站',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await projectsApi.remove(project.id);
    if (board.currentProjectId === project.id) await board.selectProject(null);
    await board.loadProjects();
    await reload();
    feedback.success(`已移入回收站：${project.name}（文件夹已保留）`);
  } catch (error) {
    feedback.failure(error, '删除失败');
  }
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

const showTrash = ref(false);
const trashItems = ref<ProjectDto[]>([]);
const trashLoading = ref(false);
const trashBusy = ref<string | null>(null);

async function loadTrash(): Promise<void> {
  trashLoading.value = true;
  try {
    // 回收站 = 已软删除的项目。归档与否都要（归档过的项目也能被删进回收站）
    const list = await projectsApi.list({ includeArchived: true, includeDeleted: true });
    trashItems.value = list
      .filter((project) => project.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  } catch (error) {
    feedback.failure(error, '读取回收站失败');
  } finally {
    trashLoading.value = false;
  }
}

async function openTrash(): Promise<void> {
  showTrash.value = true;
  await loadTrash();
}

/** 从回收站还原 */
async function restoreFromTrash(project: ProjectDto): Promise<void> {
  trashBusy.value = project.id;
  try {
    await projectsApi.restore(project.id);
    feedback.success(`已还原：${project.name}`);
    await loadTrash();
    await board.loadProjects();
    await reload();
  } catch (error) {
    feedback.failure(error, '还原失败');
  } finally {
    trashBusy.value = null;
  }
}

/**
 * 清空回收站（用户 2026-10-01：「回收站新增一键删除」）。
 *
 * 一次请求删光里面所有项目。确认框必须把两件事说全：
 * 有多少个项目、以及**磁盘上的文件夹都会保留**（只清应用里的数据）。
 * 这是不可撤销的操作，所以文案里明确写"不能撤销"，按钮也用危险色。
 */
const purgingAll = ref(false);

async function purgeAllFromTrash(): Promise<void> {
  const count = trashItems.value.length;
  if (count === 0) return;

  const confirmed = await feedback.confirm({
    title: '清空回收站',
    content:
      `回收站里的 ${count} 个项目将在应用内被彻底删除（任务、状态、标签、里程碑、关系一并清除），且不可撤销。\n\n` +
      '磁盘上的项目文件夹都会**保留**：里面是你自己写的代码与附件，不会替你删。\n\n' +
      `要删的是：${trashItems.value.map((item) => item.name).join('、')}`,
    positiveText: `彻底删除 ${count} 个项目`,
    danger: true,
  });
  if (!confirmed) return;

  purgingAll.value = true;
  try {
    const result = await projectsApi.purgeTrash();
    feedback.success(
      result.deleted > 0
        ? `已彻底删除 ${result.deleted} 个项目（文件夹已保留）`
        : '回收站本来就是空的',
    );
    await loadTrash();
    await board.loadProjects();
    await reload();
  } catch (error) {
    feedback.failure(error, '清空回收站失败');
  } finally {
    purgingAll.value = false;
  }
}

/**
 * 从回收站**彻底删除**。
 *
 * 两件事必须说清楚，否则用户点下去才知道后果：
 * 1. 应用里的数据（项目、任务、工作流、标签、里程碑、关系）会被真正清掉，**不可恢复**；
 * 2. **磁盘上的项目文件夹保留** —— 里面是用户自己写的代码与附件，
 *    递归删目录不可逆，这条边界与服务层的既有约定一致（见 softDeleteProject 的注释）。
 *    所以这里把文件夹路径也显示出来，让用户知道去哪儿自己清理。
 */
async function purgeFromTrash(project: ProjectDto): Promise<void> {
  if (runningProjectIds.value.has(project.id)) {
    await feedback.alert({
      title: '项目正在运行',
      content: `「${project.name}」的开发服务器正在运行，请先停止后再彻底删除。`,
    });
    return;
  }

  const confirmed = await feedback.confirm({
    title: '彻底删除项目',
    content:
      `「${project.name}」在应用内的全部数据（任务、状态、标签、里程碑、关系）将被删除，且不可撤销。` +
      (project.folder
        ? `\n\n磁盘上的项目文件夹会保留：${project.folder}（里面的代码与附件不会替你删）。`
        : ''),
    positiveText: '彻底删除',
    danger: true,
  });
  if (!confirmed) return;

  trashBusy.value = project.id;
  try {
    await projectsApi.remove(project.id, true);
    feedback.success(`已彻底删除：${project.name}`);
    await loadTrash();
    await board.loadProjects();
    await reload();
  } catch (error) {
    // 服务端也会因为"正在运行"拒掉，这条提示是真话（不是兜底文案）
    feedback.failure(error, '彻底删除失败');
  } finally {
    trashBusy.value = null;
  }
}

/** 在资源管理器里打开这个项目自己的文件夹 */
async function revealFolder(project: ProjectDto): Promise<void> {
  if (!project.folder) {
    feedback.info('该项目尚无文件夹，重启应用后将自动补建');
    return;
  }
  try {
    await window.pmStudio.revealProjectFolder(project.id);
  } catch (error) {
    feedback.failure(error, '打开文件夹失败');
  }
}

/** 用编辑器打开项目（编辑器由主进程按白名单解析，这里只管把 id 递过去） */
async function openInEditor(project: ProjectDto): Promise<void> {
  try {
    await window.pmStudio.openProjectInEditor(project.id);
  } catch (error) {
    feedback.failure(error, '打开编辑器失败');
  }
}

/**
 * 整张卡片可点：点空白处也打开看板。
 *
 * 但卡片里还有一排按钮（打开看板 / 打开文件夹 / 编辑器 / 归档 / 删除），
 * 它们的点击会冒泡到卡片上 —— 必须显式排除，否则"点删除"会顺带把看板也打开。
 * 这和列表页行点击是同一类问题，做法也一致：**在处理器里判断事件来源，而不是
 * 指望每个子元素自己 stopPropagation**（那样每加一个按钮就会再漏一次）。
 */
const CARD_CLICK_IGNORE = ['button', 'a', 'input', 'select', 'textarea'].join(', ');

function onCardClick(project: ProjectDto, event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest(CARD_CLICK_IGNORE)) return;
  void open(project);
}

/**
 * 「运行中」的项目集合 —— 现在是**真的**了。
 *
 * 以前这里是个占位（恒为空，卡片上的蓝色光晕与"运行中"标签从来没亮过）。
 * 现在它来自服务端的开发服务器状态（`GET /projects/:id/run` 会带回
 * `runningProjectIds`），点启动/停止之后刷新。
 *
 * 谁是数据源这件事很清楚：**服务端**（进程在它手里），界面只负责显示与触发。
 */
const runningProjectIds = ref<Set<string>>(new Set());

/** 每个项目的运行概况（能不能启动、认出来的目标、状态）—— 卡片上的按钮与端口都读它 */
type RunOverview = {
  runnable: boolean;
  runningProjectIds: string[];
  targets: Array<{
    role: 'frontend' | 'backend';
    kindLabel: string;
    port: number;
    ready: boolean;
    problem?: string;
    state: {
      status: string;
      port: number;
      url: string | null;
      reachable: boolean;
      error: string | null;
      command: string;
      log: Array<{ ts: number; stream: 'stdout' | 'stderr' | 'system'; text: string }>;
    } | null;
  }>;
  problems: string[];
};
const runOverviews = ref<Record<string, RunOverview>>({});
/** 正在启动/停止中的项目（按钮转圈，防连点） */
const runBusy = ref<Set<string>>(new Set());

/** 一次把所有项目的运行概况拉回来（一个请求，别按项目循环） */
async function loadRunState(): Promise<void> {
  const next: Record<string, RunOverview> = {};
  const running = new Set<string>();
  await Promise.all(
    all.value.map(async (project) => {
      // 纯管理项目不查（服务端只会回"不能启动"，白跑一趟请求）
      if (!project.codeKind) return;
      try {
        const overview = await projectsApi.run(project.id);
        next[project.id] = overview;
        if (overview.runningProjectIds.includes(project.id)) running.add(project.id);
      } catch {
        // 拿不到就当作"不知道"：卡片上不显示按钮，而不是显示一个假的"已停止"
      }
    }),
  );
  runOverviews.value = next;
  runningProjectIds.value = running;

  /*
   * 有东西在跑就**持续刷新**。
   *
   * 为什么必须轮询（这次的第二个坑）：启动之后"地址连通"要等几秒到几十秒
   * （Vite 第一次要预构建依赖），而"进程自己死了"也要能被发现 ——
   * 只在点按钮时拉一次的话，界面会一直停在"运行中"却没有"打开"入口，
   * 用户看到的还是"没有正常启动"。
   * 没有东西在跑时立刻停掉轮询（不空转）。
   */
  if (running.size > 0) ensureRunPolling();
  else stopRunPolling();
}

let runPollTimer: number | null = null;

function ensureRunPolling(): void {
  if (runPollTimer !== null) return;
  runPollTimer = window.setInterval(() => {
    void loadRunState();
  }, 2000);
}

function stopRunPolling(): void {
  if (runPollTimer === null) return;
  window.clearInterval(runPollTimer);
  runPollTimer = null;
}

onUnmounted(stopRunPolling);

/** 运行中的目标摘要（卡片上的「运行中 · 前端 :5173」用） */
function runningTargets(project: ProjectDto) {
  const overview = runOverviews.value[project.id];
  if (!overview) return [];
  return overview.targets.filter((target) => target.state?.status === 'running');
}

/** 「前端 :5173 · 后端 :3000」 */
function runningSummary(project: ProjectDto): string {
  const running = runningTargets(project);
  if (running.length === 0) return '';
  return `（${running
    .map((target) => `${target.role === 'frontend' ? '前端' : '后端'} :${target.state?.port ?? target.port}`)
    .join('　')}）`;
}

/** 还没启动时，告诉用户"会起什么"（免得点了才发现是别的东西） */
function runTargetsSummary(project: ProjectDto): string {
  const overview = runOverviews.value[project.id];
  if (!overview) return '';
  return overview.targets
    .map(
      (target) =>
        `${target.role === 'frontend' ? '前端' : '后端'} ${target.kindLabel} :${target.port}`,
    )
    .join('　');
}

/**
 * 运行中时可以用浏览器打开的地址。
 *
 * 只有"真的在跑"才给这个入口 —— 它同时也是**"程序真的起来了"的证据**：
 * 点一下能看到页面，而不是只看到状态变成了"运行中"。
 */
function runningBrowserUrl(project: ProjectDto): string {
  const running = runningTargets(project);
  const target = running.find((item) => item.role === 'frontend') ?? running[0];
  if (!target) return '';
  /*
   * **不再自己拼 `http://127.0.0.1:<port>`**。
   *
   * 那是这次的 bug：Vite 默认绑 `localhost`，在这台机器上解析成 `::1`（IPv6 回环），
   * 而 127.0.0.1 上什么都没有 —— 用户点了"在浏览器里打开"，看到的是"无法连接"，
   * 现象就是"没启动"，而我们这边状态显示得好好的。
   *
   * 现在地址来自**服务端从进程输出里学到的、并且真的探测通了的**那个
   * （`url` + `reachable`）。探测没通过就**不给这个入口** —— 宁可没有，
   * 也不给一个打不开的链接。
   */
  const state = target.state;
  if (!state || !state.reachable || !state.url) return '';
  return state.url;
}

/** 交给系统浏览器打开（主进程的 setWindowOpenHandler 会走 shell.openExternal） */
function openRunning(project: ProjectDto, event: Event): void {
  event.stopPropagation();
  const url = runningBrowserUrl(project);
  if (url.length === 0) return;
  window.open(url, '_blank');
}

/** 在跑、但地址还没探测通（第一次启动 Vite 要预构建依赖） */
function runningStarting(project: ProjectDto): boolean {
  const running = runningTargets(project);
  if (running.length === 0) return false;
  return running.some((target) => target.state?.reachable !== true);
}

/* ------------------------------------------------------------------ */
/* 运行输出面板：点「运行中」标记打开                                    */
/* ------------------------------------------------------------------ */

/**
 * 为什么需要一个能看输出的地方：
 *
 * 用户点了启动、界面显示「运行中」，然后**什么都看不到** —— 程序有没有真跑起来？
 * 为什么打不开？日志在哪？这次"没有正常启动"就是这么发生的：
 * 地址拼错了，界面上没有任何地方能看出真相（Vite 的输出里其实写着它自己的地址）。
 * 所以输出必须能看到，而且要能就地停止。
 */
const runPanelProject = ref<ProjectDto | null>(null);

/**
 * 装依赖：**这是原来那条死胡同的出口**。
 *
 * 启动时如果依赖没装好会被挡下（"先跑一次安装依赖"），但界面上当时**没有任何地方能装** ——
 * 提示指不到任何操作，用户只能干等。现在装了依赖就在这里跑，进度与输出就在运行面板里。
 */
/**
 * 装依赖：**这是原来那条死胡同的出口**。
 *
 * 启动时依赖没装好会被挡下（提示写着"先跑一次安装依赖"），但界面上原来**没有任何地方能装** ——
 * 提示指不到任何操作。现在装依赖就在运行面板里跑，进度与输出都在那儿。
 *
 * 作业 id 存在状态里（不是另一个 ref）：这样"哪次安装"和"它的进度"永远是一对，
 * 不会出现"面板上显示的是上一次安装的进度"。
 */
const installState = ref<{
  projectId: string;
  jobId: string;
  percent: number;
  phase: string;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  logs: string[];
} | null>(null);

/** 面板打开时的自动跟随（1.2 秒一次）：让输出像终端一样往下走 */
let runPanelTimer: number | null = null;
const runLogEl = ref<HTMLElement | null>(null);

function ensureRunPanelPolling(): void {
  if (runPanelTimer !== null) return;
  runPanelTimer = window.setInterval(async () => {
    const project = runPanelProject.value;
    if (!project) return;
    await refreshRunOverview(project.id);
    const install = installState.value;
    if (install && install.status === 'running') await followInstall(install.jobId);
    // 输出滚到底（像终端一样）
    const el = runLogEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }, 1200);
}

function stopRunPanelPolling(): void {
  if (runPanelTimer === null) return;
  window.clearInterval(runPanelTimer);
  runPanelTimer = null;
}

async function closeRunPanel(): Promise<void> {
  stopRunPanelPolling();
  runPanelProject.value = null;
}

/** 跑过或失败过（有状态可看）—— 决定卡片上要不要出现「运行详情」那一格 */
function hasRunState(project: ProjectDto): boolean {
  const overview = runOverviews.value[project.id];
  if (!overview) return false;
  return overview.targets.some((target) => target.state !== null);
}

/** 某个项目是不是有目标缺依赖（缺就把"装依赖"入口显示出来：**只在需要时出现**） */
function needsInstall(project: ProjectDto): boolean {
  const overview = runOverviews.value[project.id];
  if (!overview) return false;
  return overview.targets.some((target) => !target.ready);
}

function installHint(project: ProjectDto): string {
  const overview = runOverviews.value[project.id];
  const problems = (overview?.targets ?? [])
    .filter((target) => !target.ready && target.problem)
    .map((target) => `${target.role === 'frontend' ? '前端' : '后端'}：${target.problem}`);
  return problems.join('；') || '这个项目的依赖还没装好';
}

/**
 * 启动依赖安装（复用服务端已有的 install 作业）。
 *
 * 模板 id 用**服务端探测出来的那个**（`target.templateId`），不在界面里按 kind 猜 ——
 * 猜错的后果很具体：给 Vue 项目装上 FastAPI 的依赖、或者装到错误的子目录。
 */
async function startInstall(project: ProjectDto, event: Event): Promise<void> {

  event.stopPropagation();
  const overview = runOverviews.value[project.id];
  /*
   * 拿不到概况时**要说出来**。
   * 第一版这里直接 `return`（静默早退）—— 结果"点了装依赖什么都没发生"，
   * 无论对用户还是对排查都是最坏的一种表现。
   */
  if (!overview || overview.targets.length === 0) {
    await refreshRunOverview(project.id);
    const retry = runOverviews.value[project.id];
    if (!retry || retry.targets.length === 0) {
      feedback.failure(new Error('拿不到这个项目的运行概况（可能还没探测完），请稍后再试'), '安装依赖');
      return;
    }
  }
  const ready = runOverviews.value[project.id]!;
  try {
    const job = await jobsApi.enqueue('install', {
      projectId: project.id,
      targets: ready.targets.map((target) => ({ templateId: target.templateId })),
    });
    installState.value = {
      projectId: project.id,
      jobId: job.id,
      percent: 0,
      phase: '排队中',
      status: 'running',
      error: null,
      logs: [],
    };
    runPanelProject.value = project;
    ensureRunPanelPolling();
    await followInstall(job.id);
  } catch (error) {
    feedback.failure(error, '启动安装失败');
  }
}

/** 跟着安装作业读进度与日志（与向导里那套同一个接口用法） */
async function followInstall(jobId: string): Promise<void> {
  const current = installState.value;
  if (!current || current.jobId !== jobId) return;
  try {
    const [job, logs] = await Promise.all([
      jobsApi.get(jobId),
      jobsApi.logs(jobId, { afterTs: 0, limit: 200 }),
    ]);
    const running =
      job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'canceled' && job.status !== 'interrupted';
    installState.value = {
      ...current,
      percent: job.percent,
      phase: job.phase ?? '安装中',
      status: job.status === 'succeeded' ? 'succeeded' : running ? 'running' : 'failed',
      error: job.errorMessage ?? (job.status === 'canceled' ? '安装被取消' : null),
      logs: logs.items.map((entry) => entry.message),
    };
    if (!running) {
      // 装完（或失败）都要重拉概况：ready 变了，卡片上的启动按钮才会跟着变可用/不可用
      await refreshRunOverview(current.projectId);
    }
  } catch {
    // 读不到就等下一次轮询
  }
}
/** 重新拉一次某个项目的运行概况（面板打开时、启动/停止之后、安装结束之后都调它） */
async function refreshRunOverview(projectId: string): Promise<void> {
  try {
    const overview = await projectsApi.run(projectId);
    runOverviews.value = { ...runOverviews.value, [projectId]: overview };
  } catch {
    // 拿不到就保持原样（面板里的"刷新"按钮还能手动来一次）
  }
}

/** 打开运行面板（这是"没启动 / 打不开"时的唯一查错入口） */
async function openRunPanel(project: ProjectDto, event: Event): Promise<void> {
  event.stopPropagation();
  runPanelProject.value = project;
  await refreshRunOverview(project.id);
  ensureRunPanelPolling();
}

const runPanelOverview = computed(() =>
  runPanelProject.value ? runOverviews.value[runPanelProject.value.id] : undefined,
);

function targetSummary(project: ProjectDto): string {
  const overview = runOverviews.value[project.id];
  if (!overview) return '';
  const running = overview.targets.filter((target) => target.state?.status === 'running');
  if (running.length > 0) {
    return running
      .map((target) => `${target.role === 'frontend' ? '前端' : '后端'} :${target.state?.port ?? target.port}`)
      .join(' · ');
  }
  return '';
}

/** 启动：认不出目标/依赖没装好都会被服务端挡下，错误原因原样转达 */
async function startProject(project: ProjectDto, event: Event): Promise<void> {
  event.stopPropagation();
  runBusy.value = new Set([...runBusy.value, project.id]);
  try {
    await projectsApi.startRun(project.id);
    feedback.info(`已启动「${project.name}」`);
  } catch (error) {
    feedback.failure(error, '启动失败');
  } finally {
    runBusy.value = new Set([...runBusy.value].filter((id) => id !== project.id));
    await loadRunState();
  }
}

async function stopProject(project: ProjectDto, event: Event): Promise<void> {
  event.stopPropagation();
  runBusy.value = new Set([...runBusy.value, project.id]);
  try {
    await projectsApi.stopRun(project.id);
    feedback.info(`已停止「${project.name}」`);
  } catch (error) {
    feedback.failure(error, '停止失败');
  } finally {
    runBusy.value = new Set([...runBusy.value].filter((id) => id !== project.id));
    await loadRunState();
  }
}

/**
 * 打开项目 → 进「工作台」。
 *
 * 这里落哪一页是个产品判断：总览是"看情况"，工作台是"干活"。
 * 用户明确要求点项目卡片进工作台 —— 进项目的第一意图是处理任务，
 * 想看进度再点一下「总览」即可。
 */
async function open(project: ProjectDto): Promise<void> {
  await board.selectProject(project.id);
  void router.push({ name: 'workbench' });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 详细到分钟的时间（回收站里要看清"什么时候被删的"）。
 *
 * 日期用 `toLocaleDateString` 会丢掉时分，而回收站里同一天可能删了好几个项目，
 * 只显示日期没法区分顺序；另外这里是**本地时间**，与用户看钟的习惯一致。
 */
function formatTime(ts: number | null): string {
  if (ts === null) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <!-- `data-view` 是给 E2E 的语义标记：判断"路由内容真的挂载了"（约定见 docs/technical-design.md 的 E2E 一节） -->
  <div class="page" data-view="projects">
    <header class="page-head">
      <div>
        <h1>项目</h1>
        <p class="faint sub">
          共 {{ all.length }} 个项目{{ includeArchived ? '（含已归档）' : '' }}
        </p>
      </div>

      <div class="head-actions">
        <NButton
          size="small"
          quaternary
          :type="includeArchived ? 'primary' : 'default'"
          @click="((includeArchived = !includeArchived), reload())"
        >
          {{ includeArchived ? '隐藏已归档' : '显示已归档' }}
        </NButton>
        <NButton size="small" quaternary data-field="trash-open" @click="openTrash">
          <template #icon><AppIcon name="trash" :size="14" /></template>
          回收站
        </NButton>
        <NButton type="primary" @click="openCreate">
          <template #icon><AppIcon name="plus" :size="15" /></template>
          新建项目
        </NButton>
      </div>
    </header>

    <div v-if="loading && all.length === 0" class="grid">
      <div v-for="i in 4" :key="i" class="project-card">
        <NSkeleton height="18px" width="55%" style="margin-bottom: 10px" />
        <NSkeleton height="13px" width="80%" style="margin-bottom: 6px" />
        <NSkeleton height="13px" width="40%" />
      </div>
    </div>

    <EmptyState
      v-else-if="all.length === 0"
      class="empty"
      text="还没有项目"
      hint="点击「新建项目」开始；可先创建一个纯管理项目试用"
      action="新建项目"
      @action="openCreate"
    />

    <div v-else class="grid">
      <article
        v-for="project in all"
        :key="project.id"
        class="project-card"
        :data-project-card="project.id"
        :class="{
          archived: project.status === 'archived',
          active: board.currentProjectId === project.id,
          'is-running': runningProjectIds.has(project.id),
        }"
        :title="`点击打开「${project.name}」的看板`"
        tabindex="0"
        role="button"
        @click="onCardClick(project, $event)"
        @keydown.enter.prevent="open(project)"
        @keydown.space.prevent="open(project)"
      >
        <div class="card-head">
          <span class="swatch" :style="{ background: project.color }" />
          <button class="card-title" @click="open(project)">{{ project.name }}</button>
          <NTag v-if="project.codeKind" size="tiny" :bordered="false">
            {{ TYPE_LABEL[project.codeKind] ?? project.codeKind }}
          </NTag>
          <NTag v-if="project.status === 'archived'" size="tiny" :bordered="false">已归档</NTag>
          <!--
            运行中时点这个标记就能打开运行面板（看地址、输出、就地停止）。
            操作区里还有一个「运行详情」按钮是同样的入口 —— 一个给顺手点，一个给"找按钮"的人。
          -->
          <NTag
            v-if="runningProjectIds.has(project.id)"
            size="tiny"
            type="info"
            :bordered="false"
            :data-running="project.id"
            class="running-tag"
            :title="`${targetSummary(project) || '正在运行'} —— 点击查看启动输出`"
            @click="openRunPanel(project, $event)"
          >
            运行中{{ targetSummary(project) ? ` · ${targetSummary(project)}` : '' }}
          </NTag>
          <NTag v-if="board.currentProjectId === project.id" size="tiny" type="primary" :bordered="false">
            当前
          </NTag>
        </div>

        <p class="card-desc">{{ project.description || '（无描述）' }}</p>

        <!--
          显示"项目文件夹"而不是代码目录：0.1.2 起一个项目 = 工作区里的一个文件夹，
          代码、附件、日志都在里面。代码放在别处时（codePath）另起一行说明。
        -->
        <div v-if="project.folder" class="card-path mono" :title="`工作区里的文件夹：${project.folder}`">
          <AppIcon name="folder" :size="11" />
          <span class="folder-name">{{ project.folder }}</span>
          <span class="faint">/</span>
        </div>
        <div v-else class="card-path faint">（尚无文件夹，重启应用后补建）</div>

        <div v-if="project.codePath" class="card-path faint mono" :title="`代码目录：${project.codePath}`">
          代码：{{ project.codePath }}
        </div>

        <!--
          关系链（需求 §5.2.1）：卡片上只显示"有关系的项目名 + 关系的名字"，
          点开项目之后在总览里能加能删。这里**不在卡片上做操作** ——
          卡片是"扫一眼"的地方，两个下拉加按钮会把它挤爆。
        -->
        <div
          v-if="relationSummary[project.id]"
          class="card-relations"
          :data-relations-for="project.id"
          :title="`关系：${relationSummary[project.id]!.labels.join('、')}`"
        >
          <AppIcon name="link" :size="11" />
          <span v-for="label in relationSummary[project.id]!.labels.slice(0, 2)" :key="label" class="rel-chip">
            {{ label }}
          </span>
          <span class="faint">共 {{ relationSummary[project.id]!.count }} 条</span>
        </div>

        <div class="card-foot">
          <span class="faint tiny">创建于 {{ formatDate(project.createdAt) }}</span>
          <div class="ops">

            <NTooltip trigger="hover">
              <template #trigger>
                <NButton size="tiny" quaternary @click="revealFolder(project)">
                  <template #icon><AppIcon name="external" :size="13" /></template>
                </NButton>
              </template>
              在资源管理器中打开项目文件夹
            </NTooltip>
            <!--
              「用编辑器打开」已实现：主进程按白名单把偏好里的编辑器命令解析成真实 exe
              再启动（不经 shell）。
            -->
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton size="tiny" quaternary @click="openInEditor(project)">
                  <template #icon><AppIcon name="terminal" :size="13" /></template>
                </NButton>
              </template>
              用编辑器打开（编辑器在偏好设置里的 editorCommand 指定）
            </NTooltip>
            <!--
              启动 / 停止 —— **位置就是这里**（原来是这个位置的禁用占位，提示写着
              "等作业系统（M4）接入后可用"；现在它真的能用了）。

              只有**前端 / 后端 / 前后端**项目有这一格：判据是服务端的 `runnable`
              （纯管理项目没有代码 → false），不是界面自己按类型猜。
              没拿到概况（请求失败）时**不显示**：一个不知道状态的按钮比没有更糟。
            -->
            <NTooltip v-if="runOverviews[project.id]" trigger="hover">
              <template #trigger>
                <NButton
                  v-if="!runningProjectIds.has(project.id)"
                  size="tiny"
                  quaternary
                  :loading="runBusy.has(project.id)"
                  :disabled="!runOverviews[project.id]!.runnable"
                  :data-run-start="project.id"
                  @click="startProject(project, $event)"
                >
                  <template #icon><AppIcon name="play" :size="13" /></template>
                </NButton>
                <NButton
                  v-else
                  size="tiny"
                  quaternary
                  type="warning"
                  :loading="runBusy.has(project.id)"
                  :data-run-stop="project.id"
                  @click="stopProject(project, $event)"
                >
                  <template #icon><AppIcon name="stop" :size="13" /></template>
                </NButton>
              </template>
              <template v-if="!runOverviews[project.id]!.runnable">
                {{ runOverviews[project.id]!.problems.join('；') || '这个项目没有可启动的目标' }}
              </template>
              <template v-else-if="runningProjectIds.has(project.id)">
                停止{{ runningSummary(project) }}
              </template>
              <template v-else>
                启动开发服务器{{ '（' + runTargetsSummary(project) + '）' }}
              </template>
            </NTooltip>

            <!--
              运行详情：跑过（或失败过）之后一直留着这一格 —— 里面能看到真实地址、
              启动输出与失败原因，也是"装依赖"和"停止"的就地入口。
            -->
            <NTooltip v-if="hasRunState(project)" trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  :data-run-panel="project.id"
                  @click="openRunPanel(project, $event)"
                >
                  <template #icon><AppIcon name="rows" :size="13" /></template>
                </NButton>
              </template>
              运行详情（地址 / 输出 / 停止）
            </NTooltip>

            <!--
              装依赖：**只在缺依赖时出现**（其余时候没有这一格 —— 不摆常驻按钮）。
              它解决的是原来那条死胡同：启动被挡下说"先装依赖"，而界面上没地方装。
            -->
            <NTooltip v-if="needsInstall(project)" trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  type="warning"
                  :data-run-install="project.id"
                  @click="startInstall(project, $event)"
                >
                  <template #icon><AppIcon name="download" :size="13" /></template>
                </NButton>
              </template>
              {{ installHint(project) }} —— 点击安装依赖
            </NTooltip>

            <!--
              运行中给一个"在浏览器里打开"的入口：**点了能看到程序真的在跑**，
              而不是只有状态变了。地址就是本机端口（http://127.0.0.1:<port>），
              由主进程交给系统浏览器打开（不在应用内开窗口）。
            -->
            <!-- 起来了但还连不上（多半在编译）：如实说"还在启动"，而不是给个打不开的链接 -->
            <NTooltip v-if="runningStarting(project)" trigger="hover">
              <template #trigger>
                <NButton size="tiny" quaternary disabled :data-run-waiting="project.id">
                  <template #icon><AppIcon name="refresh" :size="13" /></template>
                </NButton>
              </template>
              正在加载中
            </NTooltip>

            <NTooltip v-if="runningBrowserUrl(project)" trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  type="info"
                  :data-run-open="project.id"
                  @click="openRunning(project, $event)"
                >
                  <template #icon><AppIcon name="external" :size="13" /></template>
                </NButton>
              </template>
              在浏览器里打开 {{ runningBrowserUrl(project) }}
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton size="tiny" quaternary @click="toggleArchive(project)">
                  <template #icon><AppIcon name="folder" :size="13" /></template>
                </NButton>
              </template>
              {{ project.status === 'archived' ? '取消归档' : '归档' }}
            </NTooltip>
            <NTooltip trigger="hover">              <template #trigger>
                <NButton size="tiny" quaternary data-field="project-remove" @click="remove(project)">
                  <template #icon><AppIcon name="trash" :size="13" /></template>
                </NButton>
              </template>
              删除（需确认）
            </NTooltip>
          </div>
        </div>
      </article>
    </div>

    <!--
      运行面板：这是"启动失败/打不开"时唯一能查的地方。
      内容都是服务端给的事实：状态、命令、**真实地址与是否连通**、启动输出。
    -->
    <NModal
      :show="runPanelProject !== null"
      preset="card"
      class="run-panel"
      :style="{ width: RUN_PANEL_WIDTH }"
      :title="`运行状态：${runPanelProject?.name ?? ''}`"
      @update:show="(value: boolean) => !value && (runPanelProject = null)"
    >
      <template v-if="runPanelProject && runPanelOverview">
        <div v-if="!runPanelOverview.runnable" class="run-problem">
          {{ runPanelOverview.problems.join('；') || '这个项目没有可启动的目标' }}
        </div>

        <!--
          安装进度与输出：**项目级的一块**，放在目标循环外面（放里面会每个目标渲染一遍）。
          条件用 `?.`：面板关闭的那一瞬间状态可能还在，直接读 `runPanelProject.id`
          会抛 "Cannot read properties of undefined (reading 'id')" —— 实测就这样
          （每 1.2 秒的轮询把它刷成一屏报错）。
        -->
        <div
          v-if="installState && installState.projectId === runPanelProject?.id"
          class="run-install"
          :data-run-install-for="runPanelProject?.id"
        >
          <NProgress
            type="line"
            :percentage="installState.percent"
            :height="5"
            :status="installState.status === 'failed' ? 'error' : installState.status === 'succeeded' ? 'success' : 'info'"
          />
          <span class="faint tiny">
            {{ installState.status === 'running'
              ? `正在安装依赖：${installState.phase}`
              : installState.status === 'succeeded'
                ? '依赖已装好'
                : `安装失败：${installState.error ?? '未给出原因'}` }}
          </span>
          <pre class="run-log" data-run-install-log="all">{{ installState.logs.join('\n') || '（还没有输出）' }}</pre>
        </div>
        <div
          v-for="target in runPanelOverview.targets"
          :key="target.role"
          class="run-target"
          :data-run-target="`${runPanelProject?.id}:${target.role}`"
        >
          <div class="run-head">
            <strong>{{ target.role === 'frontend' ? '前端' : '后端' }} · {{ target.kindLabel }}</strong>
            <span class="faint">端口 {{ target.state?.port ?? target.port }}</span>
            <NTag v-if="target.state" size="tiny" :bordered="false" :type="target.state.status === 'running' ? 'info' : target.state.status === 'failed' ? 'error' : 'default'">
              {{ target.state.status === 'running' ? '运行中' : target.state.status === 'failed' ? '已失败' : target.state.status }}
            </NTag>
            <span v-if="target.state?.reachable" class="ok-text">地址已连通</span>
            <span v-else-if="target.state?.status === 'running'" class="faint">正在加载中</span>
            <NButton
              v-if="target.state?.status === 'running'"
              size="tiny"
              quaternary
              type="warning"
              @click="stopProject(runPanelProject!, $event)"
            >
              停止
            </NButton>
            <NButton
              v-else-if="target.ready"
              size="tiny"
              quaternary
              @click="startProject(runPanelProject!, $event)"
            >
              启动
            </NButton>
          </div>

          <div v-if="target.state?.error" class="run-error">{{ target.state.error }}</div>
          <div v-else-if="!target.ready && target.problem" class="run-problem">
            {{ target.problem }}
            <NButton
              size="tiny"
              type="warning"
              secondary
              class="run-install-btn"
              :data-run-install-panel="runPanelProject?.id"
              @click="startInstall(runPanelProject!, $event)"
            >
              安装依赖
            </NButton>
          </div>



          <p v-if="target.state?.url" class="run-url mono">
            地址：{{ target.state.url }}{{ target.state.reachable ? '' : '（尚未连通）' }}
          </p>
          <p v-if="target.state?.command" class="faint mono run-cmd">命令：{{ target.state.command }}</p>

          <pre ref="runLogEl" class="run-log" :data-run-log="target.role">{{ (target.state?.log ?? [])
            .map((line) => line.text)
            .join('\n') || '（还没有输出）' }}</pre>
        </div>
      </template>
      <template #footer>
        <div class="run-foot">
          <span class="faint tiny">此处输出可确认程序是否已实际启动</span>
          <NButton size="small" quaternary @click="runPanelProject && refreshRunOverview(runPanelProject.id)">
            刷新
          </NButton>
          <NButton size="small" @click="closeRunPanel">关闭</NButton>
        </div>
      </template>
    </NModal>

    <!-- ================= 回收站 ================= -->
    <!--
      回收站里放的是**已软删除**的项目：它们不在项目列表里，也不会出现在工作大纲、
      今日待办、搜索里（那些查询本来就过滤掉了软删除的项目）。
      两个动作：还原（回到项目列表）与彻底删除（应用里的数据真删）。
      面板结构与项目页其它弹窗一致：NModal + 我们自己模板里的 NCard，
      这样 scoped 样式能生效（`preset="card"` 的写法拿不到 data-v 属性，踩过）。
    -->
    <NModal :show="showTrash" @update:show="(value: boolean) => (showTrash = value)">
      <NCard
        class="trash-dialog"
        title="回收站"
        :bordered="false"
        size="small"
        role="dialog"
        aria-modal="true"
        data-field="trash-panel"
      >
        <p class="faint trash-hint">
          此处项目已从项目列表移除，也不参与工作大纲、今日待办与搜索。可还原，或彻底删除（彻底删除仅清除应用内数据，磁盘上的项目文件夹保留）。
        </p>

        <div v-if="trashLoading" class="trash-empty">
          <NSpin size="small" />
        </div>

        <EmptyState
          v-else-if="trashItems.length === 0"
          class="trash-empty"
          compact
          text="回收站是空的"
          hint="删除的项目会先移入此处，可随时还原"
        />

        <ul v-else class="trash-list">
          <li
            v-for="item in trashItems"
            :key="item.id"
            class="trash-item"
            data-field="trash-item"
            :data-project-id="item.id"
          >
            <div class="trash-main">
              <div class="trash-name" data-field="trash-name">{{ item.name }}</div>
              <div class="faint trash-meta">
                移入回收站：{{ formatTime(item.deletedAt) }}
                <template v-if="item.folder">· 文件夹：{{ item.folder }}（保留）</template>
              </div>
            </div>
            <div class="trash-actions">
              <NButton
                size="small"
                :loading="trashBusy === item.id"
                data-field="trash-restore"
                @click="restoreFromTrash(item)"
              >
                还原
              </NButton>
              <NButton
                size="small"
                quaternary
                type="error"
                :loading="trashBusy === item.id"
                data-field="trash-purge"
                @click="purgeFromTrash(item)"
              >
                彻底删除
              </NButton>
            </div>
          </li>
        </ul>

        <template #footer>
          <div class="trash-foot">
            <span class="faint tiny">共 {{ trashItems.length }} 个</span>
            <!--
              一键清空：回收站里有东西时才可点（空的时候是个没用的危险按钮，
              比"灰着"更容易误点）。位置放在"刷新"左边、用危险色，与每一项上的
              「彻底删除」是同一类动作。
            -->
            <NButton
              size="small"
              type="error"
              secondary
              :disabled="trashItems.length === 0"
              :loading="purgingAll"
              data-field="trash-purge-all"
              @click="purgeAllFromTrash"
            >
              清空回收站
            </NButton>
            <NButton size="small" quaternary :loading="trashLoading" @click="loadTrash">
              刷新
            </NButton>
            <NButton size="small" data-field="trash-close" @click="showTrash = false">关闭</NButton>
          </div>
        </template>
      </NCard>
    </NModal>

    <!-- ================= 新建项目向导（M4：检测 → 骨架 → 装依赖） ================= -->
    <ProjectWizard v-model:show="showCreate" @created="onCreated" />
  </div>
</template>

<style scoped>
.page {
  padding: 20px 22px 60px;
  /*
    刻意**不设 max-width**：这个页面是"卡片网格"，窗口拉宽时应当多排几列把宽度用满。
    之前写了 max-width: 1100px，于是在宽窗口下右侧留出一大片空白，
    连顶部的按钮也跟着停在 1100px 处、看着不像右对齐。
    （长文本的阅读型页面才需要限宽，网格不需要。）
  */
  width: 100%;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

h1 {
  font-size: 18px;
  margin: 0 0 2px;
}

.sub {
  margin: 0;
  font-size: 12px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

/* ---------- 运行面板 ---------- */

.run-install-btn {
  margin-left: 8px;
}

.run-install {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.running-tag {
  cursor: pointer;
}

/*
 * 运行面板的宽度**不在这里**：`preset="card"` 的 NModal 生成的节点拿不到 scoped 属性，
 * 写在 scoped 块里的宽度规则是死规则。宽度改用 `:style` 内联（见 RUN_PANEL_WIDTH 的注释）。
 */

.run-target {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0;
}

.run-target + .run-target {
  border-top: 1px solid var(--pm-border);
}

.run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.run-error {
  color: var(--pm-danger);
  font-size: 12px;
  line-height: 1.6;
}

.run-problem {
  color: var(--pm-text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.run-url,
.run-cmd {
  margin: 0;
  font-size: 12px;
}

/* 启动输出：等宽、可滚、限高（够看启动横幅与报错，又不占满整屏） */
.run-log {
  margin: 0;
  padding: 8px 10px;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  background: var(--pm-sunken);
  color: var(--pm-text);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.run-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}

.run-foot .faint {
  margin-right: auto;
}

/* 关系链标记：淡一点，它是"补充信息"而不是卡片的主角 */
.card-relations {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--pm-text-muted);
  flex-wrap: wrap;
}

.rel-chip {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--pm-sunken);
  color: var(--pm-text);
}

.project-card {
  border: 1px solid var(--pm-border);
  background: var(--pm-surface);
  border-radius: 10px;
  padding: 14px;
  display: grid;
  gap: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  /* 整张卡片可点：给出明确的手势与键盘可达性 */
  cursor: pointer;
}

.project-card:hover {
  border-color: var(--pm-border-strong);
  box-shadow: var(--pm-shadow);
  transform: translateY(-1px);
}

/* 键盘 Tab 过来时的焦点环：卡片是 role="button"，不能只有鼠标能用 */
.project-card:focus-visible {
  outline: 2px solid var(--pm-accent);
  outline-offset: 2px;
}

.project-card:active {
  transform: translateY(0);
}

.project-card.active {
  border-color: var(--pm-accent);
}

.project-card.archived {
  opacity: 0.62;
}

/*
  「运行中」的蓝色光晕 —— 预留给 M4 的启动/停止功能：
  真正的运行状态要由作业系统给出，这里先把可视反馈做好（一圈蓝光 + 呼吸感），
  等作业接进来只要往 runningProjectIds 里塞 id 就能亮起来。
*/
.project-card.is-running {
  border-color: var(--pm-accent);
  animation: project-running-glow 2.2s ease-in-out infinite;
}

@keyframes project-running-glow {
  0%,
  100% {
    box-shadow: 0 0 0 1px var(--pm-accent), 0 0 10px 0 var(--pm-accent-soft);
  }
  50% {
    box-shadow: 0 0 0 1px var(--pm-accent), 0 0 18px 3px var(--pm-accent-soft);
  }
}

/* 用户在系统里关掉了动画就不要呼吸，只留静态光晕 */
@media (prefers-reduced-motion: reduce) {
  .project-card.is-running {
    animation: none;
    box-shadow: 0 0 0 1px var(--pm-accent), 0 0 14px 2px var(--pm-accent-soft);
  }
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.swatch {
  width: 10px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
}

.card-title {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--pm-text);
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.card-title:hover {
  color: var(--pm-accent);
}

.card-desc {
  margin: 0;
  font-size: 12px;
  color: var(--pm-text-muted);
  min-height: 34px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card-path {
  font-size: 11px;
  color: var(--pm-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid var(--pm-border);
  padding-top: 8px;
}

.ops {
  display: flex;
  gap: 2px;
}

.empty {
  margin-top: 40px;
}

/* ---------------- 弹窗 ---------------- */

.create-dialog {
  width: min(620px, calc(100vw - 60px));
}

/* ---------------- 回收站 ---------------- */

/* 与新建弹窗同宽：一屏能看清名字、时间和两个按钮 */
.trash-dialog {
  width: min(620px, calc(100vw - 60px));
}

.trash-hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
}

.trash-empty {
  display: flex;
  justify-content: center;
  padding: 18px 0;
}

/* 列表：一维排布 → flex 列（每项内部再横排"信息 + 按钮"） */
.trash-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  /* 回收站可能攒了几十个项目：限高并自己滚动，面板不会长到超出屏幕 */
  max-height: 44vh;
  overflow-y: auto;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border: 1px solid var(--pm-border);
  border-radius: 8px;
  background: var(--pm-surface);
}

.trash-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.trash-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-meta {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.trash-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.trash-foot .tiny {
  margin-right: auto;
}

.dialog-body {
  display: grid;
  gap: 16px;
}

.field-block {
  display: grid;
  gap: 10px;
}

.block-label {
  font-size: 12px;
  color: var(--pm-text-muted);
}

.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.type-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--pm-border);
  border-radius: 8px;
  background: var(--pm-surface);
  color: var(--pm-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.type-card:hover {
  border-color: var(--pm-border-strong);
  background: var(--pm-raised);
}

.type-card.selected {
  border-color: var(--pm-accent);
  background: var(--pm-accent-soft);
}

.type-icon {
  color: var(--pm-text-muted);
  display: flex;
  flex-shrink: 0;
}

.type-card.selected .type-icon {
  color: var(--pm-accent);
}

.type-text {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.type-label {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pending-tag {
  transform: scale(0.9);
}

.type-summary {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-detail {
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.scaffold-note {
  font-size: 12px;
}

.field {
  display: grid;
  gap: 5px;
}

.field-label {
  font-size: 12px;
  color: var(--pm-text-muted);
}

.field-label em {
  color: var(--pm-danger);
  font-style: normal;
}

.field-row {
  display: grid;
  grid-template-columns: 168px 1fr;
  gap: 10px;
  align-items: start;
}

.color-picker {
  width: 100%;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.footer-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.faint {
  color: var(--pm-text-faint);
}

.tiny {
  font-size: 11px;
}

.mono {
  font-family: 'Cascadia Mono', Consolas, monospace;
}
</style>
