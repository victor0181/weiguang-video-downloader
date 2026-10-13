'use strict';

/**
 * douyin.js —— 抖音解析客户端
 *
 * 与 bili.js 的根本区别：
 *  B站 的接口可以直接 fetch（带 WBI 签名即可）；
 *  抖音 从 2026 起给 /aweme/v1/web/aweme/detail/ 上了 Argus 风控，
 *  纯 HTTP 请求一律 403（"Blocked by ArgusSecurityPlugin Uifid Not Found"）。
 *
 *  所以这里换一条路：**用本程序自带的 Chromium 去请求**。
 *   ① 开一个隐藏 BrowserWindow（独立持久化分区，保留 ttwid / UIFID 设备指纹）
 *   ② 用 CDP 监听 /aweme/v1/web/aweme/detail/ 响应，把 JSON 截下来
 *   ③ 页面自己会带上合法的 a_bogus / msToken / verifyFp —— 我们不需要实现签名算法
 *
 *  这样即便抖音再改风控参数，只要页面还能播，我们就还能解析，无需改代码。
 *
 *  拿到 play_addr / bit_rate 里的直链后交给 aria2 下载（单文件 MP4，含音轨，
 *  不需要 ffmpeg 混流）。下载时必须带 Referer: https://www.douyin.com/，否则 403。
 */

const https = require('https');
const http = require('http');
const { BrowserWindow, session } = require('electron');
const { api } = require('./api');
const { safeName } = require('./bili');
const { humanSize } = require('./resolver');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIDEO_URL_RE = /https?:\/\/[^\s"'<>，。、）)]+/g;

/** 从一段分享文本里抽出第一个链接（抖音分享文案里还夹着中文和 emoji） */
function extractUrl(text) {
  const t = String(text || '').trim();
  const all = t.match(VIDEO_URL_RE);
  if (all && all.length) return all[0];
  return t;
}

/**
 * 从链接 / 文本 / 纯 ID 中提取 aweme_id
 * 兼容这些形态：
 *   https://v.douyin.com/xxxxx/                     （短链，需先展开）
 *   https://www.douyin.com/video/7687570477652446505
 *   https://www.douyin.com/note/7687570477652446505
 *   https://www.douyin.com/?modal_id=7687570477652446505
 *   https://www.iesdouyin.com/share/video/7687570477652446505/
 *   7687570477652446505                            （纯 ID）
 */
function extractAwemeId(text) {
  const t = String(text || '').trim();
  const pats = [
    /(?:video|note)\/(\d{15,})/,
    /[?&]modal_id=(\d{15,})/,
    /[?&]item_ids=(\d{15,})/,
    /^\s*(\d{15,})\s*$/,
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) return m[1];
  }
  return null;
}

/**
 * 展开短链（v.douyin.com/xxx）拿到最终地址。
 * 用 Node 原生 https 跟随跳转即可，不必动用浏览器。
 */
function httpFollow(url, headers = {}, redirects = 8) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('非法 URL：' + url));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        return resolve(httpFollow(new URL(res.headers.location, u).href, headers, redirects - 1));
      }
      resolve({ url: u.href, status: res.statusCode });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('短链展开超时')));
  });
}

/** 取二进制内容（封面等） */
function httpGetBuffer(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('非法 URL：' + url));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGetBuffer(new URL(res.headers.location, u).href, headers, redirects - 1));
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
  });
}

// ---------------------------------------------------------------- 清晰度

/** 按高度归到常见档位名 */
function heightTier(h) {
  if (h >= 2160) return '4K';
  if (h >= 1440) return '2K';
  if (h >= 1080) return '1080P';
  if (h >= 720) return '720P';
  if (h >= 540) return '540P';
  if (h >= 480) return '480P';
  if (h >= 360) return '360P';
  return h ? h + 'P' : '未知';
}

function codecOf(b) {
  if (b.is_h265) return 'H.265';
  if (b.is_bytevc1) return 'H.265'; // bytevc1 即 H.265 的字节跳动叫法
  return 'H.264';
}

