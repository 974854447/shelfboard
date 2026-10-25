<script setup lang="ts">
/**
 * 设置页（0.2.0 / M2 新增）。
 *
 * 这些偏好**本来就存在 `<userData>/config.json` 里**，只是一直没有界面 ——
 * 想改日志级别、换编辑器、看数据存在哪，都只能去翻配置文件。这一页把它们收进来。
 *
 * 三条设计原则：
 *
 * 1. **改了立刻生效，还是下次启动生效，必须在界面上说清楚**。主题、密度、日志级别是
 *    当场生效的（日志级别主进程会 `setMinLevel`）；文件轮转参数与脱敏要重建日志写入器，
 *    只能等下次启动。把两者混在一起显示，用户会以为"设置没保存"。
 *
 * 2. **没实现的功能要如实标注**。"自动备份"目前**只有配置项、没有实现**，
 *    勾上它并不会真的备份 —— 界面上直接写明，而不是让人以为数据已经安全了。
 *
 * 3. **嵌套字段整块回写**。主进程的 `preferences:patch` 是**浅合并**：
 *    只传 `{ logging: { level } }` 会把 `logging` 里其它字段抹掉（脱敏、轮转参数全没了）。
 *    所以这里每次都传完整的 `logging` / `autoBackup` 对象。
 */

