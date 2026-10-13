'use strict';

/**
 * api.js —— 「与 B站 之间的约定」全部集中在这一个文件。
 *
 * 为什么单独抽一个文件？
 *  B站 一旦调整接口，需要改的东西几乎都落在这份清单里：接口地址、请求头、
 *  WBI 混淆表、画质对照表、playurl 参数、扫码返回码。
 *  把它们收拢到一处之后，升级只需要动这个文件，不必在 2800 行代码里翻找。
 *
 * 还能不改程序就改：
 *  把同结构的 JSON 放到用户数据目录下的 `api-override.json`（只写要改的字段即可），
 *  启动时会被自动读取并覆盖默认值，程序本身一个字节都不用动。
 *  路径可用环境变量 BD_API_OVERRIDE 指定；在程序里由 overridePath() 给出。
 *
 * 注意：本文件**不允许** require('electron')，因为体检脚本要在纯 Node 下复用它，
 *  「体检脚本读的常量」与「程序真正用的常量」必须是同一份，否则体检结论没有意义。
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------- 默认值

const DEFAULT = {
  // 结构版本号：以后本文件结构有变动时递增，便于比对
  structVersion: 3,

  /** 备注字段，写什么都行（模板文件里用它写使用说明），程序不读 */
  _comment: '',

  /** 接口地址。B站 换路径时改这里。 */
  urls: {
    spi: 'https://api.bilibili.com/x/frontend/finger/spi',
    nav: 'https://api.bilibili.com/x/web-interface/nav',
    qrGenerate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    qrPoll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
    view: 'https://api.bilibili.com/x/web-interface/view',
    viewDetail: 'https://api.bilibili.com/x/web-interface/view/detail',
    seasonArchives: 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list',
    playurl: 'https://api.bilibili.com/x/player/playurl',
    playerWbi: 'https://api.bilibili.com/x/player/wbi/v2',
    playerV2: 'https://api.bilibili.com/x/player/v2',
    danmaku: 'https://api.bilibili.com/x/v1/dm/list.so',
    ranking: 'https://api.bilibili.com/x/web-interface/ranking/v2',
    popular: 'https://api.bilibili.com/x/web-interface/popular',
    /** 视频观看页前缀（"复制视频链接"用） */
    videoPage: 'https://www.bilibili.com/video/',
  },

  /** 各站点根域（写回 buvid cookie 用得到） */
  hosts: {
    www: 'https://www.bilibili.com',
    api: 'https://api.bilibili.com',
    passport: 'https://passport.bilibili.com',
  },

  /**
   * 短链域名（正则源码，字符串形式以便放进 JSON）。
   * B站 新增短链域名时在这里追加，用 | 分隔。
   */
  shortLinkRegex: 'b23\\.tv|bili2233\\.cn',

  /** 防盗链请求头。CDN 层一般不看 Referer，但留着更稳。 */
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
  },

  /**
   * WBI 签名混淆表（B站 前端固定常量，64 个元素）。
   * 若某天签名开始报 -352 风控，优先怀疑这里：去 B站 页面源码里搜
   * `mixinKeyEncTab` 或 `img_key`，取值替换即可。
   */
  mixinKeyEncTab: [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ],

  /** WBI 密钥缓存时长（毫秒） */
  wbiKeyCacheMs: 10 * 60 * 1000,

  /**
   * playurl 固定查询参数。
   * fnval=4048 = DASH + Dolby + HDR + 4K + AV1 全开。
   */
  playurlParams: {
    fnver: '0',
    fnval: '4048',
    fourk: '1',
  },

  /** 画质 id → 中文名 */
  videoQnDesc: {
    6: '240P 极速',
    16: '360P 流畅',
    32: '480P 清晰',
    64: '720P 高清',
    74: '720P60 高帧率',
    80: '1080P 高清',
    100: '智能修复',
    112: '1080P+ 高码率',
    116: '1080P60 高帧率',
    120: '4K 超清',
    125: 'HDR 真彩',
    126: '杜比视界',
    127: '8K 超高清',
  },

  /** 音质 id → 中文名 */
  audioIdDesc: {
    30216: '64K',
    30232: '132K',
    30280: '192K',
    30250: '杜比全景声',
    30251: 'Hi-Res 无损',
    30252: '192K (Dolby)',
    30380: '杜比全景声 (8K)',
  },

  /** 编码 id → 显示名 */
  codecLabel: {
    avc1: 'AVC/H.264',
    hev1: 'HEVC/H.265',
    hvc1: 'HEVC/H.265',
    av01: 'AV1',
  },

  /** 扫码登录 poll 接口的返回码 */
  qrCodes: {
    success: 0,
    scanned: 86090,
    expired: 86038,
    waiting: 86101,
  },

  /** 设备指纹 cookie 名 */
  buvidCookies: {
    device: 'buvid3',
    device4: 'buvid4',
  },

  // ================================================================
  // 抖音（douyin）
  // ----------------------------------------------------------------
  // 抖音与 B站 的分发方式完全不同：单文件 MP4（音视频同轨）、无 DASH、
  // 无弹幕/字幕接口，播放地址带时效签名，必须每次重新获取。
  //
  // 为什么不自己算 a_bogus 签名？
  //   抖音从 2026 起给 /aweme/v1/web/aweme/detail/ 上了 Argus 风控，
  //   纯 HTTP 请求一律 403（"Blocked by ArgusSecurityPlugin Uifid Not Found"）。
  //   所以这里改用本程序自带的 Chromium：开一个隐藏窗口打开视频页，
  //   让页面自己去请求（自动带上合法的 a_bogus / msToken / verifyFp），
  //   再用 CDP 把响应体截下来。好处是风控升级时**无需改代码**。
  // ================================================================
  douyin: {
    /** 接口 / 页面地址 */
    urls: {
      /** 短链跳转与首页（用于预热登录态与设备指纹） */
      home: 'https://www.douyin.com',
      /**
       * 「推荐」入口。取样本时优先用它：
       * 裸首页会重定向到 /jingxuan（精选），匿名访问常返回"暂时没有更多了"（空 feed），
       * 带上 ?recommend=1 才会真正下发推荐流（实测同一用户目录下：裸首页空、带参数有 27 条）。
       */
      recommend: 'https://www.douyin.com/?recommend=1',
      /** 视频详情页前缀（把 aweme_id 拼在后面） */
      videoPage: 'https://www.douyin.com/video/',
      /** 图文作品页前缀 */
      notePage: 'https://www.douyin.com/note/',
    },

    /**
     * 抖音链接/文本的识别正则（字符串形式，便于放进 JSON）。
     * 出现其中任一即判定为「抖音来源」，交给 douyin.js 处理。
     */
    shortLinkRegex: 'douyin\\.com|iesdouyin\\.com|douyin\\.cn|snssdk\\.com',

    /** 判定「这条响应就是详情数据」的 URL 特征（正则源码） */
    detailApiRe: 'aweme/v1/web/aweme/detail',

    /** 详情响应里承载作品数据的字段 */
    detailField: 'aweme_detail',

    /** 防盗链请求头。★ 抖音 CDN 不带 Referer 会直接 403，这一条是硬要求。 */
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: 'https://www.douyin.com/',
    },

    /**
     * 隐藏浏览器窗口使用的持久化分区。
     * 独立分区可让抖音的 ttwid / UIFID 等设备指纹跨次启动保留，
     * 既提高成功率，也不会和 B站 的登录 Cookie 互相污染。
     */
    partition: 'persist:douyin',

    /** 一次解析的总超时（毫秒）。首次要冷启动整个页面，给足时间。 */
    parseTimeoutMs: 40000,
    /**
     * 详情数据的复用窗口（毫秒），0 = 不复用。
     *
     * 解析出卡片后用户再点「下载」，走的还是同一份详情里的直链；
     * 复用一份能省掉第二次「冷启动抖音页面」的 8 秒。
     * 抖音 CDN 直链的有效期以小时计，120 秒内复用完全安全；
     * 下载中途失败要换新签名地址时，调用方会显式传 { force: true } 绕过缓存。
     */
    detailCacheMs: 120000,
    /** 判定「视频不存在」前，至少等待多久（毫秒），避免把慢加载误判成 404 */
    notFoundGraceMs: 8000,
    /** 解析完成后隐藏窗口的空闲存活时间（毫秒），到点自动销毁释放内存 */
    idleCloseMs: 180000,
    /** 取样时每个入口页的观察窗口（毫秒）。抖音匿名访问的 feed 时有时无，需要重试。 */
    sampleWaitMs: 12000,

    /** bit_rate.gear_name 前缀 → 中文说明 */
    gearKindLabel: {
      normal: '高清',
      low: '标清',
      lower: '流畅',
      adapt_low: '自适应',
    },
  },
};

