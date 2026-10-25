/**
 * 第一个真作业：环境自检（M4）。
 *
 * 为什么是它打头：作业执行器需要**一个真实的作业**才能证明"排队 → 进度 → 实时日志 →
 * 失败/取消 → 收尾"这条路是通的。而环境自检刚好合适 ——
 *
 * - 它**真的在跑外部命令**（走命令白名单那套），不是拿假数据演示；
 * - 它是**只读**的：不装东西、不建目录、不改环境，跑坏了也没有后果；
 * - 它的输出用户看得懂（每个工具的版本），所以"作业中心"这一页第一次打开就有东西可看。
 *
 * 后面脚手架、装依赖那些真活会以同样的方式注册进来（`jobHandlers` 注入）。
 */

import { existsSync } from 'node:fs';

import type { DETECTABLE_TOOLS, JobContext, JobHandlerSpec } from '@pm-studio/server';

import { createPathEditorProbe } from './editor';
import { parseVersion, REQUIRED_TOOLS, TOOL_DEFINITIONS } from './env-detect';

/**
 * 逐个工具跑一遍白名单命令，把结果写成日志、按"已完成工具数"推进度。
 *
 * 进度口径是**可解释**的：`已完成工具数 / 工具总数`。外部命令没有进度条，
 * 所以宁可给一个"看得懂的分母"，也不要编一个平滑动画。
 */
async function runEnvCheck(job: JobContext): Promise<Record<string, unknown>> {
  const probe = createPathEditorProbe(process.env, existsSync);
  const total = TOOL_DEFINITIONS.length;
  const missing: string[] = [];
  const found: Record<string, string | null> = {};

  job.log(`开始自检：共 ${total} 个工具（${TOOL_DEFINITIONS.map((tool) => tool.id).join(' / ')}）`);
  job.progress(0, '准备');

  for (const [index, definition] of TOOL_DEFINITIONS.entries()) {
    job.throwIfCanceled();

    const isVenv = definition.id === 'venv';
    const binName = isVenv ? 'python' : definition.id;
    job.progress(Math.round((index / total) * 100), `检查 ${definition.label}`);

    const path = probe.which(binName);
    if (!path) {
      job.log(`✗ ${definition.label}：PATH 里没有 ${binName}（${definition.neededFor}）`, 'warn');
      missing.push(definition.id);
      continue;
    }

    // 能力探测加 `quiet`：`python -m venv --help` 会打印一大篇用法，逐行记进日志只会淹掉有用的内容；
    // `executePath` 让白名单自己判断要不要借 cmd.exe（Windows 上的 .cmd 壳）
    const result = await job.runCommand(
      isVenv ? 'venv-probe' : 'tool-version',
      { tool: binName as (typeof DETECTABLE_TOOLS)[number] },
      isVenv ? { quiet: true, executePath: path } : { executePath: path },
    );

    if (result.canceled) {
      job.log(`${definition.label}：命令被取消`, 'warn');
      job.throwIfCanceled();
    }

    if (definition.kind === 'capability') {
      job.log(result.ok ? `✓ ${definition.label}：可用` : `✗ ${definition.label}：不可用（Python 里没有 venv 模块）`, result.ok ? 'info' : 'warn');
      if (!result.ok) missing.push(definition.id);
      continue;
    }

    if (!result.ok) {
      job.log(`✗ ${definition.label}：取版本号失败（退出码 ${result.code ?? '—'}）`, 'warn');
      missing.push(definition.id);
      continue;
    }

    const version = parseVersion(result.stdout || result.stderr, definition.versionPattern);
    found[definition.id] = version;
    job.log(`✓ ${definition.label}：${version ?? '版本未知'}`);
  }

  job.progress(95, '汇总');
  const missingRequired = REQUIRED_TOOLS.filter((id) => missing.includes(id));

  if (missingRequired.length > 0) {
    // 必需工具缺失 → 作业**失败**（而不是"成功但有警告"）：界面上的作业中心
    // 靠状态一眼分辨"能不能往下走"，含糊的成功会让人以为可以生成项目了
    throw new Error(`缺少必需工具：${missingRequired.join('、')}。装好之后重跑一次自检`);
  }

  job.log('自检完成：必需工具都在');
  missSummary(job, missing);

  return { found, missing, checkedAt: Date.now() };
}

function missSummary(job: JobContext, missing: string[]): void {
  const optional = missing.filter((id) => !REQUIRED_TOOLS.includes(id));
  if (optional.length > 0) {
    job.log(`提示：可选工具缺失 —— ${optional.join('、')}（缺它们只影响对应的那类项目）`, 'warn');
  }
}

export function createEnvCheckHandler(): JobHandlerSpec {
  return {
    type: 'env-check',
    title: () => '环境自检',
    /** 只读、几秒钟跑完，允许并行（装依赖那类必须是 1，见技术设计 §5.3） */
    concurrency: 2,
    retryable: true,
    handler: (job) => runEnvCheck(job),
  };
}

export const JOB_HANDLERS: readonly JobHandlerSpec[] = [createEnvCheckHandler()];
