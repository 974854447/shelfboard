<script setup lang="ts">
/**
 * 新建项目向导（M4）。
 *
 * 用户的要求很明确：「我不想把这个单独做一个模块，我希望的是**在创建项目的时候**就执行
 * 环境检测，并下载相关依赖与脚手架」。所以这一版把三件事串进"创建项目"这一个动作里：
 *
 * 1. **环境检测**（必需工具齐不齐）——不通过就停下并说清缺什么，不往下走；
 * 2. **生成代码骨架**（内置模板，离线可用）；
 * 3. **安装依赖**（Node 用 pnpm/npm，Python 建 venv 再 pip）——**可以取消勾选**。
 *
 * 进度与日志就显示在这个弹窗里，而不是让用户去另一个页面看：创建项目是**一个连续的动作**，
 * 中途跳页会让人以为"是不是失败了"。底层仍然走作业执行器（排队、取消、日志、崩溃恢复
 * 都是它的活），只是**不再对外是一个模块**。
 *
 * 每一步的失败都停在那一步并给出可操作的原因（缺哪个工具 / 网络问题 / 退出码），
 * 已经完成的步骤保留结果 —— 重试时不必从头再来一遍。
 */

import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NColorPicker,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NTag,
} from 'naive-ui';
import { computed, ref, watch } from 'vue';

import AppIcon, { type IconName } from './AppIcon.vue';
import { jobs as jobsApi, projects as projectsApi, type JobLogDtoPayload } from '../api/endpoints';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; created: [projectId: string] }>();

const board = useBoardStore();
const feedback = useFeedback();

/* ---------------- 项目类型与技术栈 ---------------- */

type Kind = 'managed' | 'frontend' | 'backend' | 'fullstack';

interface ProjectType {
  kind: Kind;
  label: string;
  summary: string;
  icon: IconName;
}

/**
 * 四种项目类型（沿用原来的四张卡片）。
 *
 * 与之前不同的是：**它现在真的会生成代码**，而不再是一句"等 M4 上线后再执行生成"。
 */
const PROJECT_TYPES: ProjectType[] = [
  {
    kind: 'managed',
    label: '纯管理项目',
    summary: '不生成代码，仅管理任务',
    icon: 'folder',
  },
  {
    kind: 'frontend',
    label: '仅前端项目',
    summary: '生成前端代码',
    icon: 'board',
  },
  {
    kind: 'backend',
    label: '仅后端项目',
    summary: '生成后端代码',
    icon: 'terminal',
  },
  {
    kind: 'fullstack',
    label: '前后端项目',
    summary: '前端 + 后端两套代码',
    icon: 'hex',
  },
];

/* ---------------- 步骤 ---------------- */

type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

interface Step {
  key: 'env' | 'create' | 'scaffold' | 'install' | 'template';
  label: string;
  status: StepStatus;
  detail: string;
}

const steps = ref<Step[]>([]);
const stepIcon: Record<StepStatus, IconName> = {
  pending: 'clock',
  active: 'refresh',
  done: 'check',
  failed: 'alert',
  skipped: 'chevronRight',
};
const stepTone: Record<StepStatus, string> = {
  pending: 'faint',
  active: 'run',
  done: 'ok',
  failed: 'bad',
  skipped: 'faint',
};

/* ---------------- 表单 ---------------- */

const kind = ref<Kind>('managed');
const name = ref('');
const description = ref('');
const color = ref('#4c9aff');

type StackDimensionChoice = { id: string; label: string; hint?: string; args: string[] };
type StackDimension = {
  id: string;
  label: string;
  kind: 'choice' | 'multi';
  defaultValue: string | string[];
  choices: StackDimensionChoice[];
};
type StackInfo = {
  id: string;
  name: string;
  kind: string;
  source: string;
  needsNetwork: boolean;
  defaultPort: number;
  installKind: 'node' | 'python' | 'none';
  languageLabel: string;
  /** 这个栈对 Node 的要求（静态显示，不做控件：它是工具链的事实） */
  enginesNode?: string;
  dimensions: StackDimension[];
};

/** 一行技术栈（前端 / 后端各一行）：各自的框架、各自的维度选择、**各自的端口** */
type StackRole = 'frontend' | 'backend';
type SelectionMap = Record<string, string | string[]>;

const ROLE_LABEL: Record<StackRole, string> = { frontend: '前端', backend: '后端' };

/** 可选技术栈：来自服务端（单一来源），失败时用兜底列表 */
const stacks = ref<StackInfo[]>([]);
const frontendStack = ref('vue3');
const backendStack = ref('fastapi');
/** 装依赖默认勾上（用户要的就是"创建时就下载依赖"），断网时可以取消 */
const installDeps = ref(true);
/**
 * 铺管理侧模板（任务清单 / 里程碑 / 文档模板）。
 *
 * 默认勾上 —— 用户要的就是"**新建即非空**"；但留一个取消勾选的口子，
 * 因为"我就想从一个空项目开始"也是正当需求（这跟"装依赖"是同一类选择，不是死控件）。
 */
