'use strict';

/**
 * downloader.js —— 下载调度器
 *
 * 职责：
 *  1. 维护任务队列并按并发数调度
 *  2. 任务真正开始时才去取播放地址（B站流 URL 有效期约 2 小时，延迟获取可避免过期）
 *  3. 通过 aria2 RPC 下载
 *  4. 两者就绪后调用 ffmpeg 混流，清理分片
 *  5. 落盘封面 / 弹幕 / 字幕 / NFO，并写入下载记录
 *
 * 目前有两条下载通路，由 task.platform 决定：
 *  - 'bilibili'（默认）：DASH 双流（视频 + 音频分离）→ 下载两个分片 → ffmpeg 混流
 *  - 'douyin'          ：单文件 MP4（音视频同轨）→ 只下这一个文件，不混流
 * 两条通路共用队列、并发、暂停/续传、附加文件与历史记录。
 *
 * 另有两条「只下载音频」通路，由 task.kind === 'audio' 决定，仍复用上面的队列：
 *  - B站   ：只取音频轨（不碰视频流，省流量）→ ffmpeg 落地成 .m4a / .mp3
 *  - 抖音  ：抖音没有独立音轨，只能先下整段 MP4 再抽音轨
 * 这两条通路在「取流」这一层做了额外的健壮性处理（见 _resolveAudioStream 注释）。
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Aria2, STATUS_KEYS } = require('./aria2');
const { mergeDash, aacToMp3, extractAudio } = require('./ffmpeg');
const { extractStreams, humanSize, fmtDuration } = require('./resolver');
const { pickQuality, buildQualities } = require('./douyin');
const {
  danmakuXmlToAss,
  danmakuCount,
  subtitleToSrt,
  buildNfo,
  writeText,
} = require('./converters');
const { applyRule, ymd, pad } = require('./config');
const { safeName, qnDesc, audioDesc } = require('./bili');
const { api } = require('./api');

const TMP_SUFFIX_V = '.video.m4s';
const TMP_SUFFIX_A = '.audio.m4s';

let seq = 0;
const uid = () => `t${Date.now().toString(36)}${(++seq).toString(36)}`;

class Downloader extends EventEmitter {
  /**
   * @param {{bili:object, douyin?:object, config:object}} deps
   */
  constructor({ bili, douyin, config }) {
    super();
    this.bili = bili;
    this.douyin = douyin || null;
    this.config = config;
    this.aria = null;
    this.tasks = [];
    this.running = new Map(); // id -> Promise
    this.timer = null;
    this._stopped = false;
    this.ariaPort = 0;
  }

  attachAria(port, secret) {
    this.ariaPort = port;
    this.aria = new Aria2(port, secret);
  }

  // ------------------------------------------------------------ 队列

  get concurrency() {
    const n = parseInt(this.config.get('concurrency'), 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 3;
  }

  /** 添加任务（任务对象由 buildTask 生成） */
  addTasks(list) {
    for (const t of list) this.tasks.push(t);
    // 用 _push(=update) 而不是单独的 tasks 事件：渲染进程只订阅 update，
    // 否则并发受限而处于 waiting 的任务不会出现在队列里，直到真正开始下载。
    this._push();
    this.kick();
    return list.map((t) => t.id);
  }

  find(id) {
    return this.tasks.find((t) => t.id === id);
  }

  /** 队列快照（发给渲染进程的轻量数据） */
  snapshot() {
    return this.tasks.map((t) => ({
      id: t.id,
      platform: t.platform || 'bilibili',
      kind: t.kind || 'video',
      bvid: t.bvid,
      cid: t.cid,
      title: t.title,
      part: t.part,
      upName: t.upName,
      type: t.type,
      index: t.index,
      duration: t.duration,
      cover: t.cover,
      qnName: t.qnName,
      audioName: t.audioName,
      folder: t.folder,
      fileName: t.fileName,
      status: t.status,
      mergeHint: t.mergeHint || '',
      mergeTranscoding: !!t.mergeTranscoding,
      audioNote: t.audioNote || '',
      progress: Math.round(t.progress || 0),
      speedText: t.speed ? `${humanSize(t.speed)}/s` : '',
      totalText: t.totalBytes ? humanSize(t.totalBytes) : '',
      sizeText: t.totalBytes ? humanSize(t.totalBytes) : '',
      error: t.error || '',
      createdAt: t.createdAt,
    }));
  }

  _push() {
    this.emit('update', this.snapshot());
  }

  /** 调度：把等待中的任务按并发上限送入执行 */
  kick() {
    const active = [...this.running.keys()].length;
    if (active >= this.concurrency) return;

    const waiting = this.tasks.filter((t) => t.status === 'waiting');
    for (const t of waiting) {
      if ([...this.running.keys()].length >= this.concurrency) break;
      this._start(t);
    }
  }

  _start(task) {
    if (this.running.has(task.id)) return;
    // 每次真正启动都递增代号：取消 / 重新入队时 gen++，
    // 仍在收尾的旧执行流看到代号变了就会自己退出，避免污染新任务状态。
    task.gen = (task.gen || 0) + 1;
    const gen = task.gen;
    const p = this._run(task, gen)
      .catch((e) => {
        if (task.gen !== gen) return;
        task.status = 'error';
        task.error = e && e.message ? e.message : String(e);
        // 带上平台/标题/作品 ID：① 日志里才看得出是哪个视频挂了（此前只记了一句 error，
        // platform/title 全是空的）；② 主进程据此丢掉抖音的详情缓存，
        // 下次重新解析才会拿到新的直链签名。
        this.emit('task-error', {
          id: task.id,
          platform: task.platform,
          title: task.title,
          awemeId: task.awemeId,
          error: task.error,
        });
      })
      .finally(() => {
        if (this.running.get(task.id) === p) this.running.delete(task.id);
        if (task.gen !== gen) {
          // 已被取消 / 重新入队：只放行调度，让新的执行流接管
          this.kick();
          return;
        }
        this._push();
        this.kick();
        this._afterAll();
      });
    this.running.set(task.id, p);
  }

  /** 检查是否全部结束（用于自动关机） */
  _afterAll() {
    if (this._stopped) return;
    const pending = this.tasks.some((t) => t.status === 'waiting' || t.status === 'downloading' || t.status === 'merging');
    if (!pending && this.tasks.length) {
      const ok = this.tasks.filter((t) => t.status === 'done').length;
      this.emit('all-finished', { total: this.tasks.length, ok });
    }
  }

  // ------------------------------------------------------------ 单任务全流程

  async _run(task, gen) {
    // 抖音是单文件直链，走另一条通路（不改动 B站 那条既有逻辑）
    if (task.platform === 'douyin') {
      return task.kind === 'audio' ? this._runAudioDirect(task, gen) : this._runDirect(task, gen);
    }
    // 「只下载音频」：B站 有独立音轨，能省掉整条视频流
    if (task.kind === 'audio') return this._runAudio(task, gen);

    const alive = () => task.gen === gen;
    task.status = 'downloading';
    task.error = '';
    task.progress = 0;
    task._abort = new AbortController(); // 取消时用它终止仍在跑的 ffmpeg
    this._push();

    // 1) 延迟获取播放地址
    if (!alive()) return;
    if (!task.streamResolved) {
      const playData = await this.bili.playurl(task.bvid, task.cid, Math.max(task.videoQn, 127));
      if (playData.accept_description && playData.accept_description.join('').includes('试看')) {
        throw new Error('该视频为充电专属/试看片段，无法下载');
      }
      const { videos, audios } = extractStreams(playData);
      if (!videos.length) throw new Error('未获取到视频流（可能不支持 DASH 格式）');
      const v = pickVideo(videos, task.videoQn);
      const a = pickAudio(audios, task.audioQn);
      if (!v) throw new Error('所选画质不可用');
      if (!a) throw new Error('未获取到可用音频流');
      task.vStream = v;
      task.aStream = a;
      task.qnName = v.desc;
      task.audioName = a.desc;
      task.streamResolved = true;
      task.timelength = playData.timelength || 0;
      this._push();
    }

    // 2) 准备目录与文件名
    const dir = ensureDir(path.join(task.root, task.folder));
    task.dir = dir;

    const vPath = path.join(dir, task.fileName + TMP_SUFFIX_V);
    const aPath = path.join(dir, task.fileName + TMP_SUFFIX_A);
    const outPath = path.join(dir, task.fileName + '.mp4');
    task.vTmp = vPath;
    task.aTmp = aPath;
    task.outFile = outPath;

    if (!alive()) return;

    // 3) 磁盘余量预检（与抖音通路共用同一套判定，见 precheckDisk 的说明）
    precheckDisk(dir, (task.vStream.sizeBytes || 0) + (task.aStream.sizeBytes || 0));

    // 4) ★ 提交前清掉残留分片与 .aria2 控制文件。
    //
    //    这里以前**只写了注释、没有真的清**（2026-10-12 补齐）。后果实测过：
    //    任务文件名不含画质（如 {title}.mp4），同一个视频换画质重下会落到同一个
    //    .video.m4s 路径；而 .aria2 控制文件里记着上一档的 totalLength 与字节位图，
    //    aria2 看到 continue=true 就去「接着下」——两边对不上时直接报错，
    //    表现就是**「第一次下载失败之后，怎么重试都失败」**（与抖音 4K 那次同源）。
    //
    //    不会误伤正常续传：暂停/继续走的是 aria2 自己的 pause/unpause，不重入本函数。
    cleanup([vPath, aPath, vPath + '.aria2', aPath + '.aria2']);

    // 5) 提交 aria2
    const common = ariaCommon(dir, api.headers, {
      // 全局 max-tries=5 对 4K/8K 这类 1~2GB 大流偏紧：一条下载里几路连接各断一次
      // 就耗尽了。按任务放宽（只影响本条，不动 aria2c.conf 的全局值）。
      'max-tries': '10',
      'retry-wait': '3',
    });

    task.gidV = await this.aria.addUri(task.vStream.urls, Object.assign({}, common, { out: path.basename(vPath) }));
    task.gidA = await this.aria.addUri(task.aStream.urls, Object.assign({}, common, { out: path.basename(aPath) }));
    this._push();

    // 5) 轮询直到两者完成
    await this._waitBoth(task, gen);

    if (!alive()) {
      cleanup([vPath, aPath, vPath + '.aria2', aPath + '.aria2']);
      return;
    }

    // 6) 混流
    task.status = 'merging';
    task.progress = 100;
    this._push();

    const totalBytes = (task.vBytes || 0) + (task.aBytes || 0);
    task.totalBytes = totalBytes;

    try {
      await mergeDash(
        vPath,
        aPath,
        outPath,
        (p) => {
          task.mergeProgress = p.percent;
          this.emit('task-merge-progress', { id: task.id, percent: p.percent });
        },
        { signal: task._abort && task._abort.signal }
      );
    } catch (e) {
      throw new Error('混流失败：' + e.message);
    }

    if (!alive()) return;

    // 7) 清理分片（连同 aria2 的 .aria2 控制文件一起清掉）
    const keepV = this.config.get('keepVideo');
    const keepA = this.config.get('keepAudio');
    const removeList = [vPath + '.aria2', aPath + '.aria2'];
    if (!keepV) removeList.push(vPath);
    if (!keepA) removeList.push(aPath);
    cleanup(removeList);

    // 8) 附加内容
    await this._saveExtras(task, dir);

    // 9) 记录历史
    task.status = 'done';
    task.doneAt = Date.now();
    this.config.addHistory({
      bvid: task.bvid,
      cid: task.cid,
      title: task.title,
      part: task.part,
      upName: task.upName,
      qnName: task.qnName,
      audioName: task.audioName,
      file: outPath,
      size: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0,
      type: task.type,
    });
    try {
      await this.aria.removeDownloadResult(task.gidV).catch(() => {});
      await this.aria.removeDownloadResult(task.gidA).catch(() => {});
    } catch (e) {
      /* ignore */
    }
    this._push();
    this.emit('task-done', { id: task.id, file: outPath });
  }

  // ------------------------------------------------------------ 抖音：单文件直链

  /**
   * 抖音通路：一个 MP4 走到底，不混流。
   *
   * 与 B站 通路同样的纪律：
   *  - 流地址必须延迟获取（抖音 CDN 直链带时效签名，且每次解析要过浏览器，贵）
   *  - 每个 await 之后都要重新确认 alive()，否则取消/重排后旧执行流会污染新状态
   */
  async _runDirect(task, gen) {
    const alive = () => task.gen === gen;

    task.status = 'downloading';
    task.error = '';
    task.progress = 0;
    task.speed = 0;
    task._abort = new AbortController();
    this._push();

    // 1) 延迟取直链
    if (!task.streamResolved) {
      if (!this.douyin) throw new Error('抖音解析模块未初始化');
      const detail = await this.douyin.detail(task.awemeId);
      const q = pickQuality(buildQualities(detail), task.videoQn);
      if (!q) throw new Error('未获取到可用清晰度');
      task.stream = q;
      task.qnName = q.label + (q.codec ? ' ' + q.codec : '');
      task.totalBytes = q.sizeBytes || 0;
      task.streamResolved = true;
      this._push();
    }
    if (!alive()) return;

    // 2) 目录与文件名（与 B站 通路共用同一套命名规则）
    const dir = ensureDir(path.join(task.root, task.folder));
    task.dir = dir;
    const outPath = path.join(dir, task.fileName + '.mp4');
    task.outFile = outPath;

    // 2.5) 磁盘余量预检。抖音 4K 动辄 1.5GB，是 1080P 的 2~4 倍；盘不够时
    //    aria2 只会在下载中途抛一个含糊的「写文件失败」，用户根本看不出是空间问题。
    precheckDisk(dir, task.totalBytes);

    // 3) 提交 aria2（带一次「丢地址重取」重试）。
    //    ★ 必须带 Referer: https://www.douyin.com/ —— 抖音 CDN 不带会直接 403。
    //
    //    为什么视频直链也要重试：「只下载音频」通路早有 _downloadSingleWithRetry
    //    处理这件事（直链带时效签名，排队/高并发/网络抖动都会让刚取到的地址失效），
    //    但视频通路此前是一次性提交 —— 4K 档体积是 1080P 的 2~4 倍，下载时间成倍拉长，
    //    中途任何一次连接抖动（重试次数耗尽）就整单判死。这里补上同款纪律：
    //    失败 → 丢掉旧地址 → 重新解析拿新签名地址 → 再来一轮。
    const common = ariaCommon(dir, api.douyin.headers, {
      // 大文件下载时间以分钟计，全局默认 max-tries=5 太紧：一次下载里多几条
      // 连接各断一次就耗尽了。这里按任务放宽（只影响本条下载，不动全局配置）。
      'max-tries': '10',
      'retry-wait': '3',
    });

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!alive()) return;
      if (!task.streamResolved || !task.stream) {
        if (!this.douyin) throw new Error('抖音解析模块未初始化');
        // 第二轮（重试）必须绕过详情缓存：任务失败往往就是因为旧地址的签名失效，
        // 复用同一份详情只会拿到同一条死链，重试必然再失败。
        const detail = await this.douyin.detail(task.awemeId, { force: attempt > 1 });
        const q = pickQuality(buildQualities(detail), task.videoQn);
        if (!q) throw new Error('未获取到可用清晰度');
        task.stream = q;
        task.qnName = q.label + (q.codec ? ' ' + q.codec : '');
        task.totalBytes = q.sizeBytes || 0;
        task.streamResolved = true;
        this._push();
      }
      if (!alive()) return;

      // 提交前必须清掉上次失败留下的部分文件与 .aria2 控制文件：
      // 控制文件里存着旧（已过期签名）的 URI，带着它续传等于拿旧地址接着下，
      // 大文件「第一次失败之后，重试永远失败」就是这么来的。
      cleanup([outPath, outPath + '.aria2']);

      task.gidV = await this.aria.addUri(
        task.stream.urls,
        Object.assign({}, common, { out: path.basename(outPath) })
      );
      this._push();

      try {
        await this._waitOne(task, gen);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!alive() || attempt >= 2) break;
        // 丢弃已取到的直链，下一轮重新解析换新签名地址
        task.streamResolved = false;
        task.stream = null;
        task.gidV = null;
        task.progress = 0;
        this._push();
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (lastErr) throw lastErr;

    if (!alive()) {
      cleanup([outPath + '.aria2']);
      return;
    }
    if (!fs.existsSync(outPath)) throw new Error('下载已结束，但未找到输出文件');

    // 5) 附加内容（封面 / NFO；抖音没有弹幕与字幕）
    await this._saveExtras(task, dir);
    if (!alive()) return;

    // 6) 记录历史
    task.status = 'done';
    task.doneAt = Date.now();
    task.sizeBytes = fs.statSync(outPath).size;
    task.totalBytes = task.sizeBytes;
    this.config.addHistory({
      platform: 'douyin',
      awemeId: task.awemeId,
      bvid: '',
      cid: '',
      title: task.title,
      part: '',
      upName: task.upName,
      qnName: task.qnName,
      audioName: '',
      file: outPath,
      size: task.sizeBytes,
      type: task.type,
      sourceUrl: task.sourceUrl,
    });
    await this.aria.removeDownloadResult(task.gidV).catch(() => {});
    this._push();
    this.emit('task-done', { id: task.id, file: outPath });
  }

  /**
   * 轮询单个 gid 直到完成。
   * @param {object} task
   * @param {number} gen
   * @param {'gidV'|'gidA'} [gidKey='gidV'] 要盯的 gid 字段（音频通路用 gidA）
   */
  _waitOne(task, gen, gidKey = 'gidV') {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(iv);
        err ? reject(err) : resolve();
      };

      const iv = setInterval(async () => {
        if (task.gen !== gen) return finish();

        const gid = task[gidKey];
        if (!gid) return finish(new Error('下载任务已丢失（gid 为空）'));

        try {
          const s = await this.aria.tellStatus(gid, STATUS_KEYS).catch(() => null);
          if (!s) return;

          const done = Number(s.completedLength) || 0;
          const total = Number(s.totalLength) || 0;
          task.speed = Number(s.downloadSpeed) || 0;
          if (total > 0) task.totalBytes = total;
          task.progress = total > 0 ? (done / total) * 100 : 0;
          this._push();

          if (s.status === 'complete') return finish();
          if (s.status === 'error') {
            return finish(new Error('下载失败：' + (s.errorMessage || s.errorCode)));
          }
        } catch (e) {
          // 单次轮询失败不致命
        }
      }, 600);
    });
  }

  /** 轮询两个 gid 直到都完成 */
  _waitBoth(task, gen) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(iv);
        err ? reject(err) : resolve();
      };

      const iv = setInterval(async () => {
        if (task.gen !== gen) return finish();

        try {
          const [sv, sa] = await Promise.all([
            this.aria.tellStatus(task.gidV, STATUS_KEYS).catch(() => null),
            this.aria.tellStatus(task.gidA, STATUS_KEYS).catch(() => null),
          ]);
          if (!sv || !sa) return;

          const cv = Number(sv.completedLength) || 0;
          const ca = Number(sa.completedLength) || 0;
          const tv = Number(sv.totalLength) || 0;
          const ta = Number(sa.totalLength) || 0;

          task.vBytes = tv;
          task.aBytes = ta;
          const sp = (Number(sv.downloadSpeed) || 0) + (Number(sa.downloadSpeed) || 0);
          task.speed = sp;

          const total = tv + ta;
          task.totalBytes = total;
          task.progress = total > 0 ? ((cv + ca) / total) * 100 : 0;
          this._push();

          const doneV = sv.status === 'complete';
          const doneA = sa.status === 'complete';
          if (doneV && doneA) return finish();

          if (sv.status === 'error') return finish(new Error('视频流下载失败：' + (sv.errorMessage || sv.errorCode)));
          if (sa.status === 'error') return finish(new Error('音频流下载失败：' + (sa.errorMessage || sa.errorCode)));
        } catch (e) {
          // 单次轮询失败不致命
        }
      }, 600);
    });
  }

  // ------------------------------------------------------------ 只下载音频（B站）

  /**
   * B站「只下载音频」：只取音频轨 → ffmpeg 落地成 .m4a（无损）/ .mp3（通用）。
   *
   * 相比整条视频通路，这里**完全不申请视频流**，所以省流量、也更快。
   */
  async _runAudio(task, gen) {
    task.status = 'downloading';
    task.error = '';
    task.progress = 0;
    task.speed = 0;
    task.totalBytes = 0;
    task.mergeHint = '';
    task.mergeTranscoding = false;
    task.audioNote = '';
    task._abort = new AbortController(); // 取消时用它终止仍在跑的 ffmpeg
    this._push();

    const dir = ensureDir(path.join(task.root, task.folder));
    task.dir = dir;

    const ext = task.audioFormat === 'mp3' ? '.mp3' : '.m4a';
    const outPath = path.join(dir, task.fileName + ext);
    task.outFile = outPath;

    // 临时文件后缀取决于拿到的流：DASH 音轨存 .m4s，渐进流兜底要先落完整 MP4
    const tmpFor = (t) => path.join(dir, t.fileName + (t.progressive ? '.src.mp4' : TMP_SUFFIX_A));

    await this._downloadSingleWithRetry(task, gen, (t) => this._resolveAudioStream(t), tmpFor, api.headers);
    await this._finalizeAudio(task, gen, outPath, dir);
  }

  // ------------------------------------------------------------ 只下载音频（抖音）

  /**
   * 抖音「只下载音频」：抖音没有独立音轨，音轨就封在那个单文件 MP4 里，
   * 所以只能是「下整段 → 抽出音轨」。进度会走满整段视频的长度，这是正常的。
   */
  async _runAudioDirect(task, gen) {
    task.status = 'downloading';
    task.error = '';
    task.progress = 0;
    task.speed = 0;
    task.mergeHint = '';
    task.mergeTranscoding = false;
    task.audioNote = '';
    task._abort = new AbortController(); // 取消时用它终止仍在跑的 ffmpeg
    this._push();

    const dir = ensureDir(path.join(task.root, task.folder));
    task.dir = dir;

    const ext = task.audioFormat === 'mp3' ? '.mp3' : '.m4a';
    const outPath = path.join(dir, task.fileName + ext);
    task.outFile = outPath;

    await this._downloadSingleWithRetry(
      task,
      gen,
      (t) => this._resolveAudioStreamDouyin(t),
      (t) => path.join(dir, t.fileName + '.src.mp4'),
      api.douyin.headers
    );
    await this._finalizeAudio(task, gen, outPath, dir);
  }

  /**
   * 解析「只下载音频」要用的流地址（B站）。
   *
   * ★ 这里是本功能比 bilidown 更稳的关键，也是它「只下载音频」经常失败的原因：
   *   1. 音轨从**接口实际返回的列表**里挑，而不是写死某个音质 id ——
   *      「用户选的音质这视频没有」时不会直接失败，而是自动降到最接近的可用音轨；
   *   2. 无损(FLAC)/杜比音轨也在候选里，取到后交给 ffmpeg 自动决定拷贝还是重编码；
   *   3. 万一 DASH 一个音轨都没返回（老视频 / 番剧），再退回渐进流 durl，
   *      先下整段再抽音轨 —— 这条兜底正是 bilidown 缺失、逼着用户改用自定义下载的场景。
   */
  async _resolveAudioStream(task) {
    const playData = await this.bili.playurl(task.bvid, task.cid, 127);
    if (playData.accept_description && playData.accept_description.join('').includes('试看')) {
      throw new Error('该视频为充电专属/试看片段，无法下载');
    }
    task.timelength = playData.timelength || 0;

    const { audios } = extractStreams(playData);
    const a = pickAudio(audios, task.audioQn);
    if (a) {
      task.aStream = a;
      task.audioName = a.desc;
      task.progressive = false;
      task.streamResolved = true;
      return;
    }

    // —— 兜底：DASH 未返回任何音轨 → 渐进流 ——
    const prog = await this.bili.playurlProgressive(task.bvid, task.cid, 32);
    const durl = (prog && prog.durl) || [];
    const first = durl.find((d) => d && (d.url || (d.backup_url || []).length));
    if (!first) throw new Error('未获取到可用音频（该视频本身可能就没有音轨）');

    task.aStream = {
      id: 0,
      desc: '音频(渐进流)',
      codecs: '',
      urls: [first.url, ...(first.backup_url || [])].filter(Boolean),
    };
    task.audioName = '音频(渐进流)';
    task.timelength = prog.timelength || task.timelength;
    task.progressive = true;
    task.streamResolved = true;
  }

  /** 解析抖音「只下载音频」用的视频地址（音轨要从这个 MP4 里抽） */
  async _resolveAudioStreamDouyin(task, attempt) {
    if (!this.douyin) throw new Error('抖音解析模块未初始化');
    // 同上：重试轮必须换新签名，不能吃详情缓存
    const detail = await this.douyin.detail(task.awemeId, { force: Number(attempt) > 1 });
    const q = pickQuality(buildQualities(detail), task.videoQn);
    if (!q) throw new Error('未获取到可用清晰度');
    task.aStream = q;
    task.progressive = false;
    task.totalBytes = q.sizeBytes || 0;
    task.streamResolved = true;
  }

  /**
   * 「取地址 → 提交 aria2 → 等完成」这一步的可重试封装。
   *
   * 为什么要重试：B站 / 抖音 的直链都是**带时效签名**的，排队久了或并发高时
   * 会遇到「地址刚取到就 403/过期」。bilidown 遇到这种情况直接判失败、要用户
   * 自己去「自定义下载」；这里自动丢掉旧地址、重新取一次再下。
   *
   * @param {object} task
   * @param {number} gen
   * @param {(t:object)=>Promise<void>} resolveStream 取流函数（内部写 task.aStream）
   * @param {(t:object)=>string} tmpPathFor 由当前流决定临时文件名
   * @param {object} headerObj 请求头（B站 / 抖音 各一份）
   */
  async _downloadSingleWithRetry(task, gen, resolveStream, tmpPathFor, headerObj) {
    const alive = () => task.gen === gen;
    let lastErr = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!alive()) return;
      // 注意把 attempt 交给 resolveStream：抖音那条路要靠它决定「是否绕过详情缓存」
      // （重试必须换新签名地址，见 _resolveAudioStreamDouyin）
      if (!task.streamResolved || !task.aStream) await resolveStream(task, attempt);
      if (!alive()) return;
      if (!task.aStream || !(task.aStream.urls || []).length) {
        throw new Error('未获取到可用的音频地址');
      }

      const tmpPath = tmpPathFor(task);
      task.aTmp = tmpPath;
      const common = ariaCommon(path.dirname(tmpPath), headerObj || api.headers, {
        'max-tries': '10',
        'retry-wait': '3',
      });

      task.gidA = await this.aria.addUri(
        task.aStream.urls,
        Object.assign({}, common, { out: path.basename(tmpPath) })
      );
      this._push();

      try {
        await this._waitOne(task, gen, 'gidA');
        return;
      } catch (e) {
        lastErr = e;
        if (!alive() || attempt >= 2) break;
        await this.aria.forceRemove(task.gidA).catch(() => {});
        task.gidA = null;
        cleanup([tmpPath, tmpPath + '.aria2']);
        // 丢弃已过期的地址，下一轮重新取
        task.streamResolved = false;
        task.aStream = null;
        task.progressive = false;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr || new Error('音频下载失败');
  }

  /** 音频下载完成后的落地：抽音轨 → 附加内容 → 写历史 */
  async _finalizeAudio(task, gen, outPath, dir) {
    const alive = () => task.gen === gen;
    const tmpPath = task.aTmp;

    if (!alive()) {
      cleanup([tmpPath, tmpPath && tmpPath + '.aria2']);
      return;
    }
    if (!tmpPath || !fs.existsSync(tmpPath)) throw new Error('下载已结束，但未找到临时文件');

    // 复用 'merging' 状态；渲染层会按 task.kind === 'audio' 显示「处理音频」
    task.status = 'merging';
    task.progress = 100;
    task.mergeHint = '';
    task.mergeTranscoding = false;
    this._push();

    let res = null;
    try {
      // onNotice：ffmpeg 在探测出源编码后回吐人话提示（「直接提取」/「正在转码，需要一点时间」），
      // 透传到队列卡片，用户才知道这里为什么停一会儿。
      res = await extractAudio(tmpPath, outPath, {
        format: task.audioFormat,
        // 取消任务时把信号传下去：ffmpeg 子进程会被立即终止，
        // 而不是继续占着 CPU 和输出文件（以前点「取消」是杀不掉它的）。
        signal: task._abort && task._abort.signal,
        onNotice: (text, transcoding) => {
          task.mergeHint = text;
          task.mergeTranscoding = !!transcoding;
          this._push();
        },
        onProgress: (p) => this.emit('task-merge-progress', { id: task.id, percent: p.percent }),
      });
    } catch (e) {
      task.mergeHint = '';
      task.mergeTranscoding = false;
      throw new Error('音轨处理失败：' + e.message);
    }
    if (!alive()) return;

    cleanup([tmpPath, tmpPath + '.aria2']);
    if (task.gidA) await this.aria.removeDownloadResult(task.gidA).catch(() => {});

    await this._saveExtras(task, dir);
    if (!alive()) return;

    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    task.status = 'done';
    task.doneAt = Date.now();
    task.sizeBytes = size;
    task.totalBytes = size;
    task.mergeHint = '';
    task.mergeTranscoding = false;
    // 是否真的转码过：源音轨本身就是目标格式时是「直提」，界面上不再多嘴
    task.audioNote = res && res.mode === 'transcode' ? '已转码' : '';
    this.config.addHistory(audioHistory(task, outPath, size));
    this._push();
    this.emit('task-done', { id: task.id, file: outPath });
  }

  /** 下载封面 / 弹幕 / 字幕 / NFO */
  async _saveExtras(task, dir) {
    const cfg = this.config.all();
    const base = task.fileName;
    const isDy = task.platform === 'douyin';

    if (cfg.saveCover && task.cover) {
      try {
        // 抖音图床与 B站 图床的请求头不同，各用各的
        const buf = isDy && this.douyin ? await this.douyin.fetchCover(task.cover) : await this.bili.fetchCover(task.cover);
        fs.writeFileSync(path.join(dir, base + '.jpg'), buf);
      } catch (e) {
        this.emit('extras-warn', { id: task.id, what: '封面', error: e.message });
      }
    }

    // 弹幕 / CC 字幕是 B站 独有的接口，抖音侧没有对应数据，直接跳过（避免刷无意义的警告）
    if (!isDy && (cfg.saveDanmaku || cfg.saveAss)) {
      try {
        const xml = await this.bili.danmakuXml(task.cid);
        if (cfg.saveDanmaku) {
          writeText(path.join(dir, base + '.xml'), xml);
        }
        if (cfg.saveAss) {
          const ass = danmakuXmlToAss(xml, { durationSec: 10 });
          writeText(path.join(dir, base + '.ass'), ass);
        }
        task.danmakuCount = danmakuCount(xml);
      } catch (e) {
        this.emit('extras-warn', { id: task.id, what: '弹幕', error: e.message });
      }
    }

    if (!isDy && cfg.saveSubtitle) {
      try {
        const p = await this.bili.playerWbi(task.aid, task.cid);
        const subs = (p && p.data && p.data.subtitle && p.data.subtitle.subtitles) || [];
        if (subs.length) {
          const chosen = subs.find((s) => /zh|ai-zh/i.test(s.lan)) || subs[0];
          const json = await this.bili.subtitleContent(chosen.subtitle_url);
          writeText(path.join(dir, base + '.srt'), subtitleToSrt(json));
        }
      } catch (e) {
        this.emit('extras-warn', { id: task.id, what: '字幕', error: e.message });
      }
    }

    if (cfg.saveNfo) {
      try {
        writeText(
          path.join(dir, base + '.nfo'),
          buildNfo({
            title: task.title,
            desc: task.desc,
            duration: task.duration,
            cover: task.cover,
            premiered: task.pubdate ? ymd(new Date(task.pubdate * 1000)) : '',
            up: task.upName,
            bvid: task.bvid,
            cid: task.cid,
            type: task.type,
            tname: task.tname,
            studio: isDy ? 'douyin' : 'bilibili',
            upRole: isDy ? '作者' : 'UP主',
            uniqueId: isDy ? task.awemeId : task.bvid,
          })
        );
      } catch (e) {
        this.emit('extras-warn', { id: task.id, what: 'NFO', error: e.message });
      }
    }
  }

  // ------------------------------------------------------------ 控制

  async pauseTask(id) {
    const t = this.find(id);
    if (!t) return;
    if (t.gidV) await this.aria.pause(t.gidV).catch(() => {});
    if (t.gidA) await this.aria.pause(t.gidA).catch(() => {});
    t.status = 'paused';
    this._push();
  }

  async resumeTask(id) {
    const t = this.find(id);
    if (!t) return;

    // 已经在跑（只是被暂停）：直接恢复即可
    if (this.running.has(t.id)) {
      if (t.gidV) await this.aria.unpause(t.gidV).catch(() => {});
      if (t.gidA) await this.aria.unpause(t.gidA).catch(() => {});
      t.status = 'downloading';
      this._push();
      return;
    }

    // 排队中 / 失败 / 已取消：重新入队，让调度器重走一遍完整流程。
    // 并把代号后移，作废可能仍在收尾的旧执行流。
    // 注意必须丢弃旧的播放地址：B站流地址约 2 小时过期，直接复用会 403。
    t.gen = (t.gen || 0) + 1;
    t.status = 'waiting';
    t.error = '';
    t.progress = 0;
    t.speed = 0;
    t.totalBytes = 0;
    t.streamResolved = false;
    t.stream = null; // 抖音 CDN 直链同样有时效签名，必须丢弃重取
    t.gidV = null;
    t.gidA = null;
    this._push();
    this.kick();
  }

  async cancelTask(id) {
    const t = this.find(id);
    if (!t) return;
    // 先作废执行流，再动 aria2，避免轮询线程把状态又改回去
    t.gen = (t.gen || 0) + 1;
    // ★ 顺手终止可能仍在跑的 ffmpeg 子进程（混流 / 抽音轨 / 转码）。
    //   只作废 gen 是不够的：旧执行流要等 ffmpeg 自己结束才会看到 gen 变了，
    //   在此之前它会一直吃 CPU、还锁着输出文件。
    if (t._abort) {
      try {
        t._abort.abort();
      } catch (e) {
        /* ignore */
      }
    }
    t.status = 'canceled';
    if (t.gidV) await this.aria.forceRemove(t.gidV).catch(() => {});
    if (t.gidA) await this.aria.forceRemove(t.gidA).catch(() => {});
    const files = [t.vTmp, t.aTmp];
    if (t.platform === 'douyin' && t.outFile) files.push(t.outFile, t.outFile + '.aria2');
    cleanup(
      files.concat(files.filter(Boolean).map((f) => f + '.aria2'))
    );
    this._push();
  }

  removeTask(id) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i >= 0) {
      const t = this.tasks[i];
      if (t.status === 'downloading' || t.status === 'merging') return false;
      this.tasks.splice(i, 1);
      this._push();
    }
    return true;
  }

  async pauseAll() {
    for (const t of this.tasks) if (t.status === 'downloading') await this.pauseTask(t.id);
  }

  async resumeAll() {
    for (const t of this.tasks) if (t.status === 'paused') await this.resumeTask(t.id);
  }

  async clearFinished() {
    this.tasks = this.tasks.filter((t) => t.status === 'downloading' || t.status === 'merging' || t.status === 'waiting' || t.status === 'paused');
    this._push();
  }

  stopAll() {
    this._stopped = true;
  }

  // ------------------------------------------------------------ 独立工具

  /** 音频转 MP3（工具箱） */
  async convertToMp3(inFile, onProgress) {
    const out = path.join(
      path.dirname(inFile),
      path.basename(inFile, path.extname(inFile)) + '.mp3'
    );
    if (fs.existsSync(out)) throw new Error('输出位置已存在同名 mp3 文件');
    await aacToMp3(inFile, out, onProgress);
    return out;
  }

  /** 手动混流（工具箱） */
  async manualMerge(videoFile, audioFile, outDir, onProgress) {
    if (!fs.existsSync(videoFile)) throw new Error('视频源不存在');
    if (!fs.existsSync(audioFile)) throw new Error('音频源不存在');
    if (!fs.existsSync(outDir)) throw new Error('输出文件夹不存在');
    const out = path.join(outDir, `merge-${Date.now()}.mp4`);
    await mergeDash(videoFile, audioFile, out, onProgress);
    return out;
  }
}