// ---------------------------------------------------------------- 覆盖文件

/** 用户数据目录（不 require electron，纯 Node 下也能跑） */
function userDataDir() {
  if (process.env.BD_USERDATA) return process.env.BD_USERDATA;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    /* 纯 Node 环境：没有 electron，正常 */
  }
  return null;
}

/** 覆盖文件的完整路径；纯 Node 下退回项目内的 data 目录（与 config.js 的兜底一致） */
function overridePath() {
  if (process.env.BD_API_OVERRIDE) return process.env.BD_API_OVERRIDE;
  const dir = userDataDir();
  if (dir) return path.join(dir, 'api-override.json');
  return path.join(__dirname, '..', '..', 'data', 'api-override.json');
}

/** 覆盖文件路径的来源，仅供体检脚本提示用 */
function overridePathSource() {
  if (process.env.BD_API_OVERRIDE) return 'env';
  return userDataDir() ? 'userData' : 'projectFallback';
}

// ---------------------------------------------------------------- 校验

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());

function validMixinTab(a) {
  if (!Array.isArray(a) || a.length !== 64) return false;
  const seen = new Set();
  for (const n of a) {
    if (!Number.isInteger(n) || n < 0 || n > 63) return false;
    if (seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}

/** 单个字段是不是合法正则源码 */
function isRegexSource(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    new RegExp(v);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 校验「douyin」配置段。
 * 规则与顶层一致：坏字段丢弃并记错，好字段保留，绝不让一处笔误把整个配置搞废。
 */
function sanitizeDouyin(v, errors) {
  if (!isPlainObject(v)) {
    errors.push('douyin 必须是对象');
    return null;
  }
  const out = {};

  for (const k of Object.keys(v)) {
    const val = v[k];
    if (k === 'urls') {
      if (!isPlainObject(val)) {
        errors.push('douyin.urls 必须是对象');
        continue;
      }
      const sub = {};
      for (const kk of Object.keys(val)) {
        // 注意：这里**不能**像顶层 urls 那样去掉结尾斜杠 ——
        // videoPage / notePage 是「前缀」，拼接 id 时依赖结尾的 /。
        if (isHttpUrl(val[kk])) sub[kk] = String(val[kk]).trim();
        else errors.push('douyin.urls.' + kk + ' 不是合法的 http(s) 地址，已忽略');
      }
      out.urls = sub;
    } else if (k === 'headers') {
      if (!isPlainObject(val)) {
        errors.push('douyin.headers 必须是对象');
        continue;
      }
      const sub = {};
      for (const kk of Object.keys(val)) {
        if (typeof val[kk] === 'string' && val[kk].trim()) sub[kk] = val[kk].trim();
        else errors.push('douyin.headers.' + kk + ' 必须是非空字符串，已忽略');
      }
      out.headers = sub;
    } else if (k === 'shortLinkRegex' || k === 'detailApiRe') {
      if (isRegexSource(val)) out[k] = val;
      else errors.push('douyin.' + k + ' 不是合法正则，已忽略：' + val);
    } else if (k === 'gearKindLabel') {
      if (isPlainObject(val)) out[k] = Object.assign({}, val);
      else errors.push('douyin.gearKindLabel 必须是对象');
    } else if (k === 'partition' || k === 'detailField') {
      if (typeof val === 'string' && val.trim()) out[k] = val.trim();
      else errors.push('douyin.' + k + ' 必须是非空字符串');
    } else if (/Ms$/.test(k)) {
      if (Number.isFinite(val) && val >= 0) out[k] = Number(val);
      else errors.push('douyin.' + k + ' 必须是非负数（毫秒），已忽略');
    } else {
      errors.push('douyin 下的未知字段 ' + k + '（已忽略）');
    }
  }
  return out;
}

/**
 * 校验并清洗覆盖内容。
 * 逐字段判断，**坏字段丢弃、好字段保留** —— 这样用户改错一半也不会把程序彻底搞死。
 * @returns {{value:object, errors:string[]}}
 */
function sanitize(patch) {
  const errors = [];
  const out = {};
  if (!isPlainObject(patch)) return { value: {}, errors: ['根节点必须是一个 JSON 对象'] };

  // 逐字段拷贝（允许的键集合取自 DEFAULT，避免用户塞进无用字段）
  for (const key of Object.keys(DEFAULT)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    const def = DEFAULT[key];

    if (key === 'urls' || key === 'hosts') {
      if (!isPlainObject(v)) {
        errors.push(key + ' 必须是对象');
        continue;
      }
      const sub = {};
      for (const k of Object.keys(v)) {
        if (isHttpUrl(v[k])) sub[k] = String(v[k]).trim().replace(/\/+$/, '');
        else errors.push(key + '.' + k + ' 不是合法的 http(s) 地址，已忽略');
      }
      out[key] = sub;
    } else if (key === 'headers') {
      if (!isPlainObject(v)) {
        errors.push('headers 必须是对象');
        continue;
      }
      const sub = {};
      for (const k of Object.keys(v)) {
        if (typeof v[k] === 'string' && v[k].trim()) sub[k] = v[k].trim();
        else errors.push('headers.' + k + ' 必须是非空字符串，已忽略');
      }
      out[key] = sub;
    } else if (key === 'mixinKeyEncTab') {
      if (validMixinTab(v)) out[key] = v.slice();
      else errors.push('mixinKeyEncTab 必须是 0~63 的 64 个互不重复整数，已忽略（沿用默认表）');
    } else if (key === 'playurlParams') {
      if (isPlainObject(v)) {
        const sub = {};
        for (const k of Object.keys(v)) {
          if (typeof v[k] === 'string' || typeof v[k] === 'number') sub[k] = String(v[k]);
          else errors.push('playurlParams.' + k + ' 必须是字符串或数字，已忽略');
        }
        out[key] = sub;
      } else errors.push('playurlParams 必须是对象');
    } else if (key === 'videoQnDesc' || key === 'audioIdDesc' || key === 'codecLabel' || key === 'qrCodes' || key === 'buvidCookies') {
      if (isPlainObject(v)) {
        const sub = {};
        for (const k of Object.keys(v)) sub[k] = v[k];
        out[key] = sub;
      } else errors.push(key + ' 必须是对象');
    } else if (key === 'douyin') {
      const sub = sanitizeDouyin(v, errors);
      if (sub) out[key] = sub;
    } else if (key === 'shortLinkRegex') {
      if (typeof v === 'string' && v.trim()) {
        try {
          new RegExp(v);
          out[key] = v;
        } catch (e) {
          errors.push('shortLinkRegex 不是合法正则，已忽略：' + e.message);
        }
      } else errors.push('shortLinkRegex 必须是非空字符串');
    } else if (key === '_comment') {
      if (typeof v === 'string') out[key] = v;
    } else if (key === 'wbiKeyCacheMs') {
      if (Number.isFinite(v) && v >= 0) out[key] = Number(v);
      else errors.push('wbiKeyCacheMs 必须是非负数，已忽略');
    } else if (key === 'structVersion') {
      // 只读，忽略用户指定
    } else {
      out[key] = v;
    }
  }

  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULT)) errors.push('未知字段 ' + k + '（已忽略）');
  }
  return { value: out, errors };
}