const applyTemplate = ref(true);
/**
 * 端口：**每个栈一个**，初值按各自栈的惯例给（Vite 5173 / NestJS 3000 / Python 8000）。
 *
 * 上一版是两块共用一个端口 —— 双栈项目生成出来 `vite.config.ts` 与 `app.listen()`
 * 是同一个号，起服务必撞号。端口本来就是栈的属性，不是"这个项目"的属性。
 */
const ports = ref<Record<StackRole, number | null>>({ frontend: 5173, backend: 8000 });
/**
 * 用户是否自己动过某一行的端口。
 *
 * 有了它，换框架时的"按惯例改端口"才不会**踩掉用户刚填的值**：
 * 先选 FastAPI、把端口改成 9000，再换成 NestJS —— 无脑跟着走会把 9000 覆盖成 3000，
 * 而用户是在"确定端口要 9000"之后才去挑框架的。
 */
const portTouched = ref<Record<StackRole, boolean>>({ frontend: false, backend: false });
/** 维度的当前选择（每个 role 一份，换框架时重置为该框架的默认值） */
const selections = ref<Record<StackRole, SelectionMap>>({ frontend: {}, backend: {} });
/** 包管理器：只有选了 Node 栈才有意义；不选就是"按机器上装了什么自动挑" */
const packageManager = ref<'auto' | 'pnpm' | 'npm' | 'yarn'>('auto');

/** 某个栈的默认选择（直接用服务端声明的默认值，不在前端写死第二份） */
function defaultsFor(stack: StackInfo | undefined): SelectionMap {
  const result: SelectionMap = {};
  for (const dimension of stack?.dimensions ?? []) {
    result[dimension.id] = Array.isArray(dimension.defaultValue)
      ? [...dimension.defaultValue]
      : dimension.defaultValue;
  }
  return result;
}

function stackById(id: string): StackInfo | undefined {
  return stacks.value.find((stack) => stack.id === id);
}

/** 某个 role 当前用的栈（先看项目类型，再看选的是哪个框架） */
function stackForRole(role: StackRole): StackInfo | undefined {
  if (role === 'frontend' && kind.value === 'backend') return undefined;
  if (role === 'backend' && kind.value === 'frontend') return undefined;
  return stackById(role === 'frontend' ? frontendStack.value : backendStack.value);
}

/** 界面上的两行：前端一行、后端一行（项目类型决定哪几行出现） */
const rows = computed(() =>
  (['frontend', 'backend'] as StackRole[])
    .map((role) => ({
      role,
      label: ROLE_LABEL[role],
      stack: stackForRole(role),
      candidates: stacks.value.filter((stack) => stack.kind === role),
    }))
    .filter((row): row is typeof row & { stack: StackInfo } => row.stack !== undefined),
);

const canSubmit = computed(() => name.value.trim().length > 0 && !running.value);
const needsScaffold = computed(() => kind.value !== 'managed');

const selectedStacks = computed(() => rows.value.map((row) => row.stack.id));
const selectedStackInfo = computed(() => rows.value.map((row) => row.stack));

/** 选了需要联网的栈就提前说清楚（"点了半天没反应"最常见的原因就是它） */
const needsNetwork = computed(() => selectedStackInfo.value.some((stack) => stack.needsNetwork));
const needsNodeInstall = computed(() =>
  selectedStackInfo.value.some((stack) => stack.installKind === 'node'),
);

/* ---------------- 维度：界面照服务端的声明渲染 ---------------- */

function dimensionOf(stack: StackInfo, id: string): StackDimension | undefined {
  return stack.dimensions.find((dimension) => dimension.id === id);
}
/**
 * 单选维度（语言）：**候选多于一个才做成控件**。
 *
 * 只有一项时渲染成静态文字 —— 一个只有一种选择的下来框是"死控件"，
 * 用户会以为自己选错了什么。这条规矩就是"界面照声明渲染"的意义所在。
 */
function choiceDimension(stack: StackInfo): StackDimension | undefined {
  const dimension = dimensionOf(stack, 'language');
  return dimension && dimension.kind === 'choice' && dimension.choices.length > 1 ? dimension : undefined;
}
function multiDimension(stack: StackInfo): StackDimension | undefined {
  const dimension = dimensionOf(stack, 'addons');
  return dimension && dimension.kind === 'multi' && dimension.choices.length > 0 ? dimension : undefined;
}
/** 版本维度：候选多于一个才做成控件（同样不做死控件） */
function versionDimension(stack: StackInfo): StackDimension | undefined {
  const dimension = dimensionOf(stack, 'version');
  return dimension && dimension.kind === 'choice' && dimension.choices.length > 1 ? dimension : undefined;
}
function selectionValue(role: StackRole, dimensionId: string): string | string[] | undefined {
  return selections.value[role]?.[dimensionId];
}
function setChoice(role: StackRole, dimensionId: string, value: string): void {
  selections.value[role] = { ...selections.value[role], [dimensionId]: value };
}
function hasAddon(role: StackRole, choiceId: string): boolean {
  const value = selectionValue(role, 'addons');
  return Array.isArray(value) && value.includes(choiceId);
}
function toggleAddon(role: StackRole, choiceId: string, checked: boolean): void {
  const current = selectionValue(role, 'addons');
  const list = Array.isArray(current) ? [...current] : [];
  const next = checked ? [...new Set([...list, choiceId])] : list.filter((item) => item !== choiceId);
  selections.value[role] = { ...selections.value[role], addons: next };
}

