'use strict';

/**
 * bili.js —— B站 API 封装
 *
 * 与旧版相比的两点关键改进：
 *  1. 所有请求走 Electron 的 `session.fetch()`（Chromium 网络栈），
 *     登录后的 Cookie 由 session 自动持有与携带，无需手工拼装 Cookie 串；
 *     同时天然继承系统代理设置。
 *  2. 完整实现 WBI 签名（w_rid / wts），避免 wbi 系接口被风控降级。
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { api } = require('./api');

// 「与 B站 之间的约定」（接口地址 / 请求头 / WBI 混淆表 / 画质对照表）一律从 api.js 读取。
// 升级时只改 api.js 一个文件，或放一个 api-override.json 覆盖（无需重新打包程序）。
// 注意：这里刻意使用 api.xxx 的实时引用，而不是 require 时解构出的副本，
// 这样 reload() 之后立即生效。

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * 用 Node 原生 https 直接取二进制内容。
 *
 * 为什么不走 Electron 的 session.fetch？
 *  - 弹幕接口返回的 body 是被 deflate 压缩的裸数据（且不带正确的 Content-Encoding），
 *    Chromium 会在底层尝试解码并抛出 ERR_CONTENT_DECODING_FAILED；
 *  - 封面图等 http:// 资源也可能被 Chromium 的混合内容策略拦掉（ERR_BLOCKED_BY_CLIENT）。
 * Node 默认不发送 Accept-Encoding，拿到的就是原始未压缩字节，完全可控。
 *
 * @param {string} url
 * @param {object} [headers]
 * @param {number} [redirects]
 * @returns {Promise<Buffer>}
 */
function httpGetBuffer(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('非法 URL：' + url));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      u,
      {
        headers: Object.assign(
          { 'User-Agent': api.headers['User-Agent'], Referer: api.headers.Referer },
          headers
        ),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(httpGetBuffer(new URL(res.headers.location, u).href, headers, redirects - 1));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
  });
}

// ---------------------------------------------------------------- 画质映射
// 三张对照表都在 api.js 里，可通过 api-override.json 覆盖。

function qnDesc(id) {
  return api.videoQnDesc[id] || `qn${id}`;
}
function audioDesc(id) {
  return api.audioIdDesc[id] || `audio${id}`;
}
function codecLabel(codecs) {
  const k = String(codecs || '').split('.')[0];
  return api.codecLabel[k] || k;
}

// ---------------------------------------------------------------- 工具