/** 深合并：对象递归，数组/标量直接替换 */
function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    if (isPlainObject(patch[k]) && isPlainObject(base[k])) out[k] = mergeDeep(base[k], patch[k]);
    else out[k] = patch[k];
  }
  return out;
}

// ---------------------------------------------------------------- 载入

/** 载入结果状态，供体检脚本与「关于」页展示 */
const status = {
  overrideFile: null, // 实际查找的路径
  overrideUsed: false, // 是否成功套用了覆盖
  errors: [], // 覆盖文件的问题（人类可读）
};

function load() {
  status.overrideFile = overridePath();
  status.overrideUsed = false;
  status.errors = [];

  let patch = null;
  if (status.overrideFile && fs.existsSync(status.overrideFile)) {
    try {
      patch = JSON.parse(fs.readFileSync(status.overrideFile, 'utf8'));
    } catch (e) {
      status.errors.push('覆盖文件解析失败，已全部沿用默认值：' + e.message);
      patch = null;
    }
  }

  let merged = JSON.parse(JSON.stringify(DEFAULT));
  if (patch) {
    const { value, errors } = sanitize(patch);
    status.errors = status.errors.concat(errors);
    merged = mergeDeep(merged, value);
    status.overrideUsed = Object.keys(value).length > 0;
  }
  return merged;
}

/** 实时配置（其它模块统一从这里读） */
const api = load();

/** 重新读取覆盖文件（就地替换，已有引用继续有效） */
function reload() {
  const fresh = load();
  for (const k of Object.keys(api)) delete api[k];
  Object.assign(api, fresh);
  return api;
}

module.exports = { api, DEFAULT, status, reload, overridePath, overridePathSource, sanitize, mergeDeep, validMixinTab };