/** 换框架：维度选择换成新框架的默认值；端口按惯例改（用户动过的那个不动） */
function applyStackDefaults(role: StackRole): void {
  const stack = stackForRole(role);
  if (!stack) return;
  if (!portTouched.value[role]) ports.value[role] = stack.defaultPort;
  selections.value[role] = defaultsFor(stack);
}

/** 界面上换了某一行的框架（原生 select 的 change 事件） */
function onStackChange(role: StackRole, stackId: string): void {
  if (role === 'frontend') frontendStack.value = stackId;
  else backendStack.value = stackId;
}

watch(frontendStack, () => applyStackDefaults('frontend'));
watch(backendStack, () => applyStackDefaults('backend'));
watch(kind, () => {
  applyStackDefaults('frontend');
  applyStackDefaults('backend');
});

/* ---------------- 运行状态 ---------------- */

const running = ref(false);
const finished = ref(false);
const failed = ref(false);
const logs = ref<JobLogDtoPayload[]>([]);
const percent = ref(0);
const currentJobId = ref<string | null>(null);
const createdProjectId = ref<string | null>(null);
/** 结束时那句话里"项目已就绪"的具体内容（代码/任务各自有没有，如实说） */
const doneSummary = computed(() => {
  const parts: string[] = [];
  if (needsScaffold.value) parts.push('代码已生成至项目文件夹');
  if (applyTemplate.value) parts.push('任务清单、里程碑与文档模板已铺好');
  if (parts.length === 0) parts.push('项目已建好');
  return `${parts.join('，')}，可前往工作大纲继续`;
});

function resetSteps(): void {
  const list: Step[] = [{ key: 'env', label: '环境检测', status: 'pending', detail: '' }];
  list.push({ key: 'create', label: '创建项目与目录', status: 'pending', detail: '' });
  if (needsScaffold.value) {
    list.push({ key: 'scaffold', label: '生成代码骨架', status: 'pending', detail: '' });
    if (installDeps.value) {
      list.push({ key: 'install', label: '安装依赖', status: 'pending', detail: '' });
    }
  }
  // 放最后：它是"收尾"，把任务/里程碑/文档一次铺好（纯管理项目也有这一步；
  // 工作流是建项目时就铺好的六个状态，不归模板管）
  if (applyTemplate.value) {
    list.push({ key: 'template', label: '铺管理侧模板', status: 'pending', detail: '' });
  }
  steps.value = list;
  logs.value = [];
  percent.value = 0;
}

function step(key: Step['key']): Step | undefined {
  return steps.value.find((item) => item.key === key);
}

function setStep(key: Step['key'], status: StepStatus, detail = ''): void {
  const target = step(key);
  if (target) {
    target.status = status;
    if (detail) target.detail = detail;
  }
}

/**
 * 每一步的权重（进度条用）。
 *
 * 管理侧模板放 100（最后一步），装依赖 90：它比"生成骨架"轻，但比模板重 ——
 * 装依赖要联网下载，是这条流程里最慢的一步。
 */
const STEP_WEIGHT: Record<Step['key'], number> = {
  env: 20,
  create: 30,
  scaffold: 80,
  install: 90,
  template: 100,
};

function recomputePercent(): void {
  let value = 0;
  for (const item of steps.value) {
    const weight = STEP_WEIGHT[item.key];
    if (item.status === 'done' || item.status === 'skipped') value = Math.max(value, weight);
    else if (item.status === 'active') value = Math.max(value, Math.max(0, weight - 15));
  }
  percent.value = Math.min(100, value);
}

/* ---------------- 与后端交互 ---------------- */

function appendLogs(entries: JobLogDtoPayload[]): void {
  logs.value = [...logs.value, ...entries].slice(-500);
}