// ---------------------------------------------------------------- 辅助

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 提交 aria2 前的人话版磁盘余量预检。
 *
 * 为什么需要：4K/8K 流动辄 1~2 GB，是普通档的 2~4 倍；盘不够时 aria2 只会在
 * 下载中途抛一个含糊的「写文件失败」，用户根本看不出是空间问题。
 * 预留 5% 余量 + 64MB 缓冲（混流/抽音轨还要落一份临时产物）。
 *
 * statfs 个别环境不可用时**静默跳过** —— 别让预检本身把下载挡住。
 *
 * @param {string} dir
 * @param {number} needBytes 预计下载体积（<=0 时跳过）
 */
function precheckDisk(dir, needBytes) {
  if (!(Number(needBytes) > 0)) return;
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const need = Number(needBytes) * 1.05 + 64 * 1024 * 1024;
    if (Number.isFinite(free) && free < need) {
      throw new Error(
        `磁盘空间不足：本文件约需 ${humanSize(need)}，${dir} 所在盘只剩 ${humanSize(free)}。` +
          '请换一个下载目录，或清理磁盘后重试。'
      );
    }
  } catch (e) {
    if (e && /磁盘空间不足/.test(e.message)) throw e;
    /* statfs 不可用：跳过预检 */
  }
}