/**
 * 把详情里的 bit_rate / play_addr 归一成可选档位列表。
 *
 * 抖音的 bit_rate 里有十几条，很多是「同一分辨率的不同码率」，
 * 全部铺出来对用户是噪音，所以按 (高度, 是否 H.265) 归并，每个组合保留体积最大的一条
 * （体积最大即码率最高，画质最好）。排序按「分辨率降序 → 体积降序」。
 */
function buildQualities(detail) {
  const v = (detail && detail.video) || {};
  const raw = Array.isArray(v.bit_rate) ? v.bit_rate : [];
  const buckets = new Map();

  for (const b of raw) {
    const pa = b.play_addr || {};
    const urls = (pa.url_list || []).filter(Boolean);
    if (!urls.length) continue;
    const codec = codecOf(b);
    const key = `${pa.height || 0}|${codec}`;
    const item = {
      id: Number(b.quality_type) || 0,
      gear: String(b.gear_name || ''),
      width: pa.width || 0,
      height: pa.height || 0,
      sizeBytes: Number(pa.data_size) || 0,
      bitrate: Number(b.bit_rate) || 0,
      fps: Number(b.FPS) || 0,
      codec,
      urls,
    };
    const prev = buckets.get(key);
    if (!prev || item.sizeBytes > prev.sizeBytes) buckets.set(key, item);
  }

  let list = Array.from(buckets.values());

  // 兜底：没有 bit_rate 时退回首选的 play_addr
  if (!list.length && v.play_addr && (v.play_addr.url_list || []).length) {
    list = [
      {
        id: 0,
        gear: 'play_addr',
        width: v.play_addr.width || 0,
        height: v.play_addr.height || 0,
        sizeBytes: Number(v.play_addr.data_size) || 0,
        bitrate: 0,
        fps: 0,
        codec: 'H.264',
        urls: v.play_addr.url_list.slice(),
      },
    ];
  }

  list.sort((a, b) => b.height - a.height || b.sizeBytes - a.sizeBytes);

  // id 必须是唯一的（UI 用它做选中标识）；heightTier 相同就补序号
  const used = new Map();
  return list.map((q) => {
    const label = heightTier(q.height);
    // id 用 quality_type，但同一档位重复时（不同 codec）加后缀区分
    let id = q.id;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${q.id}#${n}`)) n++;
      id = `${q.id}#${n}`;
    }
    used.set(id, true);
    q.id = id;
    q.label = label;
    q.codecLabel = `${q.codec} · ${humanSize(q.sizeBytes)}`;
    return q;
  });
}

/** 按用户选择挑一档；找不到就返回最高档 */
function pickQuality(qualities, wantId) {
  if (!qualities || !qualities.length) return null;
  const hit = qualities.find((q) => String(q.id) === String(wantId));
  return hit || qualities[0];
}

// ---------------------------------------------------------------- 主类

class DouyinClient {
  constructor() {
    this._win = null;
    this._idleTimer = null;
    this._chain = Promise.resolve();
    this._detailRe = null;
    // awemeId → { at, data }：详情短时复用（见 api.douyin.detailCacheMs 注释）
    this._cache = new Map();
  }

  get _re() {
    if (!this._detailRe) this._detailRe = new RegExp(api.douyin.detailApiRe);
    return this._detailRe;
  }

  /**
   * 串行化：抖音同一时刻只允许一个解析在跑（共用一个隐藏窗口），
   * 后来者排队。链本身不会因单次失败而断开。
   */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // ---------- 隐藏窗口 ----------