/** 跟着一条作业跑：轮询比 SSE 更简单，也不会留下没收尾的连接（这一页只跑一次就关） */
async function followJob(jobId: string, label: string): Promise<boolean> {
  currentJobId.value = jobId;
  let afterTs = 0;

  for (;;) {
    const [job, newLogs] = await Promise.all([
      jobsApi.get(jobId),
      jobsApi.logs(jobId, { afterTs, limit: 500 }),
    ]);
    if (newLogs.items.length > 0) {
      appendLogs(newLogs.items);
      afterTs = newLogs.items.at(-1)?.ts ?? afterTs;
    }

    const runningStep = step(label as Step['key']);
    if (runningStep) runningStep.detail = `${job.phase ?? '进行中'} · ${job.percent}%`;

    if (job.status === 'succeeded') {
      currentJobId.value = null;
      return true;
    }
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'interrupted') {
      currentJobId.value = null;
      if (job.status === 'canceled') {
        setStep(label as Step['key'], 'skipped', '已取消');
        return false;
      }
      setStep(label as Step['key'], 'failed', job.errorMessage ?? '执行失败，但未返回原因');
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

async function run(): Promise<void> {
  if (!canSubmit.value) return;
  resetSteps();
  running.value = true;
  finished.value = false;
  failed.value = false;

  try {
    /* ---- 1) 环境检测（创建项目前就要知道这台机器能不能生成代码） ---- */
    setStep('env', 'active');
    recomputePercent();
    if (needsScaffold.value) {
      const env = await window.pmStudio?.detectEnvironment();
      const missing = env?.missingRequired ?? [];
      if (!env) {
        setStep('env', 'failed', '环境检测失败：主进程无响应');
        failed.value = true;
        return;
      }
      if (missing.length > 0) {
        setStep('env', 'failed', `缺少必需工具：${missing.join('、')}。装好之后重试`);
        failed.value = true;
        return;
      }
      const node = env.tools.find((tool) => tool.id === 'node');
      setStep('env', 'done', `Node ${node?.version ?? '?'} · 必需工具齐备`);
    } else {
      setStep('env', 'skipped', '纯管理项目无需生成代码，跳过环境检测');
    }
    recomputePercent();

    /* ---- 2) 建项目（含文件夹） ---- */
    setStep('create', 'active');
    recomputePercent();
    const created = await projectsApi.create({
      name: name.value.trim(),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      color: color.value,
      codeKind: kind.value === 'managed' ? null : kind.value,
    });
    createdProjectId.value = created.id;
    await board.loadProjects();
    await board.selectProject(created.id);
    setStep('create', 'done', `已建好项目文件夹「${created.folder ?? created.name}」`);
    recomputePercent();

    /*
     * 纯管理项目：没有骨架、没有依赖，但**管理侧模板照样要铺**。
     *
     * 这里原来是"直接跳到完成"，于是纯管理项目（也就是最该"新建即非空"的那一类）
     * 只拿到一个空项目，而结束语照样写着"工作流与任务清单已铺好" ——
     * 一个**说了却没做**的状态。是端到端场景量出来 0 个任务才发现的。
     */
    if (!needsScaffold.value) {
      await runTemplateStep(created.id);
      setStepDone();
      return;
    }

    /* ---- 3) 生成骨架 ---- */
    setStep('scaffold', 'active');
    recomputePercent();
    /*
     * 每个目标带上**自己的端口与自己的维度选择**（语言 / 附加项）。
     * 双栈时这两块是分开的：前端 5173、后端 8000，各自可以不一样。
     */
    const scaffold = await jobsApi.enqueue('scaffold', {
      projectId: created.id,
      targets: rows.value.map((row) => ({
        templateId: row.stack.id,
        ...(ports.value[row.role] !== null ? { port: ports.value[row.role] } : {}),
        selections: selections.value[row.role] ?? {},
      })),
      ...(packageManager.value !== 'auto' ? { packageManager: packageManager.value } : {}),
    });
    const scaffoldOk = await followJob(scaffold.id, 'scaffold');
    if (!scaffoldOk) {
      failed.value = true;
      return;
    }
    setStep('scaffold', 'done', selectedStacks.value.join(' + '));
    recomputePercent();

    /* ---- 4) 装依赖 ---- */
    if (step('install')) {
      setStep('install', 'active');
      recomputePercent();
      const install = await jobsApi.enqueue('install', {
        projectId: created.id,
        targets: selectedStacks.value.map((templateId) => ({ templateId })),
        ...(packageManager.value !== 'auto' ? { packageManager: packageManager.value } : {}),
      });
      const installOk = await followJob(install.id, 'install');
      if (!installOk) {
        failed.value = true;
        return;
      }
      setStep('install', 'done', '依赖装好了');
      recomputePercent();
    }

    /* ---- 5) 铺管理侧模板（任务清单 / 里程碑 / 文档模板） ---- */
    await runTemplateStep(created.id);

    setStepDone();
  } catch (error) {
    failed.value = true;
    const active = steps.value.find((item) => item.status === 'active');
    if (active) active.status = 'failed';
    setStepFailureMessage(error);
  } finally {
    running.value = false;
  }
}

/** 铺管理侧模板（抽成函数：带代码的项目与纯管理项目都要走这一步） */
async function runTemplateStep(projectId: string): Promise<void> {
  if (!step('template')) return;
  setStep('template', 'active');
  recomputePercent();
  /*
   * 三块都显式给出来（服务端不给默认值）：漏传一块就是"不铺那一块"，
   * 不会变成"悄悄替他铺了一堆任务"。这里全开，是因为勾选框只控制"铺不铺整包"。
   */
  const applied = await projectsApi.applyTemplate(projectId, {
    kind: kind.value,
    tasks: true,
    milestones: true,
    docs: true,
  });
  appendLogs([
    {
      id: `local-template-${Date.now()}`,
      jobId: 'local',
      ts: Date.now(),
      level: 'info',
      message: `管理侧模板（${applied.summary}）：${applied.description}`,
    },
  ]);
  // 接口只保证"该建的建了"，跳过什么要如实写进日志（重试时最有用）
  for (const name of applied.skipped.tasks.slice(0, 8)) {
    appendLogs([
      {
        id: `local-skip-${name}`,
        jobId: 'local',
        ts: Date.now(),
        level: 'warn',
        message: `  已存在，跳过任务：${name}`,
      },
    ]);
  }
  setStep('template', 'done', applied.description);
  recomputePercent();
  // 任务/里程碑都建好了：工作大纲得重新拉一次，否则还显示"0 个任务"
  await board.selectProject(projectId);
}

function setStepFailureMessage(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const active = steps.value.find((item) => item.status === 'failed');
  if (active) active.detail = message;
  appendLogs([
    {
      id: `local-${Date.now()}`,
      jobId: 'local',
      ts: Date.now(),
      level: 'error',
      message,
    },
  ]);
}

function setStepDone(): void {
  finished.value = true;
  percent.value = 100;
}

/** 取消正在跑的那一步（作业执行器会真的把子进程杀掉） */
async function cancelRunning(): Promise<void> {
  const jobId = currentJobId.value;
  if (!jobId) return;
  try {
    await jobsApi.cancel(jobId);
    feedback.info('已请求取消');
  } catch (error) {
    feedback.failure(error, '取消失败');
  }
}

function close(): void {
  if (running.value) return;
  emit('update:show', false);
  if (createdProjectId.value) emit('created', createdProjectId.value);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ---------------- 打开时拉一次技术栈清单 ---------------- */

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return;
    kind.value = 'managed';
    name.value = '';
    description.value = '';
    installDeps.value = true;
    applyTemplate.value = true;
    packageManager.value = 'auto';
    ports.value = { frontend: 5173, backend: 8000 };
    portTouched.value = { frontend: false, backend: false };
    selections.value = { frontend: {}, backend: {} };
    running.value = false;
    finished.value = false;
    failed.value = false;
    createdProjectId.value = null;
    resetSteps();
    try {
      const list = await jobsApi.list({ limit: 1 });
      if (list.scaffoldTemplates.length > 0) stacks.value = list.scaffoldTemplates;
    } catch {
      // 拿不到就用兜底：这两个是内置模板，一定有
      stacks.value = [
        {
          id: 'vue3',
          name: 'Vue 3',
          kind: 'frontend',
          source: 'official',
          needsNetwork: true,
          defaultPort: 5173,
          installKind: 'node',
          languageLabel: 'TypeScript / JavaScript',
          enginesNode: '^20.19.0 || >=22.12.0',
          dimensions: [
            {
              id: 'language',
              label: '语言',
              kind: 'choice',
              defaultValue: 'ts',
              choices: [
                { id: 'ts', label: 'TypeScript', args: ['--ts'] },
                { id: 'js', label: 'JavaScript', args: [] },
              ],
            },
            {
              id: 'version',
              label: '版本',
              kind: 'choice',
              defaultValue: 'stable',
              choices: [
                { id: 'stable', label: 'Vue 3.5（当前稳定）', args: [] },
                { id: 'rc', label: 'Vue 3.6 RC', args: ['--vue-rc'] },
              ],
            },
          ],
        },
        {
          id: 'fastapi',
          name: 'FastAPI',
          kind: 'backend',
          source: 'builtin',
          needsNetwork: false,
          defaultPort: 8000,
          installKind: 'python',
          languageLabel: 'Python',
          dimensions: [],
        },
      ];
    }
    // 兜底清单也要把默认选择铺好（否则界面上的控件与状态不一致）
    selections.value = { frontend: defaultsFor(stackById(frontendStack.value)), backend: defaultsFor(stackById(backendStack.value)) };
  },
  { immediate: true },
);
</script>

<template>
  <NModal :show="show" :mask-closable="!running" @update:show="(value: boolean) => !running && emit('update:show', value)">
    <NCard class="wizard" title="新建项目" :bordered="false" size="small" role="dialog" aria-modal="true">
      <!-- ================= 第一步：配置 ================= -->
      <div v-if="!running && !finished && !failed" class="body">
        <section class="block">
          <div class="block-label">项目类型</div>
          <div class="type-grid">
            <button
              v-for="type in PROJECT_TYPES"
              :key="type.kind"
              type="button"
              class="type-card"
              :class="{ selected: kind === type.kind }"
              :data-type="type.kind"
              @click="kind = type.kind"
            >
              <span class="type-icon"><AppIcon :name="type.icon" :size="18" /></span>
              <span class="type-text">
                <span class="type-label">{{ type.label }}</span>
                <span class="type-summary faint">{{ type.summary }}</span>
              </span>
            </button>
          </div>
        </section>

        <!--
          技术栈：**前端一行、后端一行**，各自选框架、各自的端口。
          维度（语言 / 附加项）由服务端的声明决定：`row.stack.dimensions` 里没有的东西
          这里不会出现 —— 于是不存在"点了也没用的开关"。
        -->
        <section v-if="needsScaffold" class="block">
          <div class="block-label">技术栈</div>

          <div v-for="row in rows" :key="row.role" class="stack-card" :data-stack="row.role">
            <div class="stack-head">
              <span class="stack-role">{{ row.label }}</span>

              <label class="field">
                <span class="field-label">框架</span>
                <select
                  class="select"
                  :data-field="`wizard-${row.role}`"
                  :value="row.stack.id"
                  @change="onStackChange(row.role, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="stack in row.candidates" :key="stack.id" :value="stack.id">
                    {{ stack.name }}
                  </option>
                </select>
              </label>

              <!-- 语言：候选多于一个才做成控件；只有一个时静态显示（不做死控件） -->
              <label v-if="choiceDimension(row.stack)" class="field">
                <span class="field-label">语言</span>
                <select
                  class="select"
                  :data-field="`wizard-language-${row.role}`"
                  :value="selectionValue(row.role, 'language') ?? ''"
                  @change="setChoice(row.role, 'language', ($event.target as HTMLSelectElement).value)"
                >
                  <option
                    v-for="choice in choiceDimension(row.stack)!.choices"
                    :key="choice.id"
                    :value="choice.id"
                    :title="choice.hint"
                  >
                    {{ choice.label }}
                  </option>
                </select>
              </label>
              <span v-else class="stack-static faint">语言：{{ row.stack.languageLabel }}</span>

              <!-- 版本：官方只给"它模板里那一版"，我们按选择改生成出来的依赖清单 -->
              <label v-if="versionDimension(row.stack)" class="field version-field">
                <span class="field-label">版本</span>
                <select
                  class="select"
                  :data-field="`wizard-version-${row.role}`"
                  :value="selectionValue(row.role, 'version') ?? ''"
                  @change="setChoice(row.role, 'version', ($event.target as HTMLSelectElement).value)"
                >
                  <option
                    v-for="choice in versionDimension(row.stack)!.choices"
                    :key="choice.id"
                    :value="choice.id"
                    :title="choice.hint"
                  >
                    {{ choice.label }}
                  </option>
                </select>
              </label>

              <label class="field port-field">
                <span class="field-label">端口</span>
                <NInputNumber
                  v-model:value="ports[row.role]"
                  :min="1"
                  :max="65535"
                  :show-button="false"
                  class="port-input"
                  :data-field="`wizard-port-${row.role}`"
                  @update:value="portTouched[row.role] = true"
                />
              </label>
            </div>

            <!-- Node 要求是工具链的事实，静态显示（做成开关就成了"点了也没用"的控件） -->
            <p v-if="row.stack.enginesNode" class="stack-runtime faint" :data-runtime="row.role">
              需要 Node {{ row.stack.enginesNode }}（写入 package.json 的 engines）
            </p>

            <!-- 附加项：这个栈支持什么就显示什么（内置模板没有可选项，这一段就不出现） -->
            <div v-if="multiDimension(row.stack)" class="stack-addons">
              <span class="field-label">附加项</span>
              <div class="addon-list">
                <label
                  v-for="choice in multiDimension(row.stack)!.choices"
                  :key="choice.id"
                  class="addon"
                  :class="{ on: hasAddon(row.role, choice.id) }"
                  :data-addon="`${row.role}:${choice.id}`"
                  :title="choice.hint"
                >
                  <input
                    type="checkbox"
                    :checked="hasAddon(row.role, choice.id)"
                    @change="
                      toggleAddon(row.role, choice.id, ($event.target as HTMLInputElement).checked)
                    "
                  />
                  <span class="addon-label">{{ choice.label }}</span>
                  <em v-if="choice.hint" class="addon-hint faint">{{ choice.hint }}</em>
                </label>
              </div>
            </div>

            <!--
              如实标注每条栈的现状：官方脚手架（第一次要联网）vs 内置模板（离线可用）。
              不标的话，用户断网时会以为软件坏了 —— 而我们明明能在几秒内给他一份内置骨架。
            -->
            <p class="stack-note faint">
              {{ row.stack.name }}：{{ row.stack.needsNetwork
                ? '使用官方脚手架，首次创建需联网下载；失败时回退到内置模板'
                : '内置模板，支持离线创建' }}
            </p>
          </div>

          <!-- 包管理器只在选了 Node 栈时才有意义 -->
          <label v-if="needsNodeInstall" class="field pm-field">
            <span class="field-label">包管理器</span>
            <select v-model="packageManager" class="select" data-field="wizard-pm">
              <option value="auto">自动（按本机已安装的包管理器选择）</option>
              <option value="pnpm">pnpm</option>
              <option value="npm">npm</option>
              <option value="yarn">yarn</option>
            </select>
          </label>
        </section>
        <section class="block">
          <label class="field">
            <span class="field-label">项目名称 <em>*</em></span>
            <NInput v-model:value="name" placeholder="例如：前端重构" :maxlength="200" data-field="wizard-name" />
          </label>
          <label class="field">
            <span class="field-label">描述</span>
            <NInput
              v-model:value="description"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 3 }"
              placeholder="项目说明（可选）"
            />
          </label>
          <label class="field color-field">
            <span class="field-label">颜色</span>
            <NColorPicker v-model:value="color" :show-alpha="false" :modes="['hex']" class="color-picker" />
          </label>
        </section>

        <NAlert v-if="needsScaffold" type="info" :bordered="false" class="note">
          创建后将依次执行：<b>① 环境检测</b> → <b>② 生成代码骨架</b> →
          <b>③ 安装依赖</b>。执行进度与日志在本窗口实时显示；任一步骤失败即中止并说明原因。
          <template v-if="needsNetwork">
            所选技术栈使用官方脚手架，<b>首次执行需联网下载</b>，耗时可能较长。
          </template>
        </NAlert>

        <NCheckbox v-if="needsScaffold" v-model:checked="installDeps" data-field="wizard-install">
          创建后自动安装依赖（离线环境或代理不可用时可不勾选，稍后手动安装）
        </NCheckbox>

        <!--
          管理侧模板：**新建即非空**。勾上之后项目一建好就有任务清单、
          里程碑与文档模板 —— 用户要的就是这个（"创建完打开还是 0 个任务"等于把
          "该怎么开始"全丢回给他）。想从空项目开始的人可以取消勾选。
        -->
        <NCheckbox v-model:checked="applyTemplate" data-field="wizard-template">
          创建后铺管理侧模板（任务清单、里程碑、docs/ 文档模板）
        </NCheckbox>
        <!--
          如实标注"哪一块还没做到位"：文档模板只写到磁盘，应用里看不到它们。
          不写这一句的话，用户会在应用里到处找那四份文档 —— 那比少一个功能更让人恼火。
        -->
        <p v-if="applyTemplate" class="faint tiny template-note" data-field="wizard-template-note">
          文档模板写入 &lt;项目文件夹&gt;/docs/；文档模块（M3）发布前，应用内不展示这些文件。
        </p>
      </div>

      <!-- ================= 第二步：执行（进度 + 日志） ================= -->
      <div v-else class="body">
        <ul class="steps" data-field="wizard-steps">
          <li v-for="item in steps" :key="item.key" class="step" :class="stepTone[item.status]" :data-step="item.key">
            <AppIcon :name="stepIcon[item.status]" :size="14" class="step-icon" />
            <span class="step-label">{{ item.label }}</span>
            <span class="step-detail faint">{{ item.detail }}</span>
          </li>
        </ul>

        <NProgress
          type="line"
          :percentage="percent"
          :height="6"
          :status="failed ? 'error' : finished ? 'success' : 'info'"
          data-field="wizard-progress"
        />

        <div class="log" data-field="wizard-log">
          <p v-if="logs.length === 0" class="faint">（暂无输出）</p>
          <p v-for="entry in logs" :key="entry.id" class="line" :class="entry.level">
            <span class="ts faint">{{ formatTime(entry.ts) }}</span>
            <span class="msg">{{ entry.message }}</span>
          </p>
        </div>
      </div>

      <template #footer>
        <div class="footer">
          <span v-if="finished" class="ok-text" data-field="wizard-done">
            执行完成。项目已就绪：{{ doneSummary }}
          </span>
          <span v-else-if="failed" class="bad-text" data-field="wizard-failed">
            执行在上述标红步骤中止：排除原因后可重试，已完成步骤不会重复执行
          </span>
          <span v-else-if="running" class="faint tiny">正在执行，请勿关闭窗口</span>
          <span v-else class="faint tiny">
            {{ applyTemplate
              ? '创建后按技术栈铺好任务清单、里程碑与文档模板（工作流统一为六个状态）'
              : '未勾选管理侧模板：创建后是一个空项目（工作流仍会铺好六个状态）' }}
          </span>

          <div class="buttons">
            <NButton v-if="running" data-field="wizard-cancel" @click="cancelRunning">取消</NButton>
            <template v-else-if="failed">
              <NButton data-field="wizard-close" @click="close">关闭</NButton>
              <NButton type="primary" data-field="wizard-retry" @click="run">重试</NButton>
            </template>
            <template v-else-if="finished">
              <NButton type="primary" data-field="wizard-finish" @click="close">进入工作大纲</NButton>
            </template>
            <template v-else>
              <NButton @click="close">取消</NButton>
              <NButton type="primary" :disabled="!canSubmit" data-field="wizard-start" @click="run">
                创建
              </NButton>
            </template>
          </div>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.wizard {
  width: 620px;
  max-width: 92vw;
  /*
   * 向导会长高（技术栈拆成"前端一行 + 后端一行 + 附加项"之后就更高了），
   * 而「取消 / 创建」在底部 —— **超出可视区就等于用户找不到按钮**。
   * 真量出来的数字：窗口高 821px 时，"前后端都要"的向导有 1130px，
   * 「创建」落在 y=1118，既看不见也够不着。
   *
   * 所以让它长到"一屏减去边距"就停，**由内容区滚动**，头尾固定不动。
   * 用弹性盒子来表达这件事（子项 flex + 内容区 min-height:0 + overflow），
   * 而不是给一个写死的高度 —— 高度写死在小窗口上会反过来把内容压扁。
   */
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 40px);
}

