<script setup lang="ts">
/**
 * 应用外壳：Provider 装配。
 *
 * Provider 必须包在**真正使用它们的组件外面**，而 `useMessage()` 这类
 * 组合式函数只能在 Provider 内部调用 —— 所以布局逻辑放在 `AppShell` 子组件里，
 * 这个文件只负责把 Provider 套起来。
 */

import {
  dateZhCN,
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NLoadingBarProvider,
  NMessageProvider,
  NNotificationProvider,
  zhCN,
} from 'naive-ui';

import AppShell from './components/AppShell.vue';
import { useUiStore } from './stores/ui';

const ui = useUiStore();
</script>

<template>
  <NConfigProvider
    :theme="ui.naiveTheme"
    :theme-overrides="ui.naiveOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <!-- 让 Naive 自己把 body 底色对齐主题，避免内容区与外壳有色差 -->
    <NGlobalStyle />
    <NLoadingBarProvider>
      <NDialogProvider>
        <NMessageProvider :max="3" placement="bottom">
          <NNotificationProvider :max="4" placement="bottom-right">
            <AppShell />
          </NNotificationProvider>
        </NMessageProvider>
      </NDialogProvider>
    </NLoadingBarProvider>
  </NConfigProvider>
</template>