  async _ensureWindow() {
    if (this._win && !this._win.isDestroyed()) return this._win;

    // 这扇窗口只用来跑抖音自己的页面取 JSON，不需要任何系统权限。
    // 一律拒绝：通知（会变成 Windows 右下角弹窗）、摄像头/麦克风、全屏、剪贴板……
    // 只有拒绝到位，才不会从系统层面冒出任何提示框或气泡。
    try {
      const ses = session.fromPartition(api.douyin.partition);
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
    } catch (e) {
      /* ignore */
    }

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      // 不要出现在任务栏/Alt+Tab 里
      skipTaskbar: true,
      webPreferences: {
        partition: api.douyin.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 隐藏窗口默认会被 Chromium 降频，页面里的定时器/请求会被拖慢甚至停摆
        backgroundThrottling: false,
        spellcheck: false,
        // 不加载任何 preload：这个窗口只用来跑抖音自己的页面
        preload: undefined,
      },
    });

    try {
      win.setMenuBarVisibility(false);
    } catch (e) {
      /* ignore */
    }
    try {
      win.webContents.setAudioMuted(true);
      win.webContents.setBackgroundThrottling(false);
    } catch (e) {
      /* 老版本没有该方法时忽略 */
    }
    win.setSkipTaskbar(true);

    // 不跟随外链、不开新窗口（main.js 里还有一层全局兜底）
    win.webContents.setWindowOpenHandler((details) => {
      if (process.env.BD_WINDOWS_DEBUG) {
        console.log('[douyin] denied popup: ' + String((details && details.url) || '').slice(0, 160));
      }
      return { action: 'deny' };
    });

    // ---- ★ 这扇窗口绝不允许露脸 ----
    // 它加载的是抖音自己的页面，页面里的 window.open / 全屏 / beforeunload
    // 都可能让一个"小窗口"糊到用户屏幕上（调试期实测过）。
    // 这里做三道兜底，任何一道生效都会把它按回去：
    win.on('show', () => {
      try {
        win.hide();
      } catch (e) {
        /* ignore */
      }
      if (process.env.BD_WINDOWS_DEBUG) console.log('[douyin] hidden window tried to show -> re-hidden');
    });
    // 视频播放器可能自动请求全屏：全屏会强制显示窗口，必须显式退出
    win.webContents.on('enter-html-full-screen', () => {
      try {
        win.setFullScreen(false);
      } catch (e) {
        /* ignore */
      }
      try {
        win.hide();
      } catch (e) {
        /* ignore */
      }
    });
    // 页面若有 beforeunload，Electron 默认会弹一个原生"确定离开吗"对话框 —— 别弹
    win.webContents.on('will-prevent-unload', (e) => e.preventDefault());

    // ★★ Electron 的渲染进程是「懒创建」的：不先真正加载一次页面，
    //    debugger.sendCommand / executeJavaScript 会**无声挂起**（不报错也不返回）。
    //    实测 v44 必现，这里必须先跑一个空页把 renderer 激活。
    await win.loadURL('about:blank');

    const dbg = win.webContents.debugger;
    try {
      dbg.attach('1.3');
      await dbg.sendCommand('Network.enable');
      // ★★ 必须绕过 Service Worker，并禁用缓存。否则程序"用几次之后"解析会整体失效：
      //   抖音页面会注册 Service Worker，一旦它接管页面，后续的 aweme 接口就由 SW 应答，
      //   此时 CDP 的 Network.getResponseBody 会报
      //     "No data found for resource with given identifier"
      //   —— 响应体拿不到，等于一条数据都解析不出来（超时）。
      //   实测：全新用户目录能过，复用过的目录必挂；加上这两条立即恢复正常。
      //   setBypassServiceWorker 是实验性命令，老版本 Chromium 不存在，所以各自 try 一次。
      try {
        await dbg.sendCommand('Network.setBypassServiceWorker', { bypass: true });
      } catch (e) {
        if (process.env.BD_WINDOWS_DEBUG) console.log('[douyin] setBypassServiceWorker unsupported: ' + e.message);
      }
      try {
        await dbg.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
      } catch (e) {
        /* ignore */
      }
    } catch (e) {
      try {
        win.destroy();
      } catch (_) {
        /* ignore */
      }
      throw new Error('无法在隐藏窗口中启用网络调试（CDP）：' + e.message);
    }

    win.on('closed', () => {
      this._win = null;
    });
    this._win = win;
    return win;
  }

  _closeWindow() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    const win = this._win;
    this._win = null;
    if (win && !win.isDestroyed()) {
      try {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      } catch (e) {
        /* ignore */
      }
      try {
        win.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 每次用完重置空闲计时，到点销毁窗口释放内存（下次解析会重新冷启动） */
  _touchIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    const ms = Number(api.douyin.idleCloseMs) || 180000;
    this._idleTimer = setTimeout(() => this._closeWindow(), ms);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  /** 程序退出时调用 */
  destroy() {
    this._closeWindow();
    this._cache.clear();
  }

  /**
   * 拔掉持久分区里抖音注册的 Service Worker 和它的 CacheStorage。
   *
   * ★★ 现在只在「第一轮连详情请求都没发出来」时当兜底用，**不在每次解析的必经路径上**。
   *
   * 2026-10-12 的复查把它的地位改了：那一天先在真机分区上复现出
   *   `Network.getResponseBody` → "No data found for resource with given identifier"
   * —— 于是加了这个清理。但随后又量到两件事：
   *   ① `clearStorageData` 本身要花 **约 5 秒**，且把 cachestorage 清空后，抖音页面
   *      每次都得重新下全部资源，整轮解析从 7.7s 涨到 12.5s；
   *   ② 即便清了，SW 仍可能在这次解析过程中重新注册接管 —— 清理并不能根治。
   * 真正根治的是 `_detailOnce` 里那条 **抓签名 URL → session.fetch 重放** 的主通路：
   * 它走会话自己的网络栈，根本不经过页面的 Service Worker。实测不清任何东西也是
   * 7.6 / 7.7 / 8.0s 三连成功（且快了一倍）。
   *
   * 所以现在保留它作为「页面整个卡住、连请求都不发」时的最后一招，
   * 代价（5 秒）只在真的要兜底时才付。
   *
   * 只清 serviceworkers + cachestorage，**不动 cookies / Local Storage**，
   * 所以 ttwid / UIFID 设备指纹保留，不会因为"清了缓存"而重新触发风控。
   */
  async _resetServiceWorker() {
    // 调试用旁路：想复现「被 SW 接管」的原始故障时设 BD_DY_NO_SW_RESET=1
    if (process.env.BD_DY_NO_SW_RESET) return;
    try {
      const ses = session.fromPartition(api.douyin.partition);
      await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    } catch (e) {
      // 清不掉不致命（顶多退回旧行为），但留个调试痕迹
      if (process.env.BD_WINDOWS_DEBUG) console.log('[douyin] clearStorageData failed: ' + e.message);
    }
  }

  // ---------- 详情 ----------

  /** 抓一个作品的详情原始数据（aweme_detail） */
  async detail(awemeId, opts = {}) {
    const id = String(awemeId || '').trim();
    if (!/^\d{15,}$/.test(id)) throw new Error('非法的抖音作品 ID：' + awemeId);

    const ttl = Number(api.douyin.detailCacheMs) || 0;
    const hit = this._cache.get(id);
    if (!opts.force && ttl > 0 && hit && Date.now() - hit.at < ttl) {
      if (process.env.BD_WINDOWS_DEBUG) console.log('[douyin] detail 命中缓存 ' + id);
      return hit.data;
    }
    // 注意：缓存命中要放在 _serial 之前 —— 排队等窗口的活儿没必要干。
    const data = await this._serial(() => this._detailOnce(id));

    if (ttl > 0) {
      this._cache.set(id, { at: Date.now(), data });
      // 正常一次会话也就几条，超了就丢最旧的，免得长跑时留一堆
      if (this._cache.size > 20) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of this._cache) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey) this._cache.delete(oldestKey);
      }
    }
    return data;
  }

  /**
   * 丢掉某个作品的详情缓存。
   * 下载失败时由主进程调用 —— 下次重新解析会拿到**新的直链签名**，
   * 否则复用一份已失效的地址会一直失败（这正是「重试也没用」的老毛病）。
   * 不传 id 则全部清空。
   */
  invalidate(awemeId) {
    if (awemeId === undefined || awemeId === null || awemeId === '') {
      this._cache.clear();
      return;
    }
    this._cache.delete(String(awemeId).trim());
  }

  async _detailOnce(awemeId) {
    const win = await this._ensureWindow();
    const dbg = win.webContents.debugger;
    const ses = win.webContents.session;
    const debug = !!process.env.BD_WINDOWS_DEBUG;

    let found = null;
    let notFound = false;
    let bodyFails = 0;
    let signedUrl = null; // 页面自己发出的那条「已签名详情 URL」
    let lastReplayed = null;
    let replayErr = null;

    const onNav = (_e, url) => {
      // 抖音把「取不到的作品」重定向到精选页并带这个标记
      if (/web_video_404_link/.test(url)) notFound = true;
    };

    /**
     * ★★ 主通路：把 CDP 抓到的「页面自己发出去的已签名 URL」用 session.fetch 原样重放。
     *
     * 为什么要这样做（2026-10-12 二次定位）：
     *   原先只靠 CDP 的 Network.getResponseBody 读响应体。可一旦页面的 Service Worker
     *   接管了 aweme/detail 接口，它就会报
     *     "No data found for resource with given identifier"
     *   —— 一条详情都读不到，两轮跑满 40s 判失败。用户看到的现象就是
     *   「偶尔解析失败、弹一大段话，多点几次又好了」。
     *
     *   而 session.fetch 走的是会话自己的网络栈，**完全不经过页面的 Service Worker**，
     *   重放这条已签名的 URL 实测 0.3s 左右就能拿到完整 JSON（约 115KB）。
     *
     *   签名由页面生成，我们只是复用同一条 URL，不涉及任何逆向。
     */
    const replay = async (url) => {
      try {
        const res = await ses.fetch(url, {
          headers: api.douyin.headers,
          referrer: 'https://www.douyin.com/',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        const j = JSON.parse(txt);
        const d = j && j[api.douyin.detailField];
        if (debug) console.log('[douyin] session.fetch 重放: ' + (d ? '拿到详情' : 'aweme_detail 为空'));
        return d || null;
      } catch (e) {
        replayErr = e;
        if (debug) console.log('[douyin] session.fetch 重放失败: ' + e.message);
        return null;
      }
    };

    const onReq = (_e, method, params) => {
      if (method !== 'Network.requestWillBeSent') return;
      const url = (params.request && params.request.url) || '';
      if (!this._re.test(url)) return;
      if (!signedUrl) {
        signedUrl = url;
        if (debug) console.log('[douyin] 捕获到详情请求 URL（' + url.length + ' 字符）');
      }
      // 同一个 URL 只重放一次；页面每轮导航都会重新签一次名，换了 URL 就再试一次
      if (url === lastReplayed) return;
      lastReplayed = url;
      replay(url).then((d) => {
        if (d && !found) found = d;
      });
    };

    const onMsg = async (_e, method, params) => {
      if (method !== 'Network.responseReceived') return;
      const url = (params.response && params.response.url) || '';
      if (!this._re.test(url)) return;
      try {
        const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        const j = JSON.parse(body);
        // 注意：页面会先打一次 aweme_detail=null 的空响应，只有非空那次才是我们要的
        const d = j && j[api.douyin.detailField];
        if (d) found = d;
      } catch (e) {
        // 单条响应体读不到不致命（主通路会兜住），继续等下一次。
        // 但这类失败通常意味着"响应体取不到"（SW/缓存接管、或资源已被回收），
        // 只计数不报错会变成无声超时，所以记一笔，超时信息里会带上次数。
        bodyFails++;
        if (debug) console.log('[douyin] getResponseBody failed: ' + e.message);
      }
    };

    win.webContents.on('did-navigate', onNav);
    dbg.on('message', onReq);
    dbg.on('message', onMsg);

    const started = Date.now();
    const total = Number(api.douyin.parseTimeoutMs) || 40000;
    const grace = Number(api.douyin.notFoundGraceMs) || 8000;
    try {
      // ★★ 每一轮都先退回 about:blank，再进视频页。
      //
      // 为什么不能省：抖音是 SPA，对「同一个 URL 再导航一次」它会直接复用内存里的数据、
      // **根本不发详情请求**（实测：第二次解析必然 40s 超时）。而"下载阶段取流地址"就是
      // 在同一个视频 URL 上做二次解析 —— 正好踩中，表现是卡片直接变 error。
      // 加一次空白页跳转后，第二次解析恢复到 ~3s。
      //
      // 之所以还循环两轮：偶尔页面连一次详情请求都不发，多给一次机会。
      // 每轮各分一半时间（不少于 12s），整体仍受 parseTimeoutMs 约束。
      for (let attempt = 1; attempt <= 2 && !found; attempt++) {
        // ★ 兜底：只有第一轮页面**连一条详情请求都没发出来**（signedUrl 仍为空）时，
        //   才值得把分区里的 Service Worker 拔掉重来（见 _resetServiceWorker）。
        //   主通路 session.fetch 根本不走 SW，所以正常情况用不到 ——
        //   而这一步实测要花约 5 秒（clearStorageData 本身很慢），不能放在必经路径上。
        if (attempt > 1 && !signedUrl) await this._resetServiceWorker();

        // 不 await：抖音页面资源极多，did-finish-load 可能迟迟不来，
        // 而我们只需要它发出 detail 请求。跳转被打断（ERR_ABORTED）属正常。
        win.loadURL('about:blank').catch(() => {});
        await sleep(150);
        win.loadURL(api.douyin.urls.videoPage + awemeId).catch(() => {});

        const attemptEnd = Math.min(started + total, Date.now() + Math.max(12000, Math.floor(total / 2)));
        while (Date.now() < attemptEnd) {
          if (found) break;
          // 判定 404 后再宽限一会儿：SPA 首跳可能被误标，等一等也许还有数据
          if (notFound && Date.now() - started > grace) break;
          await sleep(250);
        }
        // 已确认作品不存在就没必要再试
        if (notFound && !found) break;
      }
    } finally {
      win.webContents.removeListener('did-navigate', onNav);
      dbg.removeListener('message', onReq);
      dbg.removeListener('message', onMsg);
      this._touchIdle();
    }

    if (found) return found;
    if (notFound) {
      const err = new Error('抖音返回：作品不存在或已被删除');
      err.code = 'NOT_FOUND';
      throw err;
    }
    // 超时信息里带上「卡在哪一步」，避免用户只看到一句含糊的"网络慢"
    const diag = [
      signedUrl ? '页面已发出详情请求' : '页面未发出详情请求',
      bodyFails ? `${bodyFails} 次响应体读取失败` : '',
      replayErr ? `重放失败：${String(replayErr.message).slice(0, 50)}` : '',
    ]
      .filter(Boolean)
      .join('，');
    throw new Error(
      `解析抖音详情超时（${Math.round(total / 1000)} 秒）：未能取到作品数据。` +
        `通常是网络较慢或触发了抖音的验证页，稍等几秒再点一次「解析」通常即可。（${diag}）`
    );
  }

  // ---------- 对外：解析链接 ----------

  /**
   * @param {string} input 分享文本 / 长短链接 / 纯 aweme_id
   * @returns {Promise<object>} 统一 media 结构（platform='douyin'）
   */
  async resolve(input) {
    const raw = extractUrl(input);
    if (!raw) throw new Error('请输入抖音视频链接或分享文本');

    // 短链先展开；展开失败也不致命（也许输入本身就是长链）
    let finalUrl = raw;
    let awemeId = extractAwemeId(raw);
    let shortErr = null;
    if (!awemeId && new RegExp(api.douyin.shortLinkRegex, 'i').test(raw)) {
      // ★ 重试一次：单次网络抖动不该直接判死（与启动体检的「单轮失败不下结论」同一套纪律）。
      //   还要注意：httpFollow 走的是 Node 原生 https，**不继承系统代理**，
      //   所以展开失败很可能是网络/代理问题，而不是链接不完整 —— 报错时要说清楚。
      for (let i = 0; i < 2 && !awemeId; i++) {
        try {
          const r = await httpFollow(raw, api.douyin.headers);
          finalUrl = r.url || raw;
          awemeId = extractAwemeId(finalUrl);
        } catch (e) {
          shortErr = e;
          if (i === 0) await sleep(300);
        }
      }
    }
    if (!awemeId) {
      if (shortErr) {
        throw new Error(
          `短链展开失败（${shortErr.message}）——请检查网络或代理设置；` +
            '也可以直接粘贴完整长链（含 /video/ 后的一串数字）试试'
        );
      }
      throw new Error('未能从链接中识别出抖音作品 ID，请检查链接是否完整');
    }

    const detail = await this.detail(awemeId);
    // 输入可能只是裸 ID（或短链没展开成功），这时最终地址是无意义的字符串。
    // sourceUrl 是要写进下载记录、供「复制视频链接」使用的，必须是一个真实可点的 URL。
    const looksLikeUrl = /^https?:\/\//i.test(finalUrl) && finalUrl.indexOf(awemeId) >= 0;
    return buildMedia(detail, looksLikeUrl ? finalUrl : api.douyin.urls.videoPage + awemeId);
  }

  /** 封面等图片资源（抖音图床不校验 Referer，带上更稳） */
  fetchCover(url) {
    let u = String(url || '');
    if (u.startsWith('//')) u = 'https:' + u;
    u = u.replace(/^http:\/\//i, 'https://');
    return httpGetBuffer(u, api.douyin.headers);
  }

  /**
   * 取一个「当前有效」的作品 ID：打开抖音入口页，从推荐流响应里抓第一个 aweme_id。
   *
   * 为什么需要它：抖音的老作品随时可能被作者删除/下架，而写死在自检里的
   * 示例链接过一阵就会失效，导致自检"无缘无故"变红。动态取样本可以避免这种假失败。
   *
   * ★ 为什么要试多个入口：抖音对匿名用户并不总是下发推荐流 ——
   *   裸首页会跳到 /jingxuan（精选），经常只回一句"暂时没有更多了"（空 feed）。
   *   实测同一用户目录下裸首页为空、而 ?recommend=1 能一次给回 27 条，
   *   所以按 recommend → home 的顺序各试一轮，谁先给出 ID 就用谁。
   */
  async sampleAwemeId() {
    return this._serial(async () => {
      const win = await this._ensureWindow();
      // 推荐流（feed 接口）同样会被 SW 接管，取样前也拔一次
      await this._resetServiceWorker();
      const dbg = win.webContents.debugger;
      const entries = [api.douyin.urls.recommend, api.douyin.urls.home, api.douyin.urls.recommend].filter(
        Boolean
      );

      for (const entry of entries) {
        const id = await this._sampleFrom(win, dbg, entry);
        if (id) return id;
      }
      return null;
    });
  }

  /** 打开一个入口页，在观察窗口内等推荐流给出 aweme_id */
  async _sampleFrom(win, dbg, entry) {
    let id = null;

    const onMsg = async (_e, method, params) => {
      if (id || method !== 'Network.responseReceived') return;
      const url = (params.response && params.response.url) || '';
      if (!/aweme\/v\d\/web\/(module\/feed|tab\/feed)/.test(url)) return;
      try {
        const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        const m = /"aweme_id"\s*:\s*"(\d{15,})"/.exec(body);
        if (m) id = m[1];
      } catch (e) {
        // 空 feed / 响应体已被回收都会走到这里，属正常，换下一条或下一个入口
        if (process.env.BD_WINDOWS_DEBUG) console.log('[douyin] sample getResponseBody failed: ' + e.message);
      }
    };

    dbg.on('message', onMsg);
    try {
      // 同样先退回空白页：见 _detailOnce 的说明（SPA 对同 URL 二次导航不发请求）
      win.loadURL('about:blank').catch(() => {});
      await sleep(150);
      win.loadURL(entry).catch(() => {});
      const deadline = Date.now() + (Number(api.douyin.sampleWaitMs) || 12000);
      while (Date.now() < deadline && !id) await sleep(250);
    } finally {
      dbg.removeListener('message', onMsg);
      this._touchIdle();
    }
    return id;
  }
}

// ---------------------------------------------------------------- 归一化

/**
 * aweme_detail → 统一 media 结构
 *
 * 与 B站 的差异（下游按 platform 区分，不要混用）：
 *   - 单视频，没有分P / 合集概念
 *   - 音视频在同一个 MP4 里，所以没有「音质」选项
 *   - 没有弹幕、没有 CC 字幕
 */
function buildMedia(detail, sourceUrl) {
  const v = detail.video || {};
  const author = detail.author || {};
  const st = detail.statistics || {};
  const images = Array.isArray(detail.images) ? detail.images : [];

  if (images.length) {
    const err = new Error('这是图文（图集）作品，当前版本暂不支持下载，仅支持视频作品');
    err.code = 'UNSUPPORTED_IMAGE';
    throw err;
  }

  const qualities = buildQualities(detail);
  if (!qualities.length) throw new Error('未获取到可用的视频播放地址');

  const rawTitle = String(detail.desc || '').trim();
  const title = rawTitle || `douyin_${detail.aweme_id}`;

  const face = ((author.avatar_thumb || author.avatar_168x168 || author.avatar_larger || {}).url_list || [])[0] || '';

  return {
    platform: 'douyin',
    awemeId: String(detail.aweme_id || ''),
    sourceUrl: sourceUrl || api.douyin.urls.videoPage + detail.aweme_id,

    title,
    cover: ((v.origin_cover || v.cover || {}).url_list || [])[0] || '',
    desc: rawTitle,
    pubdate: Number(detail.create_time) || 0,
    duration: Math.round((Number(v.duration) || 0) / 1000),
    tname: '抖音',

    up: { mid: author.uid || author.sec_uid || '', name: author.nickname || '未知作者', face },
    stat: {
      view: Number(st.play_count) || 0,
      like: Number(st.digg_count) || 0,
      comment: Number(st.comment_count) || 0,
      collect: Number(st.collect_count) || 0,
      share: Number(st.share_count) || 0,
      // 抖音没有这几项，补 0 是为了让渲染层能统一处理
      danmaku: 0,
      coin: 0,
      favorite: Number(st.collect_count) || 0,
      reply: Number(st.comment_count) || 0,
    },

    type: '抖音视频',
    qualities,
    parts: [
      {
        index: 1,
        sectionTitle: '',
        title,
        part: '',
        duration: Math.round((Number(v.duration) || 0) / 1000),
        cover: ((v.origin_cover || v.cover || {}).url_list || [])[0] || '',
        pubdate: Number(detail.create_time) || 0,
      },
    ],

    // 与 B站 media 结构对齐的占位字段（下游有按统一字段读取的地方）
    bvid: '',
    aid: '',
    cid: 0,
    seasonId: null,
    seasonTitle: '',
    requestedPage: null,
  };
}

/** 供命名规则使用：{aweme} / {author} 等抖音专有变量 */
function douyinNameVars(media) {
  return {
    title: safeName(media.title),
    up: safeName(media.up.name),
    uid: media.up.mid,
    aweme: media.awemeId,
    date: '',
    type: media.type,
  };
}

module.exports = {
  DouyinClient,
  extractUrl,
  extractAwemeId,
  buildMedia,
  buildQualities,
  pickQuality,
  heightTier,
  douyinNameVars,
  httpGetBuffer,
};