/*
 * 注意类名：Naive 2.45 的卡片内容区是 `.n-card-content`，**不是** `.n-card__content`
 * （footer 才是 `.n-card__footer`）。第一版照着记忆写成了 `__content`，
 * 于是规则静默失效 —— 量出来的数字（按钮仍在 y=1138）才是唯一的证据。
 */
.wizard :deep(.n-card-content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.wizard :deep(.n-card-header),
.wizard :deep(.n-card__footer) {
  flex: none;
}

/* 一维排布一律用弹性盒子（技术设计 §33） */
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.block-label,
.field-label {
  font-size: 12.5px;
  color: var(--pm-text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label em {
  color: var(--pm-danger);
  font-style: normal;
}

.type-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.type-card {
  flex: 1 1 160px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--pm-border);
  border-radius: 9px;
  background: var(--pm-surface);
  padding: 9px 10px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.type-card:hover {
  border-color: var(--pm-border-strong);
}

.type-card.selected {
  border-color: var(--pm-accent);
  background: color-mix(in srgb, var(--pm-accent) 8%, transparent);
}

.type-icon {
  flex: none;
  color: var(--pm-text-muted);
  line-height: 0;
}

.type-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.type-label {
  font-size: 13px;
  font-weight: 600;
}

.type-summary {
  font-size: 11.5px;
}

/*
 * 技术栈：前端一行、后端一行（各自一个卡片）。
 *
 * 为什么不做成一张表：一行的内容会随框架变（Vue 有语言 + 六个附加项，FastAPI 什么都没有），
 * 表格会把"没有可选项的那个栈"撑出一排空格子 —— 看着像加载失败。
 */
.stack-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--pm-border);
  border-radius: 8px;
  background: var(--pm-surface-2, var(--pm-surface));
}

.stack-card + .stack-card {
  margin-top: 8px;
}

.stack-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}

