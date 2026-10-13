'use strict';

/**
 * _dy-resolve-probe.js —— 只跑「抖音解析」这一步，用来复现/定位
 * 「用久了就解析失败」的问题（真 Electron，走真隐藏窗口 + CDP）。
 *
 * 与 douyin-test.js 的区别：不做下载、不做校验，几秒出结果，
 * 并且**可以指定任意 userData**（含用户的真实数据目录），不会清空它。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/_dy-resolve-probe.js
 *
 * 环境变量：
 *   BD_USERDATA   指定 userData（默认 tools/_dyprof，注意不会自动清空）
 *   BD_DY_URL     解析目标（默认用示例短链）
 *   BD_CLEAR_SW=1 解析前清掉该分区的 serviceworkers + cachestorage（验证 SW 假设）
 */

const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { DouyinClient } = require(path.join(SRC, 'douyin'));
const { api } = require(path.join(SRC, 'api'));

const USERDATA = process.env.BD_USERDATA || path.join(__dirname, '_dyprof');
try {
  fs.mkdirSync(USERDATA, { recursive: true });
  app.setPath('userData', USERDATA);
  app.setPath('cache', path.join(USERDATA, 'Cache'));
} catch (e) {
  console.error('[probe] setPath failed: ' + e.message);
}

const TARGET = process.env.BD_DY_URL || 'https://v.douyin.com/jRKTRoQL0tc/';
const CLEAR_SW = process.env.BD_CLEAR_SW === '1';

app.whenReady().then(async () => {
  console.log('[probe] userData = ' + USERDATA);
  console.log('[probe] partition = ' + api.douyin.partition);
  console.log('[probe] target    = ' + TARGET);

  if (CLEAR_SW) {
    const ses = session.fromPartition(api.douyin.partition);
    await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    console.log('[probe] 已清空 serviceworkers + cachestorage');
  } else {
    // 看一眼当前分区里 SW 的规模，便于判断是否已被接管
    const swDir = path.join(USERDATA, 'Partitions', 'douyin', 'Service Worker');
    let n = 0;
    try {
      const walk = (d) => {
        for (const it of fs.readdirSync(d, { withFileTypes: true })) {
          if (it.isDirectory()) walk(path.join(d, it.name));
          else n++;
        }
      };
      walk(swDir);
    } catch (e) {
      /* 目录不存在就是 0 */
    }
    console.log('[probe] 当前 Service Worker 目录文件数 = ' + n);
  }

  const c = new DouyinClient();
  const t0 = Date.now();
  try {
    const m = await c.resolve(TARGET);
    console.log(
      `✅ 解析成功  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${m.qualities.length} 档  ${String(
        m.title
      ).slice(0, 30)}`
    );
  } catch (e) {
    console.log(
      `❌ 解析失败  ${((Date.now() - t0) / 1000).toFixed(1)}s  [${e.code || '-'}] ${e.message}`
    );
  } finally {
    c.destroy();
    setTimeout(() => process.exit(0), 300);
  }
});
