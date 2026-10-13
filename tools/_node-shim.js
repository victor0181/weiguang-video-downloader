'use strict';

/**
 * _node-shim.js —— 无 GUI 环境下的自检运行器（通用）
 *
 * ★ 为什么需要它：本会话里 GUI 模式的 electron.exe 会被环境静默拦掉
 *   （退出码 0、脚本根本没执行），凡是写 `require('electron')` 的
 *   tools/*.js 都起不来。这个运行器用 Module._load 钩子把 `electron`
 *   换成一个最小桩（只提供 app.getPath/setPath/whenReady 与
 *   session.defaultSession.fetch），再原样 require 目标脚本 ——
 *   断言逻辑一份不改，aria2 / ffmpeg / 网络全部真跑。
 *
 * 用法：
 *   node tools/_node-shim.js selftest.js          # 视频通路（双流+混流）
 *   node tools/_node-shim.js parse-test.js        # 解析层（单视频/多P/合集）
 *   node tools/_node-shim.js _audio-e2e.js        # 音频通路
 *   node tools/_node-shim.js <脚本> [脚本自己的参数...]
 *
 * 不支持：douyin-test.js / douyin-browser-probe.js —— 它们依赖
 *   Electron 的真 Chromium（隐藏窗口 + CDP 截响应），桩无法替代，
 *   必须在真 Electron GUI 下跑。
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

const target = process.argv[2];
if (!target) {
  console.error('用法：node tools/_node-shim.js <脚本名> [脚本参数...]');
  console.error('例如：node tools/_node-shim.js selftest.js');
  process.exit(2);
}
const abs = path.isAbsolute(target) ? target : path.join(__dirname, target);
if (!fs.existsSync(abs)) {
  console.error('找不到脚本：' + abs);
  process.exit(2);
}

// 把目标脚本名从 argv 摘掉，让目标脚本读 process.argv[2] 时拿到的是
// 用户真正传给它的第一个参数（douyin-test.js 就这么读 URL）。
process.argv.splice(2, 1);

// userData 隔离，避免污染 %APPDATA%\Electron（与本项目 @用户级 约定一致）
const PROFILE = process.env.BD_USERDATA || path.join(__dirname, '_nodetest_prof');
fs.mkdirSync(PROFILE, { recursive: true });

/** 用 Node 原生 fetch 假冒 Electron 的 session（bili.js 只用 fetch + cookies.set） */
function fakeSession() {
  return {
    fetch: (url, opts) => fetch(url, opts),
    cookies: { set: async () => {}, get: async () => [], flushStore: async () => {} },
  };
}

const ELEC_STUB = {
  app: {
    getPath: (n) => (n === 'userData' ? PROFILE : path.join(PROFILE, n)),
    setPath: () => {},
    isPackaged: false,
    getVersion: () => '0.0.0-stub',
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  session: { defaultSession: fakeSession() },
  BrowserWindow: class {},
  net: {},
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return ELEC_STUB;
  return origLoad.apply(this, arguments);
};

require(abs);