.stack-head .field {
  flex: 1;
  min-width: 140px;
}

.stack-role {
  display: flex;
  align-items: center;
  height: 34px;
  font-size: 13px;
  font-weight: 600;
  color: var(--pm-text);
  min-width: 34px;
}

.stack-static {
  display: flex;
  align-items: center;
  height: 34px;
  font-size: 12.5px;
}

.stack-addons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.addon-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

/* 附加项：勾选态用底色与边框表达，不用文字（扫一眼就知道选了哪些） */
.addon {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  user-select: none;
}

.addon.on {
  border-color: var(--pm-primary);
  background: color-mix(in srgb, var(--pm-primary) 12%, transparent);
}

.addon input {
  margin: 0;
  cursor: pointer;
}

.addon-hint {
  font-size: 11px;
}

/* 原生 select：这一版不值得为两个下拉引入组件，样式跟主题走 */
.select {
  height: 34px;
  border: 1px solid var(--pm-border);
  border-radius: 6px;
  background: var(--pm-surface);
  color: var(--pm-text);
  padding: 0 8px;
  font: inherit;
  font-size: 13px;
}

.color-field {
  max-width: 160px;
}

.port-field {
  flex: none;
  width: 116px;
}

/* 版本：标签里带版本号，给它宽一点，免得"React 19（当前主线）"被截断 */
.version-field {
  flex: 1.2;
  min-width: 170px;
}