function parseCookieString(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// 只保留字母/数字/下划线，用于文件名安全化
function safeName(s, fallback = 'untitled') {
  const t = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return t || fallback;
}

// ---------------------------------------------------------------- 主类

class BiliClient {
  /**
   * @param {Electron.Session} session 用于发请求的 Electron session（自动管理 Cookie）
   */
  constructor(session) {
    this.ses = session;
    this._wbi = null; // { imgKey, subKey, mixinKey, ts }
    this._buvidReady = false;
  }

  // ---------- 底层请求 ----------

  async _fetch(url, opts = {}) {
    const headers = Object.assign({}, api.headers, opts.headers || {});
    const res = await this.ses.fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      credentials: 'include',
      redirect: 'follow',
    });
    return res;
  }

  async _json(url, opts = {}) {
    const res = await this._fetch(url, opts);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`接口返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  // ---------- 设备指纹（让未登录状态也能取到基础数据） ----------

  async ensureBuvid() {
    if (this._buvidReady) return;
    try {
      const r = await this._json(api.urls.spi);
      const d = r && r.data;
      if (d && d.b_3) {
        // 写回 session，后续请求自动携带
        const urls = [api.hosts.www, api.hosts.api, api.hosts.passport];
        const name3 = api.buvidCookies.device;
        const name4 = api.buvidCookies.device4;
        for (const u of urls) {
          await this.ses.cookies
            .set({ url: u, name: name3, value: d.b_3, domain: '.bilibili.com', path: '/' })
            .catch(() => {});
          if (d.b_4) {
            await this.ses.cookies
              .set({ url: u, name: name4, value: d.b_4, domain: '.bilibili.com', path: '/' })
              .catch(() => {});
          }
        }
      }
    } catch (e) {
      /* 非致命，忽略 */
    }
    this._buvidReady = true;
  }

  // ---------- WBI 签名 ----------

  async getWbiKeys(force = false) {
    const now = Date.now();
    if (!force && this._wbi && now - this._wbi.ts < api.wbiKeyCacheMs) return this._wbi;

    const nav = await this._json(api.urls.nav);
    const wbiImg = (nav && nav.data && nav.data.wbi_img) || {};
    const pick = (u) => String(u || '').split('/').pop().split('.')[0];
    const imgKey = pick(wbiImg.img_url);
    const subKey = pick(wbiImg.sub_url);
    if (!imgKey || !subKey) throw new Error('无法获取 WBI 密钥（nav 接口未返回 wbi_img）');

    const orig = imgKey + subKey;
    const mixinKey = api.mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32);
    this._wbi = { imgKey, subKey, mixinKey, ts: now };
    return this._wbi;
  }

  async encWbi(params) {
    const { mixinKey } = await this.getWbiKeys();
    const wts = Math.round(Date.now() / 1000);
    const all = Object.assign({}, params, { wts });
    const keys = Object.keys(all).sort();
    const query = keys
      .map((k) => {
        const v = String(all[k] == null ? '' : all[k]).replace(/[!'()*]/g, '');
        return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
      })
      .join('&');
    const w_rid = md5(query + mixinKey);
    return Object.assign({}, all, { w_rid });
  }

  async wbiGet(baseUrl, params) {
    const signed = await this.encWbi(params);
    const qs = Object.keys(signed)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(signed[k])}`)
      .join('&');
    return this._json(`${baseUrl}?${qs}`);
  }

  // ---------- 登录 ----------

  async loginQrGenerate() {
    await this.ensureBuvid();
    const r = await this._json(api.urls.qrGenerate);
    if (r.code !== 0) throw new Error(r.message || '二维码获取失败');
    return { url: r.data.url, qrcodeKey: r.data.qrcode_key };
  }

  /**
   * 轮询扫码结果
   * @returns {{state:'waiting'|'scanned'|'expired'|'success', message:string}}
   */
  async loginQrPoll(qrcodeKey) {
    const r = await this._json(
      `${api.urls.qrPoll}?qrcode_key=${encodeURIComponent(qrcodeKey)}`
    );
    const C = api.qrCodes;
    const code = r && r.data ? r.data.code : -1;
    if (code === C.success) return { state: 'success', message: r.data.message || '登录成功' };
    if (code === C.scanned) return { state: 'scanned', message: '已扫码，等待确认…' };
    if (code === C.expired) return { state: 'expired', message: '二维码已过期' };
    if (code === C.waiting) return { state: 'waiting', message: '等待扫码中…' };
    return { state: 'waiting', message: r.message || `未知状态 (${code})` };
  }

  async nav() {
    await this.ensureBuvid();
    const r = await this._json(api.urls.nav);
    return r.data || { isLogin: false };
  }

  async userInfo() {
    const nav = await this.nav();
    if (!nav.isLogin) return { isLogin: false };
    return {
      isLogin: true,
      mid: nav.mid,
      name: nav.uname,
      face: nav.face,
      vip: !!(nav.vipStatus === 1 || (nav.vipStatus !== undefined && nav.vipStatus > 0)),
      vipLabel: (nav.vip_label && nav.vip_label.text) || '',
      level: nav.level_info ? nav.level_info.current_level : 0,
      coins: nav.money || 0,
    };
  }

  async logout() {
    await this.ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
    this._wbi = null;
    this._buvidReady = false;
  }

  // ---------- 视频信息 ----------

  async videoInfo(bvid) {
    const r = await this._json(
      `${api.urls.view}?bvid=${encodeURIComponent(bvid)}`
    );
    if (r.code !== 0) {
      const err = new Error(r.message || '获取视频信息失败');
      err.code = r.code;
      throw err;
    }
    return r.data;
  }

  /** 视频详情（含合集、UP 主信息、相关推荐） */
  async videoDetail(bvid) {
    const r = await this._json(
      `${api.urls.viewDetail}?bvid=${encodeURIComponent(bvid)}`
    );
    if (r.code !== 0) {
      const err = new Error(r.message || '获取视频详情失败');
      err.code = r.code;
      throw err;
    }
    return r.data;
  }

  /** 合集（UGC 赛季）视频列表 */
  async seasonArchives(seasonId, mid) {
    const url = `${api.urls.seasonArchives}?season_id=${encodeURIComponent(
      seasonId
    )}&sort_reverse=false&page_num=1&page_size=100&mid=${encodeURIComponent(mid)}`;
    const r = await this._json(url);
    if (r.code !== 0) return { archives: [] };
    return r.data || { archives: [] };
  }

  /**
   * 取播放地址（DASH）
   * fnval=4048 会同时开启 DASH + Dolby + HDR + 4K + AV1（参数见 api.js 的 playurlParams）
   */
  async playurl(bvid, cid, qn = 127) {
    const extra = Object.keys(api.playurlParams)
      .map((k) => `&${encodeURIComponent(k)}=${encodeURIComponent(api.playurlParams[k])}`)
      .join('');
    const url =
      `${api.urls.playurl}?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${encodeURIComponent(cid)}&qn=${qn}${extra}`;
    const r = await this._json(url);
    if (r.code !== 0) {
      const err = new Error(r.message || '获取播放地址失败');
      err.code = r.code;
      throw err;
    }
    return r.data;
  }

  /**
   * 取「渐进流」（durl）播放地址。
   *
   * 用途：极少数视频的 DASH 响应里一个音轨都没返回（多见于部分老视频、
   * 番剧/付费内容），此时「只下载音频」就没音轨可挑了。这里用 fnval=1
   * 走非 DASH 的 mp4 渐进流兜底 —— 整段下下来再抽音轨，总比直接失败强。
   *
   * 注意 qn 取低档（默认 480P）：渐进流画质无关紧要，我们只要里面的音轨，
   * 低档体积小、且不像高码率那样动不动要登录/会员。
   *
   * @param {string} bvid
   * @param {number} cid
   * @param {number} [qn=32]
   */
  async playurlProgressive(bvid, cid, qn = 32) {
    const url =
      `${api.urls.playurl}?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${encodeURIComponent(cid)}&qn=${qn}&fnver=0&fnval=1&fourk=0`;
    const r = await this._json(url);
    if (r.code !== 0) {
      const err = new Error(r.message || '获取播放地址失败');
      err.code = r.code;
      throw err;
    }
    return r.data;
  }

  /** 播放器附加信息（含 CC 字幕列表）——需要 WBI 签名 */
  async playerWbi(aid, cid) {
    try {
      return await this.wbiGet(api.urls.playerWbi, { aid, cid });
    } catch (e) {
      // 退回不带签名的旧接口
      return this._json(`${api.urls.playerV2}?aid=${aid}&cid=${cid}`);
    }
  }

  /** 字幕内容（JSON） */
  async subtitleContent(url) {
    const u = url.startsWith('//') ? 'https:' + url : url;
    return this._json(u);
  }

  // ---------- 弹幕 ----------

  /** 旧版 XML 弹幕（body 多为 deflate 裸压缩，需手动解压） */
  async danmakuXml(cid) {
    const zlib = require('zlib');
    const buf = await httpGetBuffer(
      `${api.urls.danmaku}?oid=${encodeURIComponent(cid)}`
    );

    const tryInflate = (fn) => {
      try {
        const out = fn(buf);
        if (out && out.length) return out;
      } catch (e) {
        /* 换下一种 */
      }
      return null;
    };

    let xml = buf;
    const head = buf.slice(0, 64).toString('utf8');
    if (!head.includes('<?xml') && !head.includes('<i>')) {
      xml =
        tryInflate((b) => zlib.inflateRawSync(b)) ||
        tryInflate((b) => zlib.inflateSync(b)) ||
        tryInflate((b) => zlib.gunzipSync(b)) ||
        buf;
    }

    const text = xml.toString('utf8');
    if (!text.includes('<d ') && !text.includes('<i>')) {
      throw new Error('弹幕内容解析失败（未识别到 XML 结构）');
    }
    return text;
  }

  // ---------- 封面 ----------

  async fetchCover(url) {
    // B站返回的封面地址多是 http://i0.hdslb.com/...，统一升到 https 更稳
    let u = url.startsWith('//') ? 'https:' + url : url;
    u = u.replace(/^http:\/\//i, 'https://');
    return httpGetBuffer(u);
  }

  // ---------- 启动体检 ----------

  /**
   * 「环境类」异常判定：请求确实失败了，但**不是** B站 改了接口约定。
   *
   * 这类失败一律静默，绝不弹「接口可能已变更」——否则用户会被毫无意义的提示反复打扰：
   *   - 返回非 JSON：运营商劫持页 / 校园网 Portal / 安全软件 HTTPS 拦截 / 代理错误页
   *   - HTTP 5xx：B站 自己抽风
   *   - 风控码：-352 风控校验失败、-412 请求被拦截、-509 超出限速、-799 请求过于频繁、
   *     -101 未登录、-403 权限不足/被拦
   *
   * @param {any} e 异常对象（也可以只带 code，例如 { code: -352 }）
   */
  _isEnvErr(e) {
    const msg = String((e && e.message) || e);
    // 中间设备给了个非 JSON 的页面（劫持/Portal/拦截/代理错误页）
    if (/接口返回非 JSON/.test(msg)) return true;
    // 服务端 5xx：是对方抽风，不是约定变了
    const m = msg.match(/HTTP\s+(\d{3})/);
    if (m && Number(m[1]) >= 500) return true;
    // 风控 / 限流 / 未授权
    const code = e && e.code;
    return typeof code === 'number' && [-352, -412, -509, -799, -101, -403].indexOf(code) >= 0;
  }

  /** 网络层异常（连不上 / 超时 / DNS）——也算环境问题 */
  _isNetErr(e) {
    return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timeout|net::|socket/i.test(
      String((e && e.message) || e)
    );
  }

  /**
   * 「这条错误不该弹预警条」的合并判定：网络层 或 环境层（风控 / 劫持 / 5xx / 未授权）。
   * ★ 判定心法：宁可少报 —— 拿不准就归环境类静默，绝不用无意义的提示打扰用户。
   */
  _isEnv(e) {
    return this._isNetErr(e) || this._isEnvErr(e);
  }

  /**
   * 拿单个稿件走一遍 view → playurl。
   *
   * ★ 为什么要「逐个试」而不是只取第一条：
   *   热门列表里会混进番剧 / 影视 / 付费课程 / 需登录 / 互动视频，对这类稿件
   *   view 会回 -404、playurl 拿不到 dash —— 这些**都是正常现象**，不能当成
   *   「B站 改了接口」。原来只取 `ps=1` 的第一条，一旦恰好抽中它，两轮都一样失败，
   *   就会稳定误报（用户看到的现象：一启动就弹条）。
   *
   * @returns {Promise<{ok:boolean, name?:string, key?:string, detail?:string, env?:boolean}>}
   */
  async _probeSample(bvid) {
    const brief = (e) => String((e && e.message) || e).slice(0, 110);

    let cid = 0;
    try {
      const v = await this.videoInfo(bvid);
      if (v && v.cid) cid = v.cid;
      else return { ok: false, name: '视频信息 view', key: 'urls.view', detail: '返回中缺少 cid 字段', env: false };
    } catch (e) {
      // videoInfo 会带上业务错误码：说明接口通了但拒绝了这条稿件（抽样问题，不是接口变了）
      return { ok: false, name: '视频信息 view', key: 'urls.view', detail: brief(e), env: this._isEnv(e) };
    }

    try {
      const d = await this.playurl(bvid, cid, 32);
      const hasTracks = !!(
        d &&
        d.dash &&
        d.dash.video &&
        d.dash.video.length &&
        d.dash.audio &&
        d.dash.audio.length
      );
      if (!hasTracks) {
        return {
          ok: false,
          name: '播放地址 playurl',
          key: 'urls.playurl / playurlParams',
          detail: '未返回 dash 音视频轨',
          env: false,
        };
      }
    } catch (e) {
      return { ok: false, name: '播放地址 playurl', key: 'urls.playurl / playurlParams', detail: brief(e), env: this._isEnv(e) };
    }

    return { ok: true };
  }

  /**
   * 跑一轮完整探测，只收集、不判定、不重试。
   *
   *   failed    = 接口有响应但内容不符合预期（可能是 B站 改了约定）
   *   netFailed = 网络层 / 环境层问题（断网、风控、中间设备、服务端抽风）
   *
   * @param {number} [page=1] 取样本用哪一页热门（第二轮换一页，避免同一批样本重复踩雷）
   * @returns {Promise<{failed:Array<{name:string,key:string,detail:string}>, netFailed:Array}>}
   */
  async _probeOnce(page = 1) {
    const failed = []; // 疑似「接口变了」
    const netFailed = []; // 环境问题，不该打扰用户
    /** 只要沾上「网络层」或「环境层」，就归 netFailed，不弹条 */
    const isEnv = (e) => this._isEnv(e);
    const brief = (e) => String((e && e.message) || e).slice(0, 110);
    const push = (name, key, detail, net) => {
      (net ? netFailed : failed).push({ name, key, detail });
    };

    // 1) 设备指纹（不带会被风控 -352）
    try {
      const r = await this._json(api.urls.spi);
      if (!(r && r.code === 0 && r.data && r.data.b_3)) {
        push(
          '设备指纹 spi',
          'urls.spi',
          (r && r.message) || '未返回 buvid',
          this._isEnvErr({ code: r && r.code })
        );
      }
    } catch (e) {
      push('设备指纹 spi', 'urls.spi', brief(e), isEnv(e));
    }

    // 2) WBI 密钥（nav → wbi_img → mixinKey）
    try {
      await this.getWbiKeys(true);
    } catch (e) {
      push('WBI 密钥', 'urls.nav / mixinKeyEncTab', brief(e), isEnv(e));
    }

    // 3) 取样本候选（多取几条：热门里会混进番剧 / 付费 / 需登录的稿件，
    //    对它们拿不到 dash 属正常现象，见 _probeSample 注释）
    let cands = [];
    try {
      const r = await this._json(`${api.urls.popular}?ps=10&pn=${page}`);
      const list = (r && r.data && r.data.list) || [];
      cands = list.map((it) => it && it.bvid).filter(Boolean);
      if (!(r && r.code === 0) || !cands.length) {
        push(
          '取样接口',
          'urls.popular',
          (r && r.message) || '未返回样本视频',
          this._isEnvErr({ code: r && r.code })
        );
      }
    } catch (e) {
      push('取样接口', 'urls.popular', brief(e), isEnv(e));
    }

    // 4)+5) 逐个候选走 view → playurl。
    //   只要**有一条**能完整走通，就说明接口链路是好的 —— 抽样踩雷不算接口变更。
    if (cands.length) {
      let good = false;
      let firstBad = null;
      let firstEnvBad = null;
      for (const bv of cands) {
        const r = await this._probeSample(bv);
        if (r.ok) {
          good = true;
          break;
        }
        if (!firstBad) firstBad = r;
        if (r.env && !firstEnvBad) firstEnvBad = r;
      }
      if (!good) {
        // 候选全灭：其中只要有一条是环境类问题，就按环境类静默（宁可少报）
        const pick = firstEnvBad || firstBad;
        if (pick) push(pick.name, pick.key, pick.detail, !!pick.env);
      }
    }

    return { failed, netFailed };
  }

  /**
   * 轻量接口体检：程序启动时后台跑一次，用于尽早发现「B站 改了接口」。
   *
   * 刻意复用真实的调用链（spi → WBI → view → playurl），而不是另写一套探测代码，
   * 这样「体检通过」就等于「用户实际操作也能走通」。
   *
   * ★ 2026-10-12 加固：单轮失败不再直接下结论。
   *   启动瞬间最容易抖（抢带宽、DNS 抖、被临时风控），原来「失败一次就弹条」误报率偏高。
   *   现在：① 环境类错误（风控/劫持/5xx）直接静默；
   *         ② 剩余失败项隔 1.5 秒重跑一轮，**两轮都失败的同一环节**才认定「接口已变更」；
   *         ③ 取样从「只看热门第一条」改成「10 条候选逐个试」，且第二轮换一页取样 ——
   *            热门列表里混着番剧/付费/需登录稿件，抽中它对 playurl 拿不到 dash 是正常的，
   *            绝不因此弹条（这是用户反馈「每次启动都弹」的真正来源）。
   *
   * @returns {Promise<{ok:boolean, kind:'ok'|'offline'|'changed', failed:Array<{name:string,key:string,detail:string}>, netFailed:Array, checkedAt:number}>}
   */
  async healthCheck() {
    const r1 = await this._probeOnce();
    let failed = r1.failed;
    const netFailed = r1.netFailed.slice();

    if (failed.length) {
      await new Promise((res) => setTimeout(res, 1500));
      // ★ 第二轮刻意换一页热门取样（page=2）：不同样本集合。
      //   这样「同一个稿件恰好不可用」不可能让两轮都失败 —— 两轮都失败只能是真的系统性故障。
      const r2 = await this._probeOnce(2);
      // 只保留「两轮都失败」的环节：单轮偶发不算数
      failed = r2.failed.filter((f2) => r1.failed.some((f1) => f1.key === f2.key));
      for (const f of r2.netFailed) {
        if (!netFailed.some((x) => x.key === f.key)) netFailed.push(f);
      }
    }

    const kind = failed.length > 0 ? 'changed' : netFailed.length > 0 ? 'offline' : 'ok';
    return {
      ok: kind === 'ok',
      kind,
      failed,
      netFailed,
      checkedAt: Date.now(),
    };
  }
}

module.exports = {
  BiliClient,
  qnDesc,
  audioDesc,
  codecLabel,
  safeName,
  parseCookieString,
  md5,
  // 以下三项的真实来源是 api.js；用 getter 暴露，保证 api.reload() 之后拿到的是新值
  get VIDEO_QN_DESC() {
    return api.videoQnDesc;
  },
  get AUDIO_ID_DESC() {
    return api.audioIdDesc;
  },
  get UA() {
    return api.headers['User-Agent'];
  },
};