/**
 * 组装提交给 aria2 的公共选项。
 *
 * ★ 请求头必须**逐任务**下发（B站 → api.headers，抖音 → api.douyin.headers）：
 *   全局 referer 不会被逐任务 header 覆盖，写进 aria2c.conf 会让抖音直链也带上
 *   bilibili 的 Referer 而被 CDN 403（见 bin/aria2c.conf 的说明）。
 *
 * @param {string} dir       落盘目录
 * @param {object} headerObj 该平台的请求头字典
 * @param {object} [extra]   额外/覆盖的 aria2 选项（如 max-tries）
 * @returns {object}
 */
function ariaCommon(dir, headerObj, extra) {
  return Object.assign(
    {
      dir,
      split: '8',
      'max-connection-per-server': '8',
      'min-split-size': '15M',
      continue: 'true',
      'auto-file-renaming': 'false',
      'allow-overwrite': 'true',
      header: Object.keys(headerObj).map((k) => `${k}: ${headerObj[k]}`),
    },
    extra || {}
  );
}

function cleanup(list) {
  for (const f of list || []) {
    if (!f) continue;
    try {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

/**
 * 按用户偏好挑选最合适的视频轨（精确 qn → 不高于偏好的最高 qn）。
 *
 * ★ 比较一律用 String() 归一：UI 传下来的 qn 可能是 number（点选画质框）也可能
 *   是字符串（配置项/复合 id），用 `===` 严格比较会在类型不一致时静默失配 ——
 *   同一类坑已经在画质框高亮、抖音档位匹配上各踩过一次（2026-10-12）。
 */
function pickVideo(videos, wantQn) {
  if (!videos.length) return null;
  const eq = (a, b) => String(a) === String(b);
  const exact = videos.filter((v) => eq(v.id, wantQn));
  if (exact.length) {
    // 同画质优先 AVC（兼容性最好）
    return exact.find((v) => /avc1/.test(v.codecs)) || exact[0];
  }
  const want = Number(wantQn);
  if (Number.isFinite(want)) {
    const lower = videos.filter((v) => Number(v.id) <= want).sort((a, b) => Number(b.id) - Number(a.id));
    if (lower.length) return lower.find((v) => /avc1/.test(v.codecs)) || lower[0];
  }
  return videos.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
}

/** 挑选音频轨（比较同样做 String() 归一，理由见 pickVideo） */
function pickAudio(audios, wantId) {
  if (!audios.length) return null;
  const eq = (a, b) => String(a) === String(b);
  const exact = audios.find((a) => eq(a.id, wantId));
  if (exact) return exact;
  const plain = audios.filter((a) => !/flac|ec-3|dolby/i.test(a.codecs));
  if (plain.length) return plain.sort((a, b) => Number(b.id) - Number(a.id))[0];
  return audios.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
}

/**
 * 「只下载音频」的历史记录。
 * 与视频记录共用同一份结构，额外标 kind:'audio' 方便区分；
 * 画质那一列显示实际取到的音质，而不是空着。
 */
function audioHistory(task, file, size) {
  const rec = {
    platform: task.platform || 'bilibili',
    bvid: task.bvid || '',
    cid: task.cid || '',
    title: task.title,
    part: task.part || '',
    upName: task.upName,
    qnName: task.audioName ? `音频 ${task.audioName}` : '音频',
    audioName: task.audioName || '',
    file,
    size,
    type: task.type,
    kind: 'audio',
  };
  if (task.platform === 'douyin') {
    rec.awemeId = task.awemeId;
    rec.sourceUrl = task.sourceUrl;
  }
  return rec;
}

/**
 * 由媒体信息 + 分P + 用户设置 构造任务列表
 * @param {object} media resolve() 的返回值
 * @param {object} cfg   当前配置
 * @param {object} sel   { parts:[index], videoQn, audioQn }
 */
function buildTasks(media, cfg, sel) {
  if (media && media.platform === 'douyin') return buildDouyinTasks(media, cfg, sel);
  return buildBiliTasks(media, cfg, sel);
}

/**
 * 抖音任务：一个作品 = 一个任务（单文件 MP4，无分P、无音轨可选）
 */
function buildDouyinTasks(media, cfg, sel) {
  const now = new Date();
  const dateStr = ymd(now);
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const audioOnly = sel.mode === 'audio';
  const audioFormat = sel.audioFormat === 'mp3' ? 'mp3' : 'm4a';

  const qualities = media.qualities || [];
  const chosen = pickQuality(qualities, sel.videoQn) || qualities[0] || null;
  const qnName = chosen ? `${chosen.label}${chosen.codec ? ' ' + chosen.codec : ''}` : '默认';

  const ctx = {
    title: safeName(media.title),
    up: safeName(media.up.name),
    uid: media.up.mid,
    aweme: media.awemeId,
    type: media.type,
    date: dateStr,
    time: timeStr,
    // 只下载音频时 {qn} 说明这是音轨
    qn: audioOnly ? '音轨' : qnName,
    part: '',
  };

  let folder = '';
  if (cfg.folderRule && cfg.folderRule.trim()) {
    folder = applyRule(cfg.folderRule, Object.assign({}, ctx, { index: '1' }), 1);
  }
  folder = String(folder || '')
    .split(/[\\/]+/)
    .map((seg) => safeName(seg, ''))
    .filter(Boolean)
    .join(path.sep);
  if (folder.length > 120) folder = folder.slice(0, 120);

  let fileName = applyRule(cfg.fileRule || '{title}', Object.assign({}, ctx, { index: '1' }), 1);
  fileName = safeName(fileName, `douyin-${media.awemeId}`);
  // Windows 路径总长上限 260，标题过长必须截断
  if (fileName.length > 80) fileName = fileName.slice(0, 80).trim();

  return [
    {
      id: uid(),
      platform: 'douyin',
      kind: audioOnly ? 'audio' : 'video',
      audioFormat,
      awemeId: media.awemeId,
      sourceUrl: media.sourceUrl,

      // 与 B站 任务对齐的占位字段，便于 queue / history 统一处理
      bvid: '',
      aid: '',
      cid: 0,

      title: media.title,
      part: '',
      upName: media.up.name,
      upMid: media.up.mid,
      cover: media.cover,
      desc: media.desc,
      pubdate: media.pubdate,
      duration: media.duration,
      tname: media.tname,
      type: audioOnly ? '音频' : media.type,
      index: 1,

      videoQn: chosen ? chosen.id : 0,
      audioQn: 0,
      // 只下载音频时画质名留空，队列卡片只显示「音轨」
      qnName: audioOnly ? '' : qnName,
      audioName: audioOnly ? '音轨' : '',

      root: cfg.savePath,
      folder,
      fileName,
      status: 'waiting',
      progress: 0,
      totalBytes: chosen ? chosen.sizeBytes || 0 : 0,
      streamResolved: false,
      createdAt: Date.now(),
    },
  ];
}

/** B站任务：支持单视频 / 分P / 合集；sel.mode==='audio' 时只下音频 */
function buildBiliTasks(media, cfg, sel) {
  const now = new Date();
  const dateStr = ymd(now);
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const multi = media.parts.length > 1;
  const audioOnly = sel.mode === 'audio';
  const audioFormat = sel.audioFormat === 'mp3' ? 'mp3' : 'm4a';

  // 文件夹（支持 {up}/{title} 这类多级路径）
  let folder = '';
  if (cfg.folderRule && cfg.folderRule.trim()) {
    folder = applyRule(
      cfg.folderRule,
      {
        title: safeName(media.title),
        bv: media.bvid,
        av: media.aid,
        up: safeName(media.up.name),
        uid: media.up.mid,
        date: dateStr,
        type: media.type,
      },
      null
    );
  } else if (multi) {
    folder = media.title;
  }
  // 逐段做安全化，保留目录层级
  folder = String(folder || '')
    .split(/[\\/]+/)
    .map((seg) => safeName(seg, ''))
    .filter(Boolean)
    .join(path.sep);
  if (folder.length > 120) folder = folder.slice(0, 120);

  const chosen = media.parts.filter((p) => sel.parts.includes(p.index));

  return chosen.map((part, i) => {
    const seqNo = multi ? chosen.length > 1 && cfg.addIndexToFolder ? i + 1 : part.index : null;
    const ctx = {
      title: safeName(media.title),
      bv: media.bvid,
      av: media.aid,
      cid: part.cid,
      up: safeName(media.up.name),
      uid: media.up.mid,
      // 只下载音频时 {qn} 代表音质，否则代表画质
      qn: audioOnly ? audioDesc(sel.audioQn) : qnDesc(sel.videoQn),
      date: dateStr,
      time: timeStr,
      type: media.type,
      part: safeName(part.part || part.title),
      index: multi ? String(seqNo || part.index) : '1',
    };

    let fileName = applyRule(cfg.fileRule || '{title}', ctx, seqNo || part.index);
    // 多集且规则里没有区分度时，补上序号避免互相覆盖
    if (multi && chosen.length > 1) {
      const hasIndex = /\{index\}/.test(cfg.fileRule || '');
      if (!hasIndex) {
        fileName = `${pad(part.index)}-${fileName}`;
      }
    }
    fileName = safeName(fileName, `video-${part.cid}`);
    // Windows 路径总长上限 260，标题过长时必须截断，否则创建文件会失败
    if (fileName.length > 80) fileName = fileName.slice(0, 80).trim();

    const task = {
      id: uid(),
      platform: 'bilibili',
      kind: audioOnly ? 'audio' : 'video',
      audioFormat,
      bvid: part.bvid || media.bvid,
      aid: part.aid || media.aid,
      cid: part.cid,
      title: multi ? media.title : part.title,
      part: part.part || '',
      upName: media.up.name,
      upMid: media.up.mid,
      cover: part.cover || media.cover,
      desc: media.desc,
      pubdate: part.pubdate || media.pubdate,
      duration: part.duration || media.duration,
      tname: media.tname,
      type: audioOnly ? '音频' : media.type,
      index: part.index,
      videoQn: sel.videoQn,
      audioQn: sel.audioQn,
      // 只下载音频时画质名留空，队列卡片就只显示音质
      qnName: audioOnly ? '' : qnDesc(sel.videoQn),
      audioName: audioDesc(sel.audioQn),
      root: cfg.savePath,
      folder,
      fileName,
      status: 'waiting',
      progress: 0,
      streamResolved: false,
      createdAt: Date.now(),
    };
    return task;
  });
}

module.exports = { Downloader, buildTasks, buildBiliTasks, buildDouyinTasks, pickVideo, pickAudio };
