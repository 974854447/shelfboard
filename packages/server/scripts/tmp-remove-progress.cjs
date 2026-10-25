/**
 * 一次性改造：移除任务的 `progress` 字段（用户 2026-10-02：「所有任务的进度条都取消…不再需要进度条」）。
 *
 * 三个原则：
 * 1. **数据库列保留**（`tasks.progress`），只是不再读写。删列要重建表（SQLite 改不了已有列），
 *    而这个字段已经没有任何语义 —— 冒着动表结构的风险去省一个 INTEGER 不划算。
 * 2. **DTO 与入参一并去掉**：留着字段但永远返回 0，会让人以为"进度还能用"。
 * 3. 工作日志里的「推进」是**业务概念**（今天动过但没做完的任务），与 `progress` 字段无关，
 *    继续保留；只去掉它输出里的「进度 N%」。
 *
 * 用完即删。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');

function edit(rel, pairs) {
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, 'utf8');
  let hits = 0;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log(`  ! 未命中 ${rel}: ${from.slice(0, 50)}`);
      continue;
    }
    text = text.split(from).join(to);
    hits += 1;
  }
  fs.writeFileSync(file, text, 'utf8');
  console.log(`  ${rel}: ${hits}/${pairs.length}`);
}

// --- tasks.ts：DTO、可更新字段、插入、更新 ---
edit('packages/server/src/services/tasks.ts', [
  ['  progress: number;\n', ''],
  ["  'progress',\n", ''],
  ['    progress: row.progress,\n', ''],
  ['    progress: input.progress ?? 0,\n', ''],
  ['      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),\n', ''],
]);

// --- task-query.ts：跨项目列表 DTO 与 SQL ---
edit('packages/server/src/services/task-query.ts', [
  ['  progress: number;\n', ''],
  ['  progress: number;\n', ''],
  ['    progress: Number(row.progress ?? 0),\n', ''],
  ['         t.priority, t.start_date, t.due_date, t.progress,\n', '         t.priority, t.start_date, t.due_date,\n'],
]);

// --- work-log.ts：条目不再带进度；输出里去掉「进度 N%」 ---
edit('packages/server/src/services/work-log.ts', [
  ['  progress: number;\n', ''],
  ['  progress: number;\n', ''],
  ['         t.priority, t.progress, t.completed_at, t.created_at, t.updated_at, t.due_date\n', '         t.priority, t.completed_at, t.created_at, t.updated_at, t.due_date\n'],
  ['    progress: Number(row.progress ?? 0),\n', ''],
  ["  if (!entry.done) parts.push(`进度 ${Math.round(entry.progress)}%`);\n", ''],
]);

// --- project-template.ts：铺任务时不再写 progress ---
edit('packages/server/src/services/project-template.ts', [
  ['        progress: 0,\n', ''],
]);
