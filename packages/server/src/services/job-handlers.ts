/**
 * 服务端自带的作业 handler（M4）。
 *
 * **为什么注册在服务端**：脚手架完全是服务端的活 —— 它要读项目与文件夹（服务层）、
 * 用命令白名单、渲染内置模板、写项目目录，一行都不需要主进程。
 * 反过来，主进程注册的那一个（环境自检）要用主进程的 PATH 探测与工具清单。
 * 分界线就是"这件事需要谁的数据"。
 */

import type { JobHandlerSpec } from './job-runner.js';
import { installTitle, parseInstallPayload, runInstallJob } from './job-install.js';
import { parseScaffoldPayload, runScaffoldJob, scaffoldTitle } from './job-scaffold.js';

/**
 * 生成项目骨架。
 *
 * 并发 1：同一个项目被两个作业同时往同一目录里写，结果一定是一团糟；
 * 而"给不同项目同时生成"在实践中也不值得为它放开并发（写盘是快的，慢的是装依赖）。
 */
export function createScaffoldHandler(): JobHandlerSpec {
  return {
    type: 'scaffold',
    title: scaffoldTitle,
    concurrency: 1,
    /**
     * **不能自动重试**：失败时可能已经写了一半文件，重试会覆盖或跳过，
     * 让用户搞不清当前目录到底是什么状态。让他自己看一眼再点重试。
     */
    retryable: false,
    handler: (job, payload) => runScaffoldJob(job, parseScaffoldPayload(payload)),
  };
}

/**
 * 装依赖。
 *
 * 并发 1：`npm install` / `pip install` 都能把磁盘和网络打满，并发跑只会互相拖慢，
 * 而且同一个项目被两个安装进程同时写 `node_modules` 是一定会坏的场景。
 *
 * **可以重试**：装依赖失败通常是网络问题，修好网络再点重试是最自然的动作
 * （脚手架的"重试"反而危险：半成品目录会让人搞不清状态）。
 */
export function createInstallHandler(): JobHandlerSpec {
  return {
    type: 'install',
    title: installTitle,
    concurrency: 1,
    retryable: true,
    handler: (job, payload) => runInstallJob(job, parseInstallPayload(payload)),
  };
}

export function createBuiltinJobHandlers(): readonly JobHandlerSpec[] {
  return [createScaffoldHandler(), createInstallHandler()];
}
