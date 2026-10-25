<script setup lang="ts">
/**
 * 全局错误横幅。
 *
 * 存在的意义就一条：**任何错误都能一键跳到日志现场**。
 * 横幅上直接显示错误码与 traceId，排查时不需要再去翻文件、猜时间点。
 *
 * 用固定定位的横幅而不是 Toast：错误信息需要**留在屏幕上**直到被处理 ——
 * Toast 几秒就消失了，用户往往还没来得及复制 traceId。
 */

import { NButton } from 'naive-ui';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import AppIcon from './AppIcon.vue';
import { useAppStore } from '../stores/app';

const app = useAppStore();
const router = useRouter();

const error = computed(() => app.lastError);

function openLogs(): void {
  const traceId = error.value?.traceId;
  if (!traceId) return;
  void router.push({ name: 'log-context', params: { traceId } });
}

async function copyTraceId(): Promise<void> {
  const traceId = error.value?.traceId;
  if (!traceId) return;
  try {
    await navigator.clipboard.writeText(traceId);
  } catch {
    // 剪贴板不可用时忽略：traceId 本来就显示在界面上，用户可以手选
  }
}
</script>

<template>
  <Transition name="banner">
    <div v-if="error" class="banner" role="alert">
      <span class="icon"><AppIcon name="alert" :size="17" /></span>

      <div class="body">
        <div class="line">
          <span class="code mono">{{ error.code }}</span>
          <span class="message">{{ error.message }}</span>
        </div>
        <button v-if="error.traceId" class="trace mono" title="点击复制" @click="copyTraceId">
          traceId: {{ error.traceId }}
        </button>
      </div>

      <div class="actions">
        <NButton v-if="error.traceId" size="small" type="primary" @click="openLogs">
          查看日志
        </NButton>
        <NButton size="small" quaternary @click="app.clearError()">关闭</NButton>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.banner {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 100;

  display: flex;
  align-items: center;
  gap: 14px;
  max-width: min(900px, calc(100vw - 44px));
  padding: 11px 14px;

  border: 1px solid var(--pm-danger);
  border-radius: 10px;
  background: var(--pm-surface);
  box-shadow: var(--pm-shadow-strong);
}

.icon {
  color: var(--pm-danger);
  flex-shrink: 0;
}

.body {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.code {
  font-size: 11.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--pm-danger) 16%, transparent);
  color: var(--pm-danger);
}

.message {
  color: var(--pm-text);
}

.trace {
  justify-self: start;
  border: none;
  background: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--pm-text-faint);
  cursor: pointer;
  /* 长 traceId 不要撑破横幅 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.trace:hover {
  color: var(--pm-accent);
}

.actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.banner-enter-active,
.banner-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.banner-enter-from,
.banner-leave-to {
  opacity: 0;
  transform: translate(-50%, 14px);
}
</style>
