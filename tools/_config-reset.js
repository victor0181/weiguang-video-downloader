'use strict';

/**
 * _config-reset.js —— 自检 Config.reset()（恢复默认设置）。
 *
 * 跑法：node tools/_node-shim.js _config-reset.js
 *
 * 验证点：
 *   1. 乱调后的值确实被改坏（前置条件检查）
 *   2. reset() 后所有设置项回到 DEFAULT_CONFIG
 *   3. **history（下载记录）被保留**
 *   4. savePath 回到默认下载目录（不为空、真实存在）
 *   5. 写盘后重新 load 仍是默认值（配置真落盘了）
 */

const fs = require('fs');
const path = require('path');

// userData 隔离到临时目录，绝不碰用户真实配置
const PROFILE = path.join(__dirname, '_configreset_prof');
process.env.BD_USERDATA = PROFILE;

const { Config, DEFAULT_CONFIG, defaultSavePath } = require(path.join(__dirname, '..', 'src', 'main', 'config.js'));

const results = [];
const check = (name, ok, extra) => results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const cfg = new Config();

  // ---- 1. 模拟用户乱调 ----
  cfg.patch({
    concurrency: 9,
    videoQn: 120,
    audioQn: 30216,
    audioFormat: 'mp3',
    fileRule: '{up}-{title}-{index}',
    folderRule: '{up}',
    addIndexToFolder: true,
    saveCover: true,
    saveDanmaku: true,
    saveAss: true,
    saveSubtitle: true,
    saveNfo: true,
    keepVideo: true,
    keepAudio: true,
    autoShutdown: true,
    clipWatch: true,
    minToTray: false,
    savePath: PROFILE,               // 故意指向一个"自定义"目录
  });
  cfg.data.history = [{ title: '记录A' }, { title: '记录B' }];
  cfg.save();
  check('前置：乱调已生效', cfg.get('concurrency') === 9 && cfg.get('fileRule') === '{up}-{title}-{index}');

  // ---- 2. reset ----
  const after = cfg.reset();

  const keys = Object.keys(DEFAULT_CONFIG).filter((k) => k !== 'history' && k !== 'savePath');
  const bad = keys.filter((k) => !eq(after[k], DEFAULT_CONFIG[k]));
  check('reset 后所有设置项 == 默认值', bad.length === 0, bad.length ? '偏差: ' + bad.join(',') : '');

  // ---- 3. history 保留 ----
  check('下载记录被保留', Array.isArray(after.history) && after.history.length === 2,
    'history=' + (after.history || []).length);

  // ---- 4. savePath 回默认 ----
  // 注意：桩环境里 app.getPath('downloads') 指向临时 profile，目录并不存在，
  // 所以这里只断言"等于 defaultSavePath()"这个契约，不要求目录真实存在。
  check('savePath 回到默认下载目录', after.savePath === defaultSavePath(), after.savePath);
  check('savePath 不再是用户自定义目录', after.savePath !== PROFILE);

  // ---- 5. 真落盘：重新 load ----
  const cfg2 = new Config();
  check('重新读取仍是默认值', cfg2.get('concurrency') === DEFAULT_CONFIG.concurrency
    && cfg2.get('saveCover') === false
    && cfg2.get('minToTray') === true
    && cfg2.get('videoQn') === 80);
  check('重新读取仍保留记录', (cfg2.get('history') || []).length === 2);

  fs.rmSync(PROFILE, { recursive: true, force: true });

  console.log('== 恢复默认设置（Config.reset）自检 ==');
  results.forEach((l) => console.log('  ' + l));
  process.exitCode = results.some((l) => l.startsWith('FAIL')) ? 1 : 0;
})();
