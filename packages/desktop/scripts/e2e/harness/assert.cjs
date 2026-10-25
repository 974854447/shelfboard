/**
 * 断言记录器。
 *
 * 上一代脚本（`ui-shot.cjs`）在这件事上有个反复误导我的写法：
 * `check(ok, '失败时才成立的描述')` —— 成功时也把这句"失败文案"打出来，
 * 日志于是自相矛盾（印着"找不到卡片"，其实通过了），排查时先怀疑被测代码。
 *
 * 所以这里的约定是：**第二个参数永远是"期望成立的说法"**（陈述句），
 * 失败时打印 `✗ 期望…`，并把 `actual`（实际值）附在后面。这样日志无论成败都读得通。
 *
 * 另外刻意**不在第一个失败处中断**：一次跑完能拿到全部失败点，
 * 修一轮比修一处跑一次快得多。是否中断由场景自己决定（`throw` 即可）。
 */

function createRecorder() {
  const results = [];

  const record = (ok, expected, actual) => {
    results.push({ ok, expected, actual });
    const mark = ok ? '  ✓' : '  ✗';
    const detail = !ok && actual !== undefined ? ` · 实际：${format(actual)}` : '';
    process.stdout.write(`${mark} ${expected}${detail}\n`);
    return ok;
  };

  return {
    results,

    /** 期望 `condition` 成立。`actual` 只在失败时打印，用于说明差在哪 */
    check(condition, expected, actual) {
      return record(Boolean(condition), expected, actual);
    },

    equal(actual, expected, label) {
      return record(
        actual === expected,
        `${label} == ${format(expected)}`,
        actual,
      );
    },

    atLeast(actual, min, label) {
      return record(
        typeof actual === 'number' && actual >= min,
        `${label} ≥ ${min}`,
        actual,
      );
    },

    /** 记录一条"这条没法验证"的说明（不算失败，但必须显式说出来） */
    note(text) {
      process.stdout.write(`  · ${text}\n`);
    },

    get failures() {
      return results.filter((item) => !item.ok);
    },

    get passed() {
      return results.length - this.failures.length;
    },
  };
}

function format(value) {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

module.exports = { createRecorder, format };
