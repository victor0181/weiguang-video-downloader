'use strict';

/**
 * config.js —— 配置与路径
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// ---------- 路径 ----------

function getBinDir() {
  const dev = path.join(__dirname, '..', '..', 'bin');
  if (fs.existsSync(dev)) return dev;
  const packed = path.join(process.resourcesPath || '', 'bin');
  if (fs.existsSync(packed)) return packed;
  return dev;
}

function getBin(name) {
  return path.join(getBinDir(), name);
}

function getDataDir() {
  const dir = app ? app.getPath('userData') : path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultSavePath() {
  try {
    const p = app ? app.getPath('downloads') : process.cwd();
    return fs.existsSync(p) ? p : (app ? app.getPath('desktop') : process.cwd());
  } catch (e) {
    return process.cwd();
  }
}

// ---------- 默认配置 ----------

const DEFAULT_CONFIG = {
  savePath: '',
  videoQn: 80, // 默认 1080P
  audioQn: 30280, // 默认 192K
  audioFormat: 'm4a', // 「只下载音频」的输出格式：m4a（无损封装）/ mp3（通用）
  concurrency: 3,
  keepVideo: false,
  keepAudio: false,
  fileRule: '{title}',
  folderRule: '',
  addIndexToFolder: false,
  saveCover: false,
  saveDanmaku: false,
  saveAss: false,
  saveSubtitle: false,
  saveNfo: false,
  autoShutdown: false,
  clipWatch: false,
  minToTray: true,
  proxy: '',
  history: [],
};

class Config {
  constructor() {
    this.file = path.join(getDataDir(), 'config.json');
    this.data = Object.assign({}, DEFAULT_CONFIG);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = Object.assign({}, DEFAULT_CONFIG, raw);
      }
    } catch (e) {
      console.error('[config] load failed, using defaults: ' + e.message);
    }
    if (!this.data.savePath || !fs.existsSync(this.data.savePath)) {
      this.data.savePath = defaultSavePath();
    }
    return this.data;
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('[config] save failed: ' + e.message);
      return false;
    }
  }

  get(key) {
    return this.data[key];
  }

  /**
   * 恢复出厂默认设置。
   * 刻意**保留 history**（下载记录属于用户数据，不是"设置"），
   * savePath 回到系统默认下载目录（与首次启动一致）。
   * @returns {object} 重置后的完整配置
   */
  reset() {
    const history = this.data.history || [];
    this.data = Object.assign({}, DEFAULT_CONFIG, { history });
    if (!this.data.savePath || !fs.existsSync(this.data.savePath)) {
      this.data.savePath = defaultSavePath();
    }
    this.save();
    return this.data;
  }

  set(key, value) {
    this.data[key] = value;
    return this.save();
  }

  patch(obj) {
    Object.assign(this.data, obj);
    return this.save();
  }

  all() {
    return this.data;
  }

  // ---- 下载记录 ----

  addHistory(record) {
    this.data.history.unshift(Object.assign({ ts: Date.now() }, record));
    if (this.data.history.length > 2000) this.data.history.length = 2000;
    return this.save();
  }

  clearHistory() {
    this.data.history = [];
    return this.save();
  }
}

// ---------- 命名变量 ----------

/**
 * 可用变量，用于设置页展示与替换
 */
const NAME_VARS = [
  { key: '{title}', desc: '视频标题' },
  { key: '{bv}', desc: 'BV 号' },
  { key: '{av}', desc: 'AV 号' },
  { key: '{cid}', desc: 'cid' },
  { key: '{aweme}', desc: '抖音作品 ID（仅抖音）' },
  { key: '{up}', desc: 'UP 主 / 作者昵称' },
  { key: '{uid}', desc: 'UP 主 UID' },
  { key: '{index}', desc: '分集序号（从 1 开始）' },
  { key: '{part}', desc: '分集标题' },
  { key: '{qn}', desc: '画质名称（只下载音频时为音质名称）' },
  { key: '{date}', desc: '日期 YYYY-MM-DD' },
  { key: '{time}', desc: '时间 HH-mm-ss' },
  { key: '{type}', desc: '视频类型（单视频/分集/合集）' },
];

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function ymd(d = new Date(), withTime = false) {
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withTime) return s;
  return `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 应用命名规则
 * @param {string} rule  形如 "{title}" 或 "01{title}"
 * @param {object} ctx   变量字典
 * @param {number} index 分集序号（可选，用于补零）
 */
function applyRule(rule, ctx, index) {
  let out = String(rule || '');
  for (const [k, v] of Object.entries(ctx)) {
    out = out.split(`{${k}}`).join(v == null ? '' : String(v));
  }
  if (index != null) out = out.split('{index}').join(String(index));
  return out;
}

module.exports = {
  Config,
  DEFAULT_CONFIG,
  NAME_VARS,
  getBinDir,
  getBin,
  getDataDir,
  defaultSavePath,
  applyRule,
  ymd,
  pad,
};
