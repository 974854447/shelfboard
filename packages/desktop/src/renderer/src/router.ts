/**
 * 路由。
 *
 * 用 **hash 模式**：生产环境渲染层由内嵌服务提供静态资源，
 * 刷新时如果落在 `/board` 这样的深链上，history 模式需要服务端把该路径
 * 回落到 index.html —— 而我们的服务还要同时处理 API 路由，多一条兜底规则
 * 就多一处可能与 API 前缀冲突的地方。hash 模式没有这个负担。
 */

import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/projects' },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('./views/ProjectsView.vue'),
    meta: { title: '项目' },
  },
  {
    path: '/overview',
    name: 'overview',
    component: () => import('./views/OverviewView.vue'),
    meta: { title: '总览' },
  },
  {
    path: '/workbench',
    name: 'workbench',
    // 0.2.x：这一页从「工作台」改为「工作大纲」（自上而下的树），视图换成 OutlineView
    component: () => import('./views/OutlineView.vue'),
    meta: { title: '工作大纲' },
  },
  {
    /*
     * 老路由的落点。
     *
     * 原来的「看板」（文件夹视图）与「列表」已经合并成一个「工作台」，
     * 但 `#/board`、`#/list` 可能还留在书签、日志里的深链、以及别人写好的
     * 自动化脚本里 —— 直接让它们 404 会退到项目页，看起来像"功能没了"。
     * 两条老路径都重定向到新页面，成本一行，省掉一类莫名其妙的反馈。
     */
    path: '/board',
    redirect: '/workbench',
  },
  { path: '/list', redirect: '/workbench' },

  {
    path: '/logs',
    name: 'logs',
    component: () => import('./views/LogsView.vue'),
    meta: { title: '日志' },
  },
  {
    // 带 traceId 的日志现场深链：错误提示里的「查看日志」就跳这里
    path: '/logs/context/:traceId',
    name: 'log-context',
    component: () => import('./views/LogsView.vue'),
    meta: { title: '日志现场' },
  },
  {
    /*
     * M2 的三页：日历 / 我的待办 / 全局搜索（0.2.0）。
     * 放在「设置」之前 —— 它们和前四个页面一样是日常干活的视图，设置属于配置。
     */
    path: '/calendar',
    name: 'calendar',
    component: () => import('./views/CalendarView.vue'),
    meta: { title: '日历' },
  },
  {
    /*
     * 0.2.x：「我的待办」改为「今日待办」。
     *
     * `path` 仍是 `/my-tasks`（老书签、深链、e2e 脚本都还在用），
     * 但加了 `/today` 这个别名指向同一页 —— 新名字更好记，老路径也不会断。
     */
    path: '/my-tasks',
    name: 'my-tasks',
    alias: ['/today'],
    component: () => import('./views/TodayView.vue'),
    meta: { title: '今日待办' },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('./views/SearchView.vue'),
    meta: { title: '搜索' },
  },
  {
    /*
     * 「功能介绍」：版本更新介绍（用户 2026-09-25 要求做成页面而不是弹窗）。
     * 两个路由共用一个视图：不带 version 是**版本列表**，带 version 是该版本的**内容**。
     * 入口在设置页的版本号下面；以后每次更新只在 data/whats-new.ts 里加一条。
     */
    path: '/whats-new',
    name: 'whats-new',
    component: () => import('./views/WhatsNewView.vue'),
    meta: { title: '功能介绍' },
  },
  {
    path: '/whats-new/:version',
    name: 'whats-new-detail',
    component: () => import('./views/WhatsNewView.vue'),
    meta: { title: '功能介绍' },
  },
  {
    /*
     * 设置页（0.2.0 / M2 新增）。
     *
     * 放在最后：它是"配置"类页面，不属于日常干活的三个视图（工作台 / 总览 / 日志）。
     * 偏好项本来就存在 config.json 里，这里只是终于有了界面 ——
     * 在此之前用户要改日志级别、编辑器、备份策略，只能去翻配置文件。
     */
    path: '/settings',
    name: 'settings',
    component: () => import('./views/SettingsView.vue'),
    meta: { title: '设置' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/projects' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