.stack-runtime {
  margin: 0;
  font-size: 11.5px;
}

.template-note {
  margin: -4px 0 0;
  padding-left: 24px;
}

.port-input {
  width: 100%;
}

.pm-field {
  max-width: 320px;
  margin-top: 10px;
}

/* 技术栈现状：淡字（是说明不是警告） */
.stack-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.color-picker {
  width: 100%;
}

.note {
  font-size: 12.5px;
  line-height: 1.7;
}

/* ---------------- 步骤 ---------------- */

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.step {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.step-icon {
  flex: none;
  align-self: center;
}

.step-label {
  flex: none;
  font-weight: 600;
}

.step-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step.ok .step-icon,
.step.ok .step-label {
  color: var(--pm-ok);
}

.step.bad .step-icon,
.step.bad .step-label {
  color: var(--pm-danger);
}

.step.run .step-icon,
.step.run .step-label {
  color: var(--pm-accent);
}

/* 日志区：等宽、自己滚、限高（不让弹窗长到屏幕外） */
.log {
  max-height: 240px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--pm-sunken);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.6;
}

.line {
  margin: 0;
  display: flex;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.line.warn .msg {
  color: var(--pm-warn);
}

.line.error .msg {
  color: var(--pm-danger);
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.buttons {
  display: flex;
  gap: 8px;
  flex: none;
}

.ok-text {
  font-size: 12.5px;
  color: var(--pm-ok);
}

.bad-text {
  font-size: 12.5px;
  color: var(--pm-danger);
}

.faint {
  color: var(--pm-text-faint);
}

.tiny {
  font-size: 12px;
}
</style>
