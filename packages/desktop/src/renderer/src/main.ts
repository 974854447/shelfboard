import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installGlobalErrorReporting } from './api/report';
import { router } from './router';
import { applyInitialTheme } from './theme/apply';
import './styles.css';
// 任务卡的样式：四个页面共用同一张卡，所以它是**全局**样式（见该文件的说明）。
// 放在基础样式之后：同一元素上两边都命中时，后写的赢。
import './components/task-card.css';

/**
 * 在挂载之前把主题定下来。
 *
 * 偏好是通过 preload **同步**取回的（`initialPreferences`），所以这一步
 * 能做在任何 DOM 渲染之前 —— 晚一步就会先渲染出错误颜色再跳成正确的，
 * 暗色用户会看到明显的一下白闪。
 */
applyInitialTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);

/**
 * 全局异常上报。
 *
 * 必须在挂载前安装：挂载过程中就可能抛错，装晚了那次错误就没人接。
 * 服务端会把来源记为 `renderer`，于是日志页能单独筛出"前端出的问题"。
 */
installGlobalErrorReporting(app);

app.mount('#app');
