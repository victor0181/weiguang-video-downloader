'use strict';

/**
 * preload.js —— 安全桥
 *
 * 旧版直接开启 nodeIntegration，渲染进程可任意 require('fs')/child_process，
 * 一旦页面被注入就等于交出系统权限。这里改为 contextIsolation + 白名单 IPC。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 注册主进程事件（返回取消订阅函数） */
function on(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('bd', {
  // ---- 应用状态 ----
  getState: () => invoke('app:getState'),
  health: () => invoke('app:health'),
  healthCheck: () => invoke('app:healthCheck'),

  // ---- 解析 ----
  resolve: (input) => invoke('app:resolve', input),
  preview: (bvid, cid) => invoke('app:preview', { bvid, cid }),

  // ---- 账号 ----
  qrGenerate: () => invoke('app:qrGenerate'),
  qrPoll: (key) => invoke('app:qrPoll', key),
  userInfo: () => invoke('app:userInfo'),
  logout: () => invoke('app:logout'),

  // ---- 任务 ----
  addTasks: (media, sel) => invoke('app:addTasks', { media, sel }),
  tasks: () => invoke('app:tasks'),
  taskAction: (action, id) => invoke('app:taskAction', { action, id }),
  allAction: (action) => invoke('app:allAction', action),

  // ---- 配置 ----
  getConfig: () => invoke('app:getConfig'),
  setConfig: (patch) => invoke('app:setConfig', patch),
  resetConfig: () => invoke('app:resetConfig'),
  nameVars: () => invoke('app:nameVars'),

  // ---- 记录 ----
  history: () => invoke('app:history'),
  clearHistory: () => invoke('app:clearHistory'),

  // ---- 系统集成 ----
  selectDir: () => invoke('app:selectDir'),
  selectFile: (opts) => invoke('app:selectFile', opts),
  openFolder: (p) => invoke('app:openFolder', p),
  openPath: (p) => invoke('app:openPath', p),
  openExternal: (url) => invoke('app:openExternal', url),
  copyText: (text) => invoke('app:copyText', text),
  editAction: (action) => invoke('app:editAction', action),
  restartAria2: () => invoke('app:restartAria2'),
  ariaStatus: () => invoke('app:ariaStatus'),
  cancelShutdown: () => invoke('app:cancelShutdown'),

  // ---- 工具箱 ----
  toolConvertMp3: (file) => invoke('app:toolConvertMp3', file),
  toolMerge: (v, a, outDir) => invoke('app:toolMerge', { video: v, audio: a, outDir }),

  // ---- 窗口 ----
  win: {
    min: () => invoke('win:min'),
    max: () => invoke('win:max'),
    close: () => invoke('win:close'),
    isMax: () => invoke('win:isMax'),
  },

  // ---- 事件订阅 ----
  on,
});