import {
  NButton,
  NCard,
  NInput,
  NInputNumber,
  NModal,
  NRadio,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import AppIcon from '../components/AppIcon.vue';
import { workLog as workLogApi } from '../api/endpoints';
import { useAppStore } from '../stores/app';
import { useBoardStore } from '../stores/board';
import { useUiStore } from '../stores/ui';

const ui = useUiStore();
const app = useAppStore();
const board = useBoardStore();
const message = useMessage();
const dialog = useDialog();
const router = useRouter();

const prefs = ref<PreferencesPayload | null>(null);
const logging = ref<PreferencesPayload['logging'] | null>(null);
const autoBackup = ref<PreferencesPayload['autoBackup'] | null>(null);

/** 工作日志：主进程解析出的默认目录（设置里没指定时用它） */
const defaultWorkLogDir = ref<string | null>(null);

/**
 * 当前生效的保存位置。
 *
 * 优先显示用户设置的目录；没设置就显示默认目录 —— 界面必须显示**真正会写入的那个路径**，
 * 而不是一个空的输入框（用户点"生成"之后第一件事就是去找文件）。
 */
const effectiveWorkLogDir = computed(
  () => prefs.value?.workLogSaveDir ?? defaultWorkLogDir.value ?? '（正在读取…）',
);

/** 选一个目录作为工作日志的保存位置 */
async function chooseWorkLogDir(): Promise<void> {
  try {
    const picked = await window.pmStudio?.chooseWorkLogDir();
    if (!picked) return;
    // 浅合并：偏好补丁是 {...current, ...patch}，所以这里只传这一个字段是安全的
    const next = await window.pmStudio?.patchPreferences({ workLogSaveDir: picked });
    if (next) prefs.value = next;
    message.success(`工作日志将保存到：${picked}`);
  } catch (error) {
    message.error(`设置保存位置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 恢复默认（写回 null，主进程会重新解析"文档"目录） */
async function resetWorkLogDir(): Promise<void> {
  try {
    const next = await window.pmStudio?.patchPreferences({ workLogSaveDir: null });
    if (next) prefs.value = next;
    message.success('已恢复默认保存位置');
  } catch (error) {
    message.error(`恢复默认失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 本机检测到的编辑器（命令 + 可执行文件路径） */
const editors = ref<{ command: string; exe: string }[]>([]);
const detecting = ref(false);

onMounted(async () => {
  const current = (await window.pmStudio?.getPreferences()) ?? null;
  prefs.value = current;
  // 拆成独立引用，表单才好双向绑定；回写时再拼回完整对象
  logging.value = current ? { ...current.logging } : null;
  autoBackup.value = current ? { ...current.autoBackup } : null;
  await detectEditors();
  await loadEnvironment();
  await loadWorkLogDir();
});

/** 读默认保存目录（由主进程按 `app.getPath('documents')` 解析） */
async function loadWorkLogDir(): Promise<void> {
  try {
    const config = await workLogApi.config();
    defaultWorkLogDir.value = config.defaultDir;
  } catch {
    // 拿不到不影响其它设置项：界面会显示"正在读取…"，比编一个假路径诚实
    defaultWorkLogDir.value = null;
  }
}

/**
 * 检测本机装了哪些编辑器。
 *
 * 之前这里是"把白名单 8 个命令全列出来"，用户面对一堆没装的名字无从下手。
 * 现在只列**真正检测到的**；当前配置的那一个如果没检测到（换了机器、
 * 或者装在非常规位置），仍然保留在选项里并标注"未检测到"，否则下拉会显示成空白，
 * 看起来像设置丢了。
 */
async function detectEditors(): Promise<void> {
  detecting.value = true;
  try {
    editors.value = (await window.pmStudio?.detectEditors()) ?? [];
  } catch (error) {
    message.error(`检测编辑器失败：${error instanceof Error ? error.message : String(error)}`);
    editors.value = [];
  } finally {
    detecting.value = false;
  }
}

const editorOptions = computed(() => {
  const current = prefs.value?.editorCommand ?? null;
  const list = editors.value.map((item) => ({
    label: `${item.command}　${item.exe}`,
    value: item.command,
  }));
  if (current && !list.some((option) => option.value === current)) {
    list.unshift({ label: `${current}（未检测到）`, value: current });
  }
  return list;
});

/* ---------------- 开发环境检测（M4） ---------------- */

/**
 * 检测本机装了哪些开发工具（node / npm / pnpm / yarn / python / pip / git / venv）。
 *
 * 两个入口刻意分开：
 * - 进页面时读**缓存**（`environmentStatus`）—— 每次进设置页都重测要派生 7~8 个子进程，
 *   没必要；
 * - 用户点「重新检测环境」才强制重测（`detectEnvironment`）—— 装了新工具之后必须能刷新，
 *   需求 §5.7 明确要求"不允许永久跳过检测"。
 */
const envSnapshot = ref<EnvironmentSnapshotPayload | null>(null);
const envDetecting = ref(false);

function envTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadEnvironment(): Promise<void> {
  try {
    envSnapshot.value = (await window.pmStudio?.environmentStatus()) ?? null;
  } catch {
    // 读缓存失败不影响页面：当作"还没检测过"，用户点一下重新检测即可
    envSnapshot.value = null;
  }
}

async function detectEnvironmentNow(): Promise<void> {
  envDetecting.value = true;
  try {
    envSnapshot.value = (await window.pmStudio?.detectEnvironment()) ?? null;
    const missing = envSnapshot.value?.missingRequired ?? [];
    if (missing.length > 0) {
      message.warning(`检测完成：缺少 ${missing.join('、')}`);
    } else {
      message.success('检测完成：必需工具都在');
    }
  } catch (error) {
    message.error(`检测环境失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    envDetecting.value = false;
  }
}

/* ---------------- GitHub 绑定（预留接口） ---------------- */

const github = ref<GithubStatusPayload | null>(null);
const githubBusy = ref(false);

async function loadGithub(): Promise<void> {
  github.value = (await window.pmStudio?.githubStatus()) ?? null;
}

onMounted(loadGithub);

/**
 * 点「绑定 GitHub」。
 *
 * 现在一定返回"尚未实现"，所以这里**不需要假装在授权**（不转圈、不弹假的进度）：
 * 直接把主进程给的说明摆出来。等 M6 实现之后，这里改成展示设备码流程即可，
 * 判据用 `status.available`，不写死。
 */
async function connectGithub(): Promise<void> {
  githubBusy.value = true;
  try {
    const result = await window.pmStudio?.connectGithub();
    if (result && !result.ok) {
      dialog.info({
        title: 'GitHub 绑定尚未实现',
        content: result.reason,
        positiveText: '知道了',
      });
    } else {
      await loadGithub();
      message.success('GitHub 绑定成功');
    }
  } catch (error) {
    message.error(`绑定失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    githubBusy.value = false;
  }
}

async function disconnectGithub(): Promise<void> {
  githubBusy.value = true;
  try {
    github.value = (await window.pmStudio?.disconnectGithub()) ?? null;
    message.success('已解除 GitHub 绑定（本地凭据已清除）');
  } catch (error) {
    message.error(`解绑失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    githubBusy.value = false;
  }
}

const logLevelOptions = [
  { label: 'error（只记错误）', value: 'error' },
  { label: 'warn（含告警）', value: 'warn' },
  { label: 'info（默认，含请求）', value: 'info' },
  { label: 'debug（最详细）', value: 'debug' },
];

/** 统一的写入口：失败要看得见（配置写不进去是最容易被忽略的问题） */
async function patch(next: Partial<PreferencesPayload>, hint = '已保存'): Promise<void> {
  try {
    const updated = await window.pmStudio?.patchPreferences(next);
    if (updated) prefs.value = updated;
    message.success(hint);
  } catch (error) {
    message.error(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveLogging(): void {
  if (!logging.value) return;
  // 整块回写（见文件头第 3 条）
  void patch({ logging: { ...logging.value } }, '日志设置已保存（级别立即生效）');
}

function saveBackup(): void {
  if (!autoBackup.value) return;
  void patch({ autoBackup: { ...autoBackup.value } }, '备份策略已保存');
}

function onEditorChange(value: string): void {
  void patch({ editorCommand: value }, `编辑器已切换为 ${value}`);
}

async function openDataDir(): Promise<void> {
  await window.pmStudio?.revealUserDataDir();
}

async function openWorkspace(): Promise<void> {
  await window.pmStudio?.revealWorkspace();
}

/* ---------------- 工作区目录 ---------------- */

const switching = ref(false);

/** 切换后界面上的路径要立刻变：内部记录一份，不等页面重载 */
const workspaceRoot = ref<string | null>(null);

const currentWorkspaceRoot = computed(
  () => workspaceRoot.value ?? app.info?.workspaceRoot ?? '',
);

/**
 * 更改工作区目录。
 *
 * 分成两步问清楚，因为这里有**真实的文件移动**：
 * 1. 先弹系统目录选择框；
 * 2. 如果当前项目列表非空，再问"要不要把项目文件夹一起搬过去" ——
 *    不搬也能切（用户可能想手动整理），但要让他知道项目的文件夹还留在原地。
 *
 * 搬家用的是重命名（同盘瞬时完成）。**跨盘会失败**，那时如实报出来并让用户手动拷，
 * 不做"复制 + 删除"（那才是真会丢数据的操作，留给 M5 的迁移功能）。
 */
async function changeWorkspaceDir(): Promise<void> {
  const bridge = window.pmStudio;
  if (!bridge) return;

  const picked = await bridge.chooseWorkspaceDir();
  if (!picked) {
    message.info('已取消'); // 区分"取消"和"失败"：取消不该报错
    return;
  }
  if (picked === currentWorkspaceRoot.value) {
    message.warning('选中的就是当前目录');
    return;
  }

  const projectCount = board.projects.length;
  const moveProjects = await new Promise<boolean | null>((resolve) => {
    if (projectCount === 0) {
      resolve(false); // 没有项目，没什么可搬的
      return;
    }
    dialog.warning({
      title: '要把现有项目一起搬过去吗？',
      content:
        `当前有 ${projectCount} 个项目，它们的文件夹还在旧目录里。\n` +
        '「一起搬过去」= 把文件夹移动到新目录（同一磁盘是瞬间完成的）；\n' +
        '「只切换」= 新目录先空着，旧文件夹留在原地由你自己处理。',
      positiveText: '一起搬过去',
      negativeText: '只切换目录',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(null),
      onMaskClick: () => resolve(null),
    });
  });
  if (moveProjects === null) {
    message.info('已取消');
    return;
  }

  switching.value = true;
  try {
    const report = await bridge.setWorkspaceRoot(picked, { moveProjects });
    workspaceRoot.value = report.workspaceRoot;

    const parts = [`工作区已切到 ${report.workspaceRoot}`];
    if (report.moved.length) parts.push(`搬过去 ${report.moved.length} 个项目文件夹`);
    if (report.skipped.length) parts.push(`跳过 ${report.skipped.length} 个（目标已存在同名文件夹）`);
    if (report.failed.length) {
      parts.push(`失败 ${report.failed.length} 个：${report.failed.map((f) => f.name).join('、')}`);
    }
    if (report.failed.length || report.skipped.length) {
      message.warning(parts.join('；'), { duration: 8000 });
    } else {
      message.success(parts.join('；'));
    }

    // 界面刷新不在这里做：主进程改完工作区会广播 `workspace:changed`，
    // 由 AppShell 统一刷新启动信息与项目列表（这样别的调用方改目录也不会漏刷新）。
    // 这里只把本页自己维护的路径引用更新一下，避免等到事件回来之前显示旧值。
    workspaceRoot.value = report.workspaceRoot;

    /*
     * 切换只改了"当前进程里记的工作区路径"。内嵌服务仍拿着启动时的旧路径
     * （新建项目时建文件夹、导出诊断包都用它），所以**重启才算完全生效**。
     * 与其让用户遇到"新项目怎么建到旧目录去了"，不如在这里把话说清楚并给个按钮。
     */
    dialog.info({
      title: '工作区目录已切换',
      content:
        '需重启应用，使全部功能使用新目录（如新建项目的文件夹位置、诊断包导出），' +
        '需要重启一次应用。现在就重启吗？',
      positiveText: '立即重启',
      negativeText: '稍后自己重启',
      onPositiveClick: () => {
        void window.pmStudio?.relaunch();
      },
    });
  } catch (error) {
    message.error(`切换失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    switching.value = false;
  }
}

/* ---------------- 备份 ---------------- */

const backingUp = ref(false);

async function backupNow(): Promise<void> {
  backingUp.value = true;
  try {
    const result = await window.pmStudio?.runBackup();
    if (result) {
      message.success(`已备份到 ${result.file}（共 ${result.pages} 页）`, { duration: 6000 });
    }
  } catch (error) {
    message.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    backingUp.value = false;
  }
}

async function openBackups(): Promise<void> {
  await window.pmStudio?.revealBackups();
}
</script>

<template>
  <!-- `data-view` 是给 E2E 的语义标记：判断"路由内容真的挂载了"（约定见 docs/technical-design.md 的 E2E 一节） -->
  <div class="page" data-view="settings">
    <header class="page-head">
      <div>
        <h1>设置</h1>
        <p class="faint sub">
          以上偏好保存在应用数据目录的 config.json 中；立即生效的项目已在界面上标注。
        </p>
      </div>
    </header>

    <div class="sections">
      <!-- ============ 外观 ============ -->
      <section class="card" data-section="appearance">
        <h2>外观</h2>
        <!--
          这里刻意**只有主题**。
          界面密度与侧边栏折叠原来也放在这儿，但：主题在下拉之外没有别处可改；
          而密度与侧边栏在顶部工具条上都有按钮（用户 2026-09-25 要求「这两个不要」），
          同一个开关出现在两处，只会让人怀疑"我是不是改错了地方"。
        -->
        <div class="row">
          <div class="label">
            <div class="name">主题</div>
            <div class="faint hint">立即生效 · 也可点击顶栏最右侧图标快速切换</div>
          </div>
          <NRadioGroup :value="ui.mode" @update:value="(v: string) => ui.setMode(v as ThemeMode)">
            <NRadioButton value="light">亮色</NRadioButton>
            <NRadioButton value="dark">暗色</NRadioButton>
            <NRadioButton value="system">跟随系统</NRadioButton>
          </NRadioGroup>
        </div>
      </section>

      <!-- ============ 编辑器 ============ -->
      <section class="card" data-section="editor">
        <!--
          分区名用「编辑器」（话题），设置项用「默认编辑器」（这一项本身的名字）。
          用户 2026-09-25 明确要求把这一行改成「默认编辑器」—— 原来写的是
          「用哪个编辑器打开项目」，是一句问句，而其它分区里的设置项都是名词
          （主题 / 记录级别 / 日志保留天数…），这一条是唯一不合群的。
        -->
        <h2>编辑器</h2>
        <div class="row">
          <div class="label">
            <div class="name">默认编辑器</div>
            <div class="faint hint">
              <template v-if="detecting">正在检测这台电脑上的编辑器…</template>
              <template v-else-if="editors.length > 0">
                已检测到 {{ editors.length }} 个：{{ editors.map((e) => e.command).join('、') }}
              </template>
              <template v-else>
                未检测到常见编辑器（VS Code / VS Code Insiders / Cursor / Windsurf / WebStorm / IDEA / Sublime / Notepad++）。安装后请点击「重新检测」
              </template>
            </div>
          </div>
          <div class="value">
            <NSelect
              class="control"
              data-field="editor-select"
              :value="prefs?.editorCommand ?? null"
              :options="editorOptions"
              :loading="detecting"
              :disabled="editorOptions.length === 0"
              @update:value="onEditorChange"
            />
            <NButton size="small" :loading="detecting" @click="detectEditors">重新检测</NButton>
          </div>
        </div>
      </section>

      <!-- ============ 开发环境 ============ -->
      <!--
        M4 第一步：**只读检测**。这一版不提供"自动配置环境变量"（那一步默认勾选、
        会改用户的 PATH / .npmrc / pip.ini，排在 M4 最后做），所以这里只展示事实。
      -->
      <section class="card" data-section="environment">
        <h2>开发环境</h2>

        <div class="row">
          <div class="label">
            <div class="name">本机开发工具</div>
            <div class="faint hint" data-field="env-summary">
              <template v-if="envDetecting">正在检测…（需执行 7~8 条命令获取版本号，通常数秒）</template>
              <template v-else-if="!envSnapshot">
                尚未检测。新建项目前会强制检测一次，用于确定包管理器与是否可生成 Python 项目
              </template>
              <template v-else-if="envSnapshot.ready">
                必需工具都在（node / npm）。检测时间 {{ envTime(envSnapshot.checkedAt) }}
              </template>
              <template v-else>
                缺少必需工具：{{ envSnapshot.missingRequired.join('、') }}。检测时间
                {{ envTime(envSnapshot.checkedAt) }}
              </template>
            </div>
          </div>
          <div class="value">
            <NButton
              size="small"
              type="primary"
              :loading="envDetecting"
              data-field="env-detect"
              @click="detectEnvironmentNow"
            >
              重新检测环境
            </NButton>
          </div>
        </div>

        <p v-if="envSnapshot?.restartHint" class="faint warn" data-field="env-restart-hint">
          {{ envSnapshot.restartHint }}
        </p>

        <ul v-if="envSnapshot" class="tools" data-field="env-tools">
          <li
            v-for="tool in envSnapshot.tools"
            :key="tool.id"
            class="tool"
            data-field="env-tool"
            :data-tool="tool.id"
            :class="{ missing: !tool.found }"
          >
            <span class="tool-name">{{ tool.label }}</span>
            <!--
              能力探测（venv）没有版本号，显示「可用 / 不可用」而不是「版本未知」——
              后者会让人以为"检测出问题了"，而它本来就是这么设计的。
            -->
            <span
              v-if="tool.kind === 'capability' && tool.found"
              class="tool-version ok"
              data-field="env-version"
            >
              可用
            </span>
            <span v-else-if="tool.found" class="tool-version mono" data-field="env-version">
              {{ tool.version ?? '版本未知' }}
            </span>
            <span v-else class="tool-missing" data-field="env-missing">未找到</span>
            <span class="tool-path mono faint" :title="tool.path ?? ''">{{ tool.path ?? '' }}</span>
            <span class="tool-need faint">{{ tool.neededFor }}</span>
            <!-- 读不到版本 / 超时的原因要**显示出来**，不能只塞在 tooltip 里 -->
            <span v-if="tool.note" class="tool-note faint" data-field="env-note">{{ tool.note }}</span>
          </li>
        </ul>
      </section>

      <!-- ============ 日志 ============ -->
      <section class="card" data-section="logging" v-if="logging">
        <h2>日志与诊断</h2>

        <div class="row">
          <div class="label">
            <div class="name">记录级别</div>
            <div class="faint hint">立即生效 · 级别越低记录越详细，debug 会显著增加日志量</div>
          </div>
          <NSelect
            class="control"
            v-model:value="logging.level"
            :options="logLevelOptions"
            @update:value="saveLogging"
          />
        </div>

        <div class="row">
          <div class="label">
            <div class="name">日志保留天数</div>
            <div class="faint hint">下次启动生效 · 数据库里的应用日志</div>
          </div>
          <NInputNumber
            class="control-sm"
            v-model:value="logging.retentionDays"
            :min="1"
            :max="3650"
            @update:value="saveLogging"
          />
        </div>

        <div class="row">
          <div class="label">
            <div class="name">单个日志文件上限</div>
            <div class="faint hint">下次启动生效 · 超出后轮转</div>
          </div>
          <NInputNumber
            class="control-sm"
            v-model:value="logging.fileMaxMB"
            :min="1"
            :max="512"
            @update:value="saveLogging"
          >
            <template #suffix>MB</template>
          </NInputNumber>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">保留日志文件份数</div>
            <div class="faint hint">下次启动生效</div>
          </div>
          <NInputNumber
            class="control-sm"
            v-model:value="logging.fileKeepCount"
            :min="1"
            :max="100"
            @update:value="saveLogging"
          />
        </div>

        <div class="row">
          <div class="label">
            <div class="name">隐藏用户名</div>
            <div class="faint hint">下次启动生效 · 导出诊断包时把路径里的用户名替换为 %USER%</div>
          </div>
          <NSwitch v-model:value="logging.redactUserName" @update:value="saveLogging" />
        </div>
      </section>

      <!-- ============ 备份 ============ -->
      <section class="card" data-section="backup" v-if="autoBackup">
        <h2>
          备份
          <NTag size="tiny" type="warning" :bordered="false">自动备份尚未实现</NTag>
        </h2>
        <!--
          如实标注：定时自动备份**还没有做**，勾选只是先存下配置，不会有任何后台任务执行。
          但"立即备份一次"是真的能用 —— 所以这一区不是一片死配置。
        -->
        <p class="faint note">
          ⚠️ 注意：以下三项仅保存偏好设置，定时自动备份尚未实现，选中后不会执行备份。如需备份，请使用「立即备份一次」。
        </p>

        <div class="row">
          <div class="label">
            <div class="name">立即备份一次</div>
            <div class="faint hint">
              将数据库完整备份至应用数据目录的 backups 文件夹。使用数据库自身的备份接口，未落盘的最新改动不会遗漏
            </div>
          </div>
          <div class="value">
            <NButton size="small" type="primary" :loading="backingUp" @click="backupNow">
              立即备份
            </NButton>
            <NButton size="small" quaternary @click="openBackups">打开备份目录</NButton>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">启用定时自动备份</div>
            <div class="faint hint">功能尚未实现，仅保存配置</div>
          </div>
          <NSwitch v-model:value="autoBackup.enabled" @update:value="saveBackup" />
        </div>

        <div class="row">
          <div class="label">
            <div class="name">每隔多少分钟备份一次</div>
            <div class="faint hint">功能尚未实现，仅保存配置</div>
          </div>
          <NInputNumber
            class="control-sm"
            v-model:value="autoBackup.intervalMinutes"
            :min="5"
            :max="1440"
            @update:value="saveBackup"
          >
            <template #suffix>分钟</template>
          </NInputNumber>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">最多保留几份备份</div>
            <div class="faint hint">
              备份文件按数量轮转：保留 N 份后，新备份将自动删除最旧的一份。例如填 10，即保留最近 10 份备份。
            </div>
          </div>
          <NInputNumber
            class="control-sm"
            v-model:value="autoBackup.keepCount"
            :min="1"
            :max="100"
            @update:value="saveBackup"
          >
            <template #suffix>份</template>
          </NInputNumber>
        </div>
      </section>

      <!-- ============ GitHub 绑定（预留接口） ============ -->
      <section class="card" data-section="github">
        <h2>
          GitHub 绑定
          <NTag size="tiny" type="warning" :bordered="false">尚未实现</NTag>
        </h2>
        <!--
          这是**预留的入口**（用户 2026-09-25 要求「设置里预留绑定 github 的接口」）：
          Git 集成整体排在 M6，所以这一版不假装能绑 —— 按钮点了会明确告诉你还没做，
          以及实现后会怎么做。状态、接口形状、令牌的存放方案都已经定下来（见 main/github.ts），
          以后只改实现、不动这一页的调用方式。
        -->
        <p class="faint note">
          说明：GitHub 绑定尚未实现（Git 集成排期在 M6）。当前仅保留入口，点击后将说明预期的实现方式，不会实际连接 GitHub
        </p>

        <div class="row">
          <div class="label">
            <div class="name">当前状态</div>
            <div class="faint hint">
              未绑定 · 实现后将采用 OAuth 设备码授权（在浏览器中输入一次验证码，无需手动填写令牌）；令牌以系统加密单独保存，不会写入配置文件
            </div>
          </div>
          <div class="value">
            <NTag :type="github?.connected ? 'success' : 'default'" :bordered="false" data-field="github-state">
              {{ github?.connected ? `已绑定：${github.login}` : '未绑定' }}
            </NTag>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">账号绑定</div>
            <div class="faint hint">
              <template v-if="github?.connected">
                已绑定 {{ github.login }}；解绑将同时清除本地保存的令牌
              </template>
              <template v-else>绑定后，项目可关联至 GitHub 仓库</template>
            </div>
          </div>
          <div class="value">
            <NButton
              size="small"
              type="primary"
              data-field="github-connect"
              :loading="githubBusy"
              @click="connectGithub"
            >
              绑定 GitHub
            </NButton>
            <NButton
              v-if="github?.connected"
              size="small"
              quaternary
              data-field="github-disconnect"
              :loading="githubBusy"
              @click="disconnectGithub"
            >
              解除绑定
            </NButton>
          </div>
        </div>
      </section>

      <!-- ============ 工作日志 ============ -->
      <!--
        「生成工作日志」的保存位置（用户要求：「在设置中可以修改日志保存地点」）。

        这一项和"数据目录 / 工作区目录"放在一起是因为它也是"东西存哪儿"，
        但它**不搬任何文件**：改的只是"以后往哪儿写"，所以不需要重启，也没有"迁移"步骤。
      -->
      <section class="card" data-section="worklog">
        <h2>工作日志</h2>

        <div class="row">
          <div class="label">
            <div class="name">保存位置</div>
            <div class="faint hint">
              生成的工作日志（Word 文档）保存到此目录，文件名以当天日期开头
            </div>
          </div>
          <div class="value">
            <span class="mono path" data-field="worklog-dir" :title="effectiveWorkLogDir">
              {{ effectiveWorkLogDir }}
            </span>
            <NButton size="small" data-field="worklog-choose" @click="chooseWorkLogDir">
              更改位置
            </NButton>
            <NButton
              v-if="prefs?.workLogSaveDir"
              size="small"
              quaternary
              data-field="worklog-reset"
              @click="resetWorkLogDir"
            >
              恢复默认
            </NButton>
          </div>
        </div>
      </section>

      <!-- ============ 数据与环境 ============ -->
      <section class="card" data-section="data">
        <h2>数据与环境</h2>

        <div class="row">
          <div class="label">
            <div class="name">当前环境</div>
            <div class="faint hint">
              测试环境与正式环境使用两套完全独立的数据：开发版使用测试环境，打包版使用正式环境
            </div>
          </div>
          <NTag :type="app.info?.environment === 'production' ? 'default' : 'warning'" :bordered="false">
            {{ app.info?.environmentLabel ?? '…' }}
          </NTag>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">数据目录</div>
            <div class="faint hint">数据库、配置与日志均位于此目录（应用自有区域，不随工作区迁移）</div>
          </div>
          <div class="value">
            <span class="mono path" data-field="data-dir" :title="app.info?.userDataDir">{{ app.info?.userDataDir }}</span>
            <NButton size="small" quaternary @click="openDataDir">
              <template #icon><AppIcon name="external" :size="13" /></template>
              打开
            </NButton>
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">工作区目录</div>
            <div class="faint hint">
              仅用于存放项目（一个项目一个文件夹）。可更换至其他磁盘或文件夹；更换后需重启应用，使全部功能使用新目录
            </div>
          </div>
          <div class="value">
            <span class="mono path" data-field="workspace-dir" :title="currentWorkspaceRoot">{{ currentWorkspaceRoot }}</span>
            <NButton size="small" quaternary @click="openWorkspace">
              <template #icon><AppIcon name="external" :size="13" /></template>
              打开
            </NButton>
            <NButton size="small" :loading="switching" @click="changeWorkspaceDir">
              更改目录
            </NButton>
          </div>
        </div>

        <!--
          版本号单独一行、并用更明显的分隔线**与上方隔开**（用户要求：
          「把版本号与上面隔开」），下面紧跟「功能介绍」入口（用户要求：放在版本号下面）。
        -->
        <div class="row split">
          <div class="label"><div class="name">版本</div></div>
          <div class="value mono">v{{ app.info?.version ?? '…' }}</div>
        </div>

        <div class="row" data-section="whats-new">
          <div class="label">
            <div class="name">功能介绍</div>
            <div class="faint hint">各版本变更说明，点击查看（内容维护在 data/whats-new.ts）</div>
          </div>
          <div class="value">
            <NButton
              size="small"
              quaternary
              data-field="whats-new-open"
              @click="router.push({ name: 'whats-new' })"
            >
              查看
            </NButton>
          </div>
        </div>
      </section>
    </div>

  </div>
</template>

<style scoped>
.page {
  padding: 16px 20px 24px;
  overflow: auto;
  height: 100%;
}

.page-head h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.sub {
  margin: 4px 0 0;
  font-size: 12.5px;
}

.sections {
  margin-top: 16px;
  display: grid;
  gap: 14px;
  max-width: 860px;
}

.card {
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  padding: 14px 16px;
  display: grid;
  gap: 4px;
}

.card h2 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.note {
  margin: 0 0 8px;
  font-size: 12.5px;
  line-height: 1.7;
}

/* 每行左说明右控件：说明区固定宽度，控件才不会随文案长度左右跳 */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 9px 0;
  border-top: 1px solid var(--pm-border);
}

.row:first-of-type {
  border-top: none;
}

/* 版本号那一行与上方隔开：用更明显的分隔线 + 一点间距，让"版本/功能介绍"自成一组 */
.row.split {
  margin-top: 8px;
  border-top: 1px solid var(--pm-border-strong);
}

.label .name {
  font-size: 13px;
}

.label .hint {
  font-size: 11.5px;
  line-height: 1.6;
  margin-top: 2px;
}

.control {
  width: 240px;
}

.control-sm {
  width: 130px;
}

.value {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/*
 * 路径显示。
 *
 * 一开始用了 `direction: rtl` 想让省略号出现在**开头**（路径的结尾信息量更大），
 * 结果反斜杠被当成了双向文本的分隔符，路径被显示成 `_s\ZhuanZ\…` 这种残缺样子 ——
 * 看起来像程序出错。改成**允许换行**：不截断、不做省略，两行放下即可，
 * 路径是给人核对用的，宁可多占一行也不能显示错。
 */
.path {
  font-size: 12px;
  color: var(--pm-text-muted);
  max-width: 360px;
  overflow-wrap: anywhere;
  text-align: right;
  line-height: 1.5;
}

.mono {
  font-family: 'Cascadia Mono', Consolas, monospace;
}

/* ---------------- 开发环境（工具清单） ---------------- */

.warn {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--pm-warn) 12%, transparent);
  color: var(--pm-warn);
  font-size: 12px;
  line-height: 1.7;
}

/*
 * 一行一个工具。用 grid 而不是 flex：每一列的含义固定（名字 / 版本 / 路径 / 用途），
 * 上下要对齐才扫得快 —— 这是"二维对齐"，不是一维排布（见技术设计 §33）。
 */
.tools {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool {
  display: grid;
  grid-template-columns: 120px 96px minmax(0, 1fr) minmax(0, 200px);
  align-items: baseline;
  gap: 10px;
  padding: 6px 4px;
  border-radius: 6px;
  font-size: 12px;
}

.tool + .tool {
  border-top: 1px solid var(--pm-border);
}

.tool.missing {
  background: color-mix(in srgb, var(--pm-text-faint) 6%, transparent);
}

.tool-name {
  color: var(--pm-text);
  font-weight: 600;
}

.tool-version {
  color: var(--pm-ok);
}

.tool-version.ok {
  font-weight: 600;
}

/* 说明占满整行（grid 的第一列到最后一列）：它是对这一行的解释，不该挤进某一列 */
.tool-note {
  grid-column: 1 / -1;
  font-size: 11.5px;
  line-height: 1.6;
  padding-left: 2px;
}

.tool-missing {
  color: var(--pm-text-faint);
}

/* 路径可能很长：只占一列、超出省略，完整值放 title */
.tool-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-need {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.wn-group h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.wn-group ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--pm-text-muted);
}
</style>
