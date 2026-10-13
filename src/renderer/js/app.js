'use strict';

/* ==========================================================================
   视频下载器 · 渲染进程
   ========================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const api = window.bd;

const state = {
  config: {},
  user: { isLogin: false },
  tasks: [],
  media: null,
  preview: null,
  // ★ 必须是 Set：下面所有代码都按 Set 语义用它（.has / .add / .delete / .size）。
  //   早期这里写成了 []，于是「分P / 合集」这类多集视频在渲染列表时会抛
  //   `state.parts.has is not a function`，被 doParse 的 try/catch 吞成
  //   「解析失败」，而单视频（不渲染列表）完全正常 —— 正是那个"单个视频能下、
  //   列表一解析就报错"的现象。
  parts: new Set(),   // 当前选中的分集序号 Set<number>
  selVideoQn: 80,
  selAudioQn: 30280,
  nameVars: [],
  sdTimer: null,
};

/* ---------------------------------------------------------------- 小工具 */

function toast(msg, type = 'info', ms = 2600) {
  const icons = {
    success: '<path d="M3 6.5l3 3 5-6"/>',
    error: '<path d="M3 3l6 6M9 3l-6 6"/>',
    warn: '<path d="M6 2v4M6 8h.01"/>',
    info: '<path d="M6 5v4M6 2h.01"/>',
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="ico"><svg viewBox="0 0 12 12">${icons[type] || icons.info}</svg></span><span>${escapeHtml(
    msg
  )}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function humanSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * 统一图片地址。
 * B站接口返回的封面常是 http:// 或 // 开头，而页面 CSP 只放行 https，
 * 直接使用会被浏览器拦掉（图片变裂）。这里统一升到 https。
 */
function imgSrc(u) {
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  if (/^http:\/\//i.test(u)) return 'https://' + u.slice(7);
  return u;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

const STATUS_TEXT = {
  waiting: '排队中',
  downloading: '下载中',
  merging: '混流中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
};

/* ---------------------------------------------------------------- Tab */

function switchTab(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'history') loadHistory();
  if (name === 'settings') renderSettings();
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ---------------------------------------------------------------- 解析 */

const QN_LIST = [
  [127, '8K 超高清'],
  [126, '杜比视界'],
  [125, 'HDR 真彩'],
  [120, '4K 超清'],
  [116, '1080P60 高帧率'],
  [112, '1080P+ 高码率'],
  [80, '1080P 高清'],
  [74, '720P60 高帧率'],
  [64, '720P 高清'],
  [32, '480P 清晰'],
  [16, '360P 流畅'],
  [6, '240P 极速'],
];

const AUDIO_LIST = [
  [30251, 'Hi-Res 无损'],
  [30250, '杜比全景声'],
  [30280, '192K'],
  [30232, '132K'],
  [30216, '64K'],
];

function setStatus(msg, kind = 'info') {
  const el = $('#parseStatus');
  if (!msg) return el.classList.add('hidden');
  el.className = `parse-status ${kind}`;
  el.innerHTML = escapeHtml(msg);
}

$('#btnParse').addEventListener('click', doParse);
$('#parseInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doParse();
});
/* 输入框清空小叉：有内容才显示，点击清空 */
function updateClearBtn() {
  $('#btnClearInput').classList.toggle('hidden', !$('#parseInput').value);
}
$('#parseInput').addEventListener('input', updateClearBtn);
$('#btnClearInput').addEventListener('click', () => {
  const inp = $('#parseInput');
  inp.value = '';
  updateClearBtn();
  setStatus('');
  inp.focus();
});
$('#btnClip').addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) {
      $('#parseInput').value = t.trim();
      updateClearBtn();
      toast('已粘贴剪切板内容', 'info', 1500);
    }
  } catch (e) {
    toast('无法读取剪切板', 'warn');
  }
});

async function doParse() {
  const input = $('#parseInput').value.trim();
  if (!input) return toast('请输入视频链接或 BV 号', 'warn');

  setStatus('正在解析链接…', 'info');
  $('#mediaBox').classList.add('hidden');

  // 第一步：只负责「拿数据」。网络/接口层的问题才是真正的「解析失败」。
  let media;
  try {
    media = await api.resolve(input);
  } catch (e) {
    setStatus('解析失败：' + (e.message || e), 'err');
    toast('解析失败：' + (e.message || e), 'error');
    return;
  }

  state.media = media;

  // ★ 顺序很关键：先把「已选分集」建好，再渲染列表。
  //   renderParts() 要读 state.parts.has(index) 来决定复选框是否勾选，
  //   若先渲染后赋值，首屏会全部显示为未勾选（旧代码就是反的）。
  state.parts = new Set(media.parts.map((p) => p.index));

  // 第二步：画界面。渲染出错说明是前端 bug，不该伪装成「解析失败」去误导排查方向。
  try {
    renderMedia(media);
  } catch (e) {
    console.error('[render] 界面渲染失败：', e);
    toast('界面渲染失败：' + (e.message || e), 'error');
  }

  if (media.platform === 'douyin') {
    const t = media.title.length > 24 ? media.title.slice(0, 24) + '…' : media.title;
    setStatus(`解析成功：${t}`, 'ok');
  } else {
    setStatus(`解析成功：共 ${media.parts.length} 个可下载视频`, 'ok');
  }
  setTimeout(() => setStatus(''), 2400);

  // 第三步：取第一个分P 的可用流
  const first = media.parts[0];
  if (first) await loadPreview(media, first);
}

function renderMedia(m) {
  const box = $('#mediaBox');
  box.classList.remove('hidden');
  const isDy = m.platform === 'douyin';

  $('#mediaCover').src = imgSrc(m.cover);
  $('#mediaType').textContent = m.type;
  $('#mediaTitle').textContent = m.title;
  $('#mediaUp').textContent = (isDy ? '作者：' : 'UP主：') + (m.up.name || '未知');
  $('#mediaDuration').textContent = '时长 ' + fmtDuration(m.duration);
  $('#mediaPub').textContent = m.pubdate ? fmtDate(m.pubdate * 1000).slice(0, 10) + ' 发布' : '';
  // 抖音的 desc 就是标题本身（它没有单独的简介字段），一样就没必要重复显示
  const dupDesc = isDy && m.desc === m.title;
  $('#mediaDesc').textContent = dupDesc ? '' : m.desc || '（该视频没有简介）';

  // 两个平台的统计口径不同，按来源给对应的几项
  const s = m.stat || {};
  const cell = (label, v) => `${label} <b>${Number(v || 0).toLocaleString()}</b>`;
  $('#mediaStat').innerHTML = isDy
    ? [cell('点赞', s.like), cell('评论', s.comment), cell('收藏', s.collect), cell('分享', s.share)].join('')
    : [
        cell('播放', s.view),
        cell('弹幕', s.danmaku),
        cell('点赞', s.like),
        cell('投币', s.coin),
        cell('收藏', s.favorite),
      ].join('');

  // 分P / 合集列表
  const partsBox = $('#partsBox');
  if (m.parts.length > 1) {
    partsBox.classList.remove('hidden');
    renderParts(m);
  } else {
    partsBox.classList.add('hidden');
  }
  updateDlCount();
}

function renderParts(m) {
  const list = $('#partsList');
  // 兜底：万一 state.parts 又被改成数组之类，也只是勾选状态不对，
  // 绝不能再让整段解析流程抛异常（这个坑踩过一次了）。
  if (!(state.parts instanceof Set)) state.parts = new Set(state.parts || []);

  list.innerHTML = m.parts
    .map(
      (p) => `
    <label class="part-item">
      <input type="checkbox" data-idx="${p.index}" ${state.parts.has(p.index) ? 'checked' : ''} />
      <span class="part-idx">P${p.index}</span>
      <span class="part-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
      <span class="part-dur">${fmtDuration(p.duration)}</span>
    </label>`
    )
    .join('');

  $('#partsCount').textContent = `共 ${m.parts.length} 个`;
  $('#chkAll').checked = true;

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const idx = Number(cb.dataset.idx);
      if (cb.checked) state.parts.add(idx);
      else state.parts.delete(idx);
      syncChkAll();
      updateDlCount();
    });
  });
}

function syncChkAll() {
  const all = $$('#partsList input[type="checkbox"]');
  const checked = all.filter((c) => c.checked).length;
  const chkAll = $('#chkAll');
  chkAll.checked = checked === all.length && all.length > 0;
  chkAll.indeterminate = checked > 0 && checked < all.length;
}

$('#chkAll').addEventListener('change', (e) => {
  const on = e.target.checked;
  $$('#partsList input[type="checkbox"]').forEach((cb) => {
    cb.checked = on;
    const idx = Number(cb.dataset.idx);
    if (on) state.parts.add(idx);
    else state.parts.delete(idx);
  });
  updateDlCount();
});

$$('.parts-tools .btn').forEach((b) => {
  b.addEventListener('click', () => {
    const mode = b.dataset.range;
    $$('#partsList input[type="checkbox"]').forEach((cb) => {
      const idx = Number(cb.dataset.idx);
      let on;
      if (mode === 'all') on = true;
      else if (mode === 'none') on = false;
      else if (mode === 'odd') on = idx % 2 === 1;
      else on = idx % 2 === 0;
      cb.checked = on;
      if (on) state.parts.add(idx);
      else state.parts.delete(idx);
    });
    syncChkAll();
    updateDlCount();
  });
});

function updateDlCount() {
  const total = state.media && Array.isArray(state.media.parts) ? state.media.parts.length : 0;
  // 单视频没有「分集选择」这回事，计数恒为 1；多集时必须按真实勾选数算，
  // 否则全不选会被算成 1，按钮反而变成可点。
  const n = total > 1 ? state.parts.size : state.media ? 1 : 0;
  const tip = n > 1 ? `(${n} 个)` : '';
  $('#dlCount').textContent = tip;
  $('#audioCount').textContent = tip;
  $('#btnDownload').disabled = n === 0;
  // 「只下载音频」与主按钮同进退：都没选分集时一起禁用
  $('#btnDownloadAudio').disabled = n === 0;
}

/* ---------------------------------------------------------------- 流选择 */

async function loadPreview(media, part) {
  // 抖音：档位在解析阶段就随详情一起拿到了，无需再发请求；
  // 也没有音轨可选（音视频同在一个 MP4 里）。
  if (media.platform === 'douyin') {
    const qs = media.qualities || [];
    state.preview = {
      platform: 'douyin',
      videos: qs.map((q) => ({ id: q.id, desc: q.label, codecLabel: q.codecLabel, sizeBytes: q.sizeBytes })),
      audios: [],
    };
    state.selVideoQn = qs.length ? qs[0].id : 0;
    state.selAudioQn = 0;
    renderChips();
    $('#streamTip').textContent =
      '抖音视频是单文件 MP4（音轨已包含在内），无需混流；所选档位即无水印原片清晰度。若要「只下载音频」，会先下整段原片再抽出音轨。';
    return;
  }

  $('#streamTip').textContent = '正在获取可用画质…';
  try {
    // ★ 必须用「该集自己的 bvid」：合集里每一集都是 UP 主的独立投稿，bvid 各不相同。
    //   拿 media.bvid（用户点进来的那一集）去配别的 part.cid，B站 会直接回
    //   code=-404「啥都木有」，表现为列表能出来但画质一直"获取失败"。
    const p = await api.preview(part.bvid || media.bvid, part.cid);
    state.preview = p;

    const vQn = state.config.videoQn || 80;
    const aQn = state.config.audioQn || 30280;
    state.selVideoQn = p.videos.some((v) => v.id === vQn) ? vQn : (p.videos[0] ? p.videos[0].id : 0);
    state.selAudioQn = p.audios.some((a) => a.id === aQn) ? aQn : (p.audios[0] ? p.audios[0].id : 0);

    renderChips();
    if (!state.user.isLogin) {
      $('#streamTip').textContent = '提示：未登录仅能获取到较低画质，登录后可解锁 1080P 及以上 / 大会员画质。';
    } else {
      $('#streamTip').textContent = '';
    }
  } catch (e) {
    $('#streamTip').textContent = '获取画质失败：' + (e.message || e);
    $('#videoChips').innerHTML = '';
    $('#audioChips').innerHTML = '';
  }
}

function renderChips() {
  const p = state.preview;
  if (!p) return;

  $('#videoChips').innerHTML = p.videos
    .map((v) => {
      // 「大会员画质」是 B站 的语义：id >= 112 才需要会员。
      // 抖音的 id 只是内部编号（292 / 211 之类），不能套这个规则，否则会误标 VIP。
      const vip = p.platform !== 'douyin' && typeof v.id === 'number' && v.id >= 112;
      return `<button class="chip ${String(v.id) === String(state.selVideoQn) ? 'active' : ''} ${vip ? 'vip' : ''}" data-kind="v" data-id="${v.id}">
        ${escapeHtml(v.desc)}<small>${escapeHtml(v.codecLabel)}</small></button>`;
    })
    .join('');

  $('#audioChips').innerHTML = p.audios
    .map(
      (a) =>
        `<button class="chip ${String(a.id) === String(state.selAudioQn) ? 'active' : ''}" data-kind="a" data-id="${a.id}">${escapeHtml(
          a.desc
        )}<small>${escapeHtml(a.codecLabel)}</small></button>`
    )
    .join('');

  // 没有音轨可选项时（例如抖音）整行隐藏，避免出现空白的「音质」
  const audioRow = $('#audioRow');
  if (audioRow) audioRow.classList.toggle('hidden', !p.audios.length);

  $$('.chips .chip').forEach((b) => {
    b.addEventListener('click', () => {
      const kind = b.dataset.kind;
      const raw = b.dataset.id;
      // ★ dataset 里的 id 永远是字符串。这里必须把纯数字转回 number：
      //   state 里的初始选中值是 number（80 / 30280 / 抖音的 72…），
      //   下面 toggle 高亮与重渲染时的比较都依赖类型一致 —— 曾经把字符串
      //   "80" 直接赋给 state.selVideoQn，`v.id === state.selVideoQn` 严格比较
      //   永远为 false，选中框从此不再高亮（下载却仍是对的，极难察觉）。
      //   抖音的 "10#2" 这类复合 id 不是纯数字，保持字符串原样。
      const id = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      const pool = kind === 'v' ? p.videos : p.audios;
      if (pool.some((x) => String(x.id) === String(id))) {
        if (kind === 'v') state.selVideoQn = id;
        else state.selAudioQn = id;
      }
      // 原地切换高亮：不再整行重建 innerHTML（重建会让按钮闪一下、焦点也丢）
      const box = kind === 'v' ? $('#videoChips') : $('#audioChips');
      const cur = kind === 'v' ? state.selVideoQn : state.selAudioQn;
      box.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('active', String(c.dataset.id) === String(cur));
      });
    });
  });
}

/* ---------------------------------------------------------------- 添加任务 */

$('#btnDownload').addEventListener('click', async () => {
  if (!state.media) return;
  if (!state.parts.size) return toast('请至少选择一个视频', 'warn');

  const btn = $('#btnDownload');
  btn.disabled = true;
  try {
    const r = await api.addTasks(state.media, {
      parts: Array.from(state.parts),
      videoQn: state.selVideoQn,
      audioQn: state.selAudioQn,
    });
    toast(`已添加 ${r.count} 个下载任务`, 'success');
    switchTab('queue');
  } catch (e) {
    toast('添加失败：' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
  }
});

/** 音频输出格式（下拉优先，其次用设置里的默认值） */
function currentAudioFormat() {
  const v = $('#audioFmt') ? $('#audioFmt').value : state.config.audioFormat;
  return v === 'mp3' ? 'mp3' : 'm4a';
}

/**
 * 「只下载音频」。
 *
 * B站：只取音频轨（不下载视频流，省流量）；
 * 抖音：没有独立音轨，会先下整段 MP4 再抽出音轨（进度和视频一样长属正常）。
 * 音轨的挑选与回退逻辑都在主进程（见 downloader._resolveAudioStream），
 * 这里只管发起。
 */
$('#btnDownloadAudio').addEventListener('click', async () => {
  if (!state.media) return;
  if (!state.parts.size) return toast('请至少选择一个视频', 'warn');

  const btn = $('#btnDownloadAudio');
  const fmt = currentAudioFormat();
  btn.disabled = true;
  try {
    const r = await api.addTasks(state.media, {
      parts: Array.from(state.parts),
      videoQn: state.selVideoQn,
      audioQn: state.selAudioQn,
      mode: 'audio',
      audioFormat: fmt,
    });
    // 提前打个招呼：MP3 不一定能「直提」，源音轨不是 MP3 时要做一次转码，会慢一些。
    // 具体是直提还是转码，要等音轨下完、探测出编码才知道，队列卡片上会实时写清楚。
    toast(
      fmt === 'mp3'
        ? `已添加 ${r.count} 个音频任务（MP3）· 源音轨非 MP3 时自动转码，需要一点时间`
        : `已添加 ${r.count} 个音频任务（M4A）`,
      'success'
    );
    switchTab('queue');
  } catch (e) {
    toast('添加失败：' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#audioFmt').addEventListener('change', (e) => {
  saveSetting('audioFormat', e.target.value === 'mp3' ? 'mp3' : 'm4a');
});

$('#btnReset').addEventListener('click', () => {
  $('#mediaBox').classList.add('hidden');
  $('#parseInput').value = '';
  updateClearBtn();
  setStatus('');
  state.media = null;
  state.preview = null;
  state.parts = new Set();
});

/* ---------------------------------------------------------------- 队列 */

function createCard(t) {
  const el = document.createElement('div');
  el.className = 'qcard';
  el.dataset.id = t.id;
  el.innerHTML = `
    <div class="qhead">
      <img class="qcover" alt="" />
      <div class="qmain">
        <div class="qtitle"></div>
        <div class="qsub">
          <span class="qtag js-type"></span>
          <span class="js-up"></span>
          <span class="js-qn"></span>
        </div>
        <div class="qbar">
          <div class="progress"><div class="progress-bar js-bar"></div></div>
          <div class="qfoot">
            <span class="status-text js-status"></span>
            <span class="js-info"></span>
          </div>
        </div>
      </div>
      <div class="qactions js-actions"></div>
    </div>`;
  return el;
}

/**
 * 缓存卡片内部的节点引用。
 * 注意：绝不能再用「按 class 反查」的方式每次重新 querySelector ——
 * 一旦某个 class 被当成状态样式整体重写（例如 status-downloading），
 * 原来的钩子类会一起丢掉，下次查询就变成 null 并抛错，卡片会永久卡死。
 */
function cardRefs(el) {
  if (!el.__refs) {
    el.__refs = {
      cover: el.querySelector('.qcover'),
      title: el.querySelector('.qtitle'),
      type: el.querySelector('.js-type'),
      up: el.querySelector('.js-up'),
      qn: el.querySelector('.js-qn'),
      bar: el.querySelector('.js-bar'),
      status: el.querySelector('.js-status'),
      info: el.querySelector('.js-info'),
      acts: el.querySelector('.js-actions'),
    };
  }
  return el.__refs;
}

function updateCard(el, t) {
  const r = cardRefs(el);

  const src = imgSrc(t.cover);
  if (r.cover.getAttribute('src') !== src) r.cover.src = src;

  r.title.textContent = t.part ? `${t.title} · ${t.part}` : t.title;
  r.type.textContent = t.type || '单视频';
  r.up.textContent = t.upName || '';
  r.qn.textContent = [t.qnName, t.audioName].filter(Boolean).join(' / ');

  el.className = 'qcard ' + t.status;

  if (t.status === 'merging') {
    // 音频任务复用 merging 状态，但文案要说人话：这里在抽音轨 / 转码，不是混流。
    // mergeHint 是主进程探测出源音轨编码后给的实时说明（「直接提取」还是「要转码、得等一会儿」）。
    const audio = t.kind === 'audio';
    const hint = (t.mergeHint || '').trim();
    // 由主进程直接告知这一步是不是转码，别去猜文案里有没有「转码」二字
    const transcoding = audio && !!t.mergeTranscoding;
    r.bar.classList.add('indeterminate');
    r.status.textContent = audio ? (transcoding ? '转码中' : '处理音频') : '混流中';
    r.status.className = 'status-text js-status status-merging';
    r.info.textContent = audio ? hint || '正在抽取音轨…' : '正在合并音视频…';
  } else {
    r.bar.classList.remove('indeterminate');
    r.bar.style.width = Math.min(100, t.progress || 0) + '%';
    r.status.textContent = STATUS_TEXT[t.status] || t.status;
    r.status.className = 'status-text js-status status-' + t.status;

    if (t.status === 'downloading') r.info.textContent = `${t.progress || 0}%  ·  ${t.speedText || '—'}  ·  ${t.totalText || ''}`;
    else if (t.status === 'done')
      r.info.textContent = ['已完成', t.sizeText || '', t.audioNote || ''].filter(Boolean).join('  ·  ');
    else if (t.status === 'error') r.info.textContent = t.error || '下载失败';
    else if (t.status === 'paused') r.info.textContent = `已暂停于 ${t.progress || 0}%`;
    else r.info.textContent = t.totalText || '';
  }

  // 操作按钮
  const acts = r.acts;
  const wanted = [];
  if (t.status === 'downloading') wanted.push(['pause', '暂停']);
  if (t.status === 'paused') wanted.push(['resume', '继续']);
  if (t.status === 'waiting' || t.status === 'downloading' || t.status === 'paused') wanted.push(['cancel', '取消']);
  if (t.status === 'done') wanted.push(['openFolder', '打开目录']);
  if (t.status === 'error' || t.status === 'canceled') wanted.push(['resume', '重试']);
  if (t.status === 'done' || t.status === 'error' || t.status === 'canceled') wanted.push(['remove', '移除']);

  const sig = wanted.map((w) => w[0]).join(',');
  if (acts.dataset.sig !== sig) {
    acts.dataset.sig = sig;
    acts.innerHTML = wanted
      .map(([a, label]) => `<button class="btn btn-mini" data-act="${a}">${label}</button>`)
      .join('');
    acts.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => taskAction(b.dataset.act, t.id));
    });
  }
}

function renderQueue(tasks) {
  const list = $('#queueList');
  const empty = $('#queueEmpty');

  if (!tasks.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const existing = new Map(Array.from(list.children).map((el) => [el.dataset.id, el]));
  const seen = new Set();

  for (const t of tasks) {
    let el = existing.get(t.id);
    if (!el) el = createCard(t);
    updateCard(el, t);
    list.appendChild(el);
    seen.add(t.id);
  }
  for (const [id, el] of existing) if (!seen.has(id)) el.remove();
}

async function taskAction(action, id) {
  // '重试' 复用 resume
  const map = { retry: 'resume' };
  const r = await api.taskAction(map[action] || action, id);
  if (r && r.ok === false && !action.startsWith('open')) {
    toast('操作未完成：' + (r.message || '当前状态不允许此操作'), 'warn');
  }
}

async function copyText(text) {
  if (!text) return toast('没有可复制的内容', 'warn');
  const ok = await api.copyText(String(text));
  toast(ok ? '已复制到剪切板' : '复制失败', ok ? 'success' : 'error', 1500);
}

/* ---------------------------------------------------------------- 右键菜单 */

const ctxMenu = $('#ctxMenu');
let ctxOpen = false;

function closeCtxMenu() {
  if (!ctxOpen) return;
  ctxOpen = false;
  ctxMenu.classList.add('hidden');
  ctxMenu.innerHTML = '';
}

function showCtxMenu(x, y, items) {
  ctxMenu.innerHTML = items
    .map((it, i) =>
      it.sep
        ? '<div class="ctx-sep"></div>'
        : `<button class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}"${
            it.disabled ? ' disabled' : ''
          }><span class="ctx-label">${escapeHtml(it.label)}</span>${
            it.hint ? `<span class="ctx-hint">${escapeHtml(it.hint)}</span>` : ''
          }</button>`
    )
    .join('');
  ctxMenu.classList.remove('hidden');
  ctxMenu.style.left = '0px';
  ctxMenu.style.top = '0px';

  // 先渲染再量尺寸，保证菜单不会超出窗口
  const box = ctxMenu.getBoundingClientRect();
  const left = Math.max(6, Math.min(x, window.innerWidth - box.width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - box.height - 6));
  ctxMenu.style.left = left + 'px';
  ctxMenu.style.top = top + 'px';
  ctxOpen = true;

  ctxMenu.querySelectorAll('.ctx-item').forEach((b) => {
    b.addEventListener('click', () => {
      const it = items[Number(b.dataset.i)];
      closeCtxMenu();
      if (it && !it.disabled && it.action) it.action();
    });
  });
}

// 菜单内的 mousedown 会抢走输入框焦点，导致随后的「粘贴」落空 —— 一律拦掉
ctxMenu.addEventListener('mousedown', (e) => e.preventDefault());

// 点击别处 / 按 Esc / 窗口失焦或尺寸变化时收起
document.addEventListener('mousedown', (e) => {
  if (ctxOpen && !ctxMenu.contains(e.target)) closeCtxMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu();
});
window.addEventListener('blur', closeCtxMenu);
window.addEventListener('resize', closeCtxMenu);
document.addEventListener('scroll', closeCtxMenu, true);
// ---- 可编辑区域（输入框 / 文本域）的右键：剪切 / 复制 / 粘贴 / 全选 ----
// Electron 默认不弹系统右键菜单，所以这里必须自己画一个，动作交给主进程执行。

const NON_TEXT_INPUT = ['checkbox', 'radio', 'range', 'file', 'color', 'date', 'time', 'month', 'week', 'number', 'button', 'submit', 'reset'];

function editableTarget(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    if (el.disabled) return null;
    if (NON_TEXT_INPUT.includes(String(el.type || 'text').toLowerCase())) return null;
    return el;
  }
  if (tag === 'TEXTAREA') return el.disabled ? null : el;
  if (el.isContentEditable) return el;
  return null;
}

function hasSelection(el) {
  if (el.isContentEditable) return String(window.getSelection() || '').length > 0;
  return (el.selectionEnd || 0) > (el.selectionStart || 0);
}

// 执行前把焦点还给目标输入框，避免焦点漂移导致「粘贴」落空
function editAction(action, el) {
  return () => {
    try {
      el.focus();
    } catch (e) {
      /* 忽略 */
    }
    api.editAction(action);
  };
}

async function pasteAndParse() {
  await api.editAction('paste');
  doParse();
}

function editMenuItems(el) {
  const ro = el.readOnly === true;
  const sel = hasSelection(el);
  const items = [
    { label: '剪切', hint: 'Ctrl+X', disabled: ro || !sel, action: editAction('cut', el) },
    { label: '复制', hint: 'Ctrl+C', disabled: !sel, action: editAction('copy', el) },
    { label: '粘贴', hint: 'Ctrl+V', disabled: ro, action: editAction('paste', el) },
  ];
  if (el.id === 'parseInput') {
    items.push({ label: '粘贴并解析', disabled: ro, action: pasteAndParse });
  }
  items.push({ sep: true });
  items.push({ label: '全选', hint: 'Ctrl+A', action: editAction('selectAll', el) });
  return items;
}

// 屏蔽系统默认右键菜单（一律用自绘菜单）
document.addEventListener('contextmenu', (e) => {
  const el = editableTarget(e.target);
  if (el) {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, editMenuItems(el));
    return;
  }
  e.preventDefault();
}, false);

function onContextMenu(container, resolve) {
  if (!container) return;
  container.addEventListener('contextmenu', (e) => {
    const items = resolve(e);
    if (!items || !items.length) return;
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, items);
  });
}

// 下载队列：右键任务卡片
onContextMenu($('#queueList'), (e) => {
  const card = e.target.closest('.qcard');
  if (!card) return null;
  const t = state.tasks.find((x) => x.id === card.dataset.id);
  if (!t) return null;

  const items = [];
  if (t.status === 'downloading' || t.status === 'merging') items.push({ label: '暂停', action: () => taskAction('pause', t.id) });
  if (t.status === 'waiting' || t.status === 'paused') items.push({ label: '继续下载', action: () => taskAction('resume', t.id) });
  if (t.status === 'error' || t.status === 'canceled') items.push({ label: '重新下载', action: () => taskAction('resume', t.id) });
  if (t.status === 'done') items.push({ label: '打开文件', action: () => taskAction('openFile', t.id) });
  if (t.status !== 'waiting' && t.status !== 'downloading' && t.status !== 'merging') {
    items.push({ label: '打开所在目录', action: () => taskAction('openFolder', t.id) });
  }
  items.push({ sep: true });
  items.push({ label: '复制视频链接', action: () => taskAction('copyLink', t.id) });
  items.push({ label: '复制标题', action: () => copyText(t.title) });
  items.push({ sep: true });
  if (t.status === 'waiting' || t.status === 'downloading' || t.status === 'paused' || t.status === 'merging') {
    items.push({ label: '取消任务', danger: true, action: () => taskAction('cancel', t.id) });
  } else {
    items.push({ label: '从列表移除', danger: true, action: () => taskAction('remove', t.id) });
  }
  return items;
});

// 下载记录：右键表格行
onContextMenu($('#historyBody'), (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return null;
  const h = historyCache[Number(tr.querySelector('[data-i]').dataset.i)];
  if (!h) return null;
  const dir = h.file ? h.file.replace(/[\\/][^\\/]+$/, '') : '';
  return [
    { label: '打开文件', action: () => api.openPath(h.file) },
    {
      label: '打开所在目录',
      action: async () => {
        const r = await api.openFolder(dir);
        if (!r.ok) toast('目录不存在：' + dir, 'warn');
      },
    },
    { sep: true },
    { label: '复制文件路径', action: () => copyText(h.file) },
    { label: '复制标题', action: () => copyText(h.title) },
    {
      label: '复制视频链接',
      action: () =>
        copyText(
          h.sourceUrl ||
            (h.platform === 'douyin' || h.awemeId
              ? `https://www.douyin.com/video/${h.awemeId}`
              : `https://www.bilibili.com/video/${h.bvid}`)
        ),
    },
  ];
});

$('#btnPauseAll').addEventListener('click', async () => {
  await api.allAction('pauseAll');
  toast('已暂停全部任务', 'info');
});
$('#btnResumeAll').addEventListener('click', async () => {
  await api.allAction('resumeAll');
  toast('已继续全部任务', 'info');
});
$('#btnClearDone').addEventListener('click', async () => {
  await api.allAction('clearFinished');
  toast('已清理完成的任务', 'info');
});

/* ---------------------------------------------------------------- 下载记录 */

let historyCache = [];

async function loadHistory() {
  historyCache = await api.history();
  const body = $('#historyBody');
  const empty = $('#historyEmpty');

  if (!historyCache.length) {
    body.innerHTML = '';
    empty.classList.remove('hidden');
    $('.table-wrap').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  $('.table-wrap').classList.remove('hidden');

  body.innerHTML = historyCache
    .map(
      (h, i) => `
    <tr>
      <td class="t-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</td>
      <td>${escapeHtml(h.upName || '—')}</td>
      <td>${escapeHtml(h.qnName || '—')}</td>
      <td>${humanSize(h.size)}</td>
      <td>${fmtDate(h.ts)}</td>
      <td><div class="t-actions">
        <button class="btn btn-mini" data-hact="open" data-i="${i}">打开目录</button>
      </div></td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('button[data-hact="open"]').forEach((b) => {
    b.addEventListener('click', async () => {
      const h = historyCache[Number(b.dataset.i)];
      const dir = h && h.file ? h.file.replace(/[\\/][^\\/]+$/, '') : '';
      const r = await api.openFolder(dir);
      if (!r.ok) toast('目录不存在：' + dir, 'warn');
    });
  });
}

$('#btnClearHis').addEventListener('click', async () => {
  if (!confirm('确定清空全部下载记录吗？此操作不可恢复。')) return;
  await api.clearHistory();
  loadHistory();
  toast('下载记录已清空', 'success');
});

$('#btnExportHis').addEventListener('click', async () => {
  const data = await api.history();
  if (!data.length) return toast('暂无记录可导出', 'warn');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `video-downloader-history-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`已导出 ${data.length} 条记录`, 'success');
});

/* ---------------------------------------------------------------- 工具箱 */

$('#btnPickMp3').addEventListener('click', async () => {
  const f = await api.selectFile({
    filters: [{ name: '音频文件', extensions: ['m4s', 'aac', 'm4a', 'mp4', 'flac'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (f) $('#mp3Input').value = f;
});

$('#btnRunMp3').addEventListener('click', async () => {
  const f = $('#mp3Input').value;
  if (!f) return toast('请先选择音频文件', 'warn');
  $('#mp3ProgressWrap').classList.remove('hidden');
  $('#mp3ProgressBar').style.width = '0%';
  const r = await api.toolConvertMp3(f);
  $('#mp3ProgressWrap').classList.add('hidden');
  if (r.ok) toast('转换完成：' + r.out.split('\\').pop(), 'success');
  else toast('转换失败：' + r.message, 'error');
});

$('#btnPickV').addEventListener('click', async () => {
  const f = await api.selectFile({ filters: [{ name: '视频文件', extensions: ['m4s', 'mp4', 'flv', 'mkv'] }] });
  if (f) $('#mixVideo').value = f;
});
$('#btnPickA').addEventListener('click', async () => {
  const f = await api.selectFile({ filters: [{ name: '音频文件', extensions: ['m4s', 'm4a', 'aac', 'mp3'] }] });
  if (f) $('#mixAudio').value = f;
});
$('#btnPickO').addEventListener('click', async () => {
  const d = await api.selectDir();
  if (d) $('#mixOut').value = d;
});

$('#btnRunMix').addEventListener('click', async () => {
  const v = $('#mixVideo').value;
  const a = $('#mixAudio').value;
  const o = $('#mixOut').value;
  if (!v || !a) return toast('请选择视频与音频文件', 'warn');
  if (!o) return toast('请选择输出文件夹', 'warn');
  $('#mixProgressWrap').classList.remove('hidden');
  $('#mixProgressBar').style.width = '0%';
  const r = await api.toolMerge(v, a, o);
  $('#mixProgressWrap').classList.add('hidden');
  if (r.ok) toast('混流完成：' + r.out.split('\\').pop(), 'success');
  else toast('混流失败：' + r.message, 'error');
});

/* ---------------------------------------------------------------- 设置 */

function renderSettings() {
  const c = state.config;

  $('#setSavePath').value = c.savePath || '';
  $('#setConcurrency').value = c.concurrency || 3;
  $('#valConcurrency').textContent = c.concurrency || 3;
  $('#setFileRule').value = c.fileRule || '{title}';
  $('#setFolderRule').value = c.folderRule || '';
  $('#setAddIndex').checked = !!c.addIndexToFolder;

  fillQnSelects();
  $('#setVideoQn').value = c.videoQn || 80;
  $('#setAudioQn').value = c.audioQn || 30280;

  // 设置页与解析页的音频格式下拉保持同一个值
  const audioFmt = c.audioFormat === 'mp3' ? 'mp3' : 'm4a';
  $('#setAudioFormat').value = audioFmt;
  $('#audioFmt').value = audioFmt;

  $('#setCover').checked = !!c.saveCover;
  $('#setDanmaku').checked = !!c.saveDanmaku;
  $('#setAss').checked = !!c.saveAss;
  $('#setSubtitle').checked = !!c.saveSubtitle;
  $('#setNfo').checked = !!c.saveNfo;
  $('#setKeepV').checked = !!c.keepVideo;
  $('#setKeepA').checked = !!c.keepAudio;

  $('#setAutoShutdown').checked = !!c.autoShutdown;
  $('#setClipWatch').checked = !!c.clipWatch;
  $('#setMinTray').checked = !!c.minToTray;

  renderVarButtons();
  refreshAriaInfo();
}

function fillQnSelects() {
  const v = $('#setVideoQn');
  if (!v.options.length) {
    v.innerHTML = QN_LIST.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    const a = $('#setAudioQn');
    a.innerHTML = AUDIO_LIST.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  }
}

function renderVarButtons() {
  const vars = state.nameVars || [];
  const mk = (target, withIndex) => {
    const el = $(target);
    el.innerHTML = vars
      .filter((v) => withIndex || v.key !== '{index}')
      .map((v) => `<button class="var-btn" data-key="${v.key}" title="${escapeHtml(v.desc)}">${v.key}</button>`)
      .join('');
    el.querySelectorAll('.var-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const input = target === '#fileVars' ? $('#setFileRule') : $('#setFolderRule');
        const pos = input.selectionStart == null ? input.value.length : input.selectionStart;
        input.value = input.value.slice(0, pos) + b.dataset.key + input.value.slice(pos);
        input.focus();
        input.selectionStart = input.selectionEnd = pos + b.dataset.key.length;
        saveSetting(target === '#fileVars' ? 'fileRule' : 'folderRule', input.value);
      });
    });
  };
  mk('#fileVars', true);
  mk('#folderVars', false);
}

async function saveSetting(key, value) {
  await api.setConfig({ [key]: value });
  state.config[key] = value;
}

function bindSwitch(id, key) {
  $(id).addEventListener('change', (e) => saveSetting(key, e.target.checked));
}

bindSwitch('#setCover', 'saveCover');
bindSwitch('#setDanmaku', 'saveDanmaku');
bindSwitch('#setAss', 'saveAss');
bindSwitch('#setSubtitle', 'saveSubtitle');
bindSwitch('#setNfo', 'saveNfo');
bindSwitch('#setKeepV', 'keepVideo');
bindSwitch('#setKeepA', 'keepAudio');
bindSwitch('#setAutoShutdown', 'autoShutdown');
bindSwitch('#setClipWatch', 'clipWatch');
bindSwitch('#setMinTray', 'minToTray');
bindSwitch('#setAddIndex', 'addIndexToFolder');

$('#setConcurrency').addEventListener('input', (e) => {
  $('#valConcurrency').textContent = e.target.value;
});
$('#setConcurrency').addEventListener('change', (e) => saveSetting('concurrency', Number(e.target.value)));
$('#setVideoQn').addEventListener('change', (e) => saveSetting('videoQn', Number(e.target.value)));
$('#setAudioQn').addEventListener('change', (e) => saveSetting('audioQn', Number(e.target.value)));
$('#setAudioFormat').addEventListener('change', (e) => {
  const v = e.target.value === 'mp3' ? 'mp3' : 'm4a';
  saveSetting('audioFormat', v);
  $('#audioFmt').value = v; // 两处下拉同步
});
$('#setFileRule').addEventListener('change', (e) => saveSetting('fileRule', e.target.value));
$('#setFolderRule').addEventListener('change', (e) => saveSetting('folderRule', e.target.value));

$('#btnSetSavePath').addEventListener('click', async () => {
  const d = await api.selectDir();
  if (d) {
    await saveSetting('savePath', d);
    $('#setSavePath').value = d;
    toast('下载目录已更新', 'success');
  }
});
$('#btnOpenSavePath').addEventListener('click', async () => {
  const r = await api.openFolder(state.config.savePath);
  if (!r.ok) toast('目录不存在', 'warn');
});
$('#btnRestartAria').addEventListener('click', async () => {
  toast('正在重启下载进程…', 'info');
  const r = await api.restartAria2();
  if (r.ok) toast('下载进程已重启（端口 ' + r.port + '）', 'success');
  else toast('重启失败：' + r.message, 'error');
  refreshAriaInfo();
});

$('#btnResetSettings').addEventListener('click', async () => {
  if (!confirm('确定恢复默认设置吗？\n\n' +
    '「下载 / 命名规则 / 附加内容 / 行为」里的所有选项都会回到出厂默认值，\n' +
    '下载目录也会重置为系统默认的下载文件夹。\n\n' +
    '下载记录、下载中的任务和登录状态不受影响。')) return;
  const c = await api.resetConfig();
  if (c && c.savePath !== undefined) {
    state.config = c;
    renderSettings();          // 重绘所有控件（含解析页的音频格式下拉同步）
    toast('已恢复默认设置', 'success');
  } else {
    toast('恢复失败，请重试', 'error');
  }
});

async function refreshAriaInfo() {
  const r = await api.ariaStatus();
  const dot = $('#ariaDot');
  const txt = $('#ariaText');
  const info = $('#setAriaInfo');
  if (r.ok) {
    dot.className = 'dot ok';
    txt.textContent = 'aria2 ' + r.version;
    if (info) info.textContent = `运行中 · aria2 ${r.version} · 端口 ${r.port}`;
  } else {
    dot.className = 'dot bad';
    txt.textContent = '下载进程未就绪';
    if (info) info.textContent = '未就绪' + (r.message ? '：' + r.message : '');
  }
}

/* ---------------------------------------------------------------- 登录 */

$('#userCard').addEventListener('click', async () => {
  if (state.user.isLogin) {
    if (confirm(`已登录：${state.user.name}\n\n是否退出登录？`)) {
      await api.logout();
      state.user = { isLogin: false };
      renderUser();
      toast('已退出登录', 'info');
    }
    return;
  }
  openLogin();
});

let qrTimer = null;

async function openLogin() {
  $('#modalLogin').classList.remove('hidden');
  $('#qrTip').textContent = '正在请求二维码…';
  $('#qrMask').classList.add('hidden');
  await refreshQr();
}

async function refreshQr() {
  try {
    const r = await api.qrGenerate();
    $('#qrImg').src = r.qrDataUrl || '';
    $('#qrTip').textContent = '请使用 B站客户端扫码';
    $('#qrMask').classList.add('hidden');

    if (qrTimer) clearInterval(qrTimer);
    qrTimer = setInterval(async () => {
      try {
        const p = await api.qrPoll(r.qrcodeKey);
        $('#qrTip').textContent = p.message || '';
        if (p.state === 'success') {
          clearInterval(qrTimer);
          qrTimer = null;
          $('#modalLogin').classList.add('hidden');
          toast('登录成功！', 'success');
          state.user = await api.userInfo();
          renderUser();
          // 刷新画质（登录后可能有更高画质）—— 抖音不依赖登录，跳过
          if (state.media && state.media.parts.length && state.media.platform !== 'douyin') {
            loadPreview(state.media, state.media.parts[0]);
          }
        } else if (p.state === 'expired') {
          clearInterval(qrTimer);
          qrTimer = null;
          $('#qrMask').classList.remove('hidden');
          $('#qrMaskText').textContent = '二维码已过期';
        }
      } catch (e) {
        /* 忽略单次失败 */
      }
    }, 1500);
  } catch (e) {
    $('#qrTip').textContent = '获取二维码失败：' + (e.message || e);
  }
}

$('#btnQrRefresh').addEventListener('click', refreshQr);

$$('[data-close]').forEach((el) => {
  el.addEventListener('click', () => {
    $('#modalLogin').classList.add('hidden');
    if (qrTimer) {
      clearInterval(qrTimer);
      qrTimer = null;
    }
  });
});

function renderUser() {
  const u = state.user;
  const av = $('#userAvatar');
  if (u.isLogin) {
    $('#userName').textContent = u.name;
    $('#userSub').textContent = (u.vipLabel ? u.vipLabel + ' · ' : '') + `LV${u.level || 0}`;
    if (u.face) {
      av.style.backgroundImage = `url("${imgSrc(u.face)}")`;
      av.textContent = '';
    } else {
      av.textContent = (u.name || '?').slice(0, 1);
    }
  } else {
    $('#userName').textContent = '未登录';
    $('#userSub').textContent = '点击扫码登录';
    av.style.backgroundImage = '';
    av.textContent = '未';
  }
}

/* ---------------------------------------------------------------- 关机 */

function showShutdownModal(seconds) {
  $('#modalShutdown').classList.remove('hidden');
  let left = seconds;
  $('#sdSec').textContent = left;
  if (state.sdTimer) clearInterval(state.sdTimer);
  state.sdTimer = setInterval(() => {
    left--;
    $('#sdSec').textContent = Math.max(0, left);
    if (left <= 0) {
      clearInterval(state.sdTimer);
      state.sdTimer = null;
      $('#modalShutdown').classList.add('hidden');
    }
  }, 1000);
}

$('#btnSdCancel').addEventListener('click', async () => {
  await api.cancelShutdown();
  if (state.sdTimer) {
    clearInterval(state.sdTimer);
    state.sdTimer = null;
  }
  $('#modalShutdown').classList.add('hidden');
  toast('已取消自动关机', 'success');
});

/* ---------------------------------------------------------------- 窗口 */

$('#btnMin').addEventListener('click', () => api.win.min());
$('#btnClose').addEventListener('click', () => api.win.close());
$('#btnMax').addEventListener('click', async () => {
  await api.win.max();
});

/* ---------------------------------------------------------------- 事件 */

api.on('tasks-update', (tasks) => {
  state.tasks = tasks;
  renderQueue(tasks);

  const active = tasks.filter((t) => t.status === 'waiting' || t.status === 'downloading' || t.status === 'merging').length;
  const badge = $('#queueBadge');
  badge.textContent = active;
  badge.classList.toggle('zero', active === 0);
});

api.on('task-done', (d) => {
  toast('下载完成：' + (d.file || '').split('\\').pop(), 'success');
});

api.on('task-error', (d) => {
  toast('任务失败：' + d.error, 'error', 4200);
});

api.on('extras-warn', (d) => {
  toast(`${d.what}保存失败：${d.error}`, 'warn', 4000);
});

api.on('all-finished', (d) => {
  if (d.total > 0 && d.ok === d.total) toast(`全部 ${d.total} 个任务已完成`, 'success', 4000);
});

api.on('auto-shutdown', (d) => {
  showShutdownModal(d.seconds || 30);
});

api.on('shutdown-canceled', () => {
  if (state.sdTimer) {
    clearInterval(state.sdTimer);
    state.sdTimer = null;
  }
  $('#modalShutdown').classList.add('hidden');
});

api.on('user-changed', (u) => {
  state.user = u;
  renderUser();
});

api.on('aria2-status', (s) => {
  toast(s.message, s.ok ? 'success' : 'error', 5000);
  refreshAriaInfo();
});

api.on('clipboard-link', (text) => {
  if (document.querySelector('#tab-home').classList.contains('active')) {
    $('#parseInput').value = text;
    updateClearBtn();
    toast('检测到剪切板链接，按「解析」即可下载', 'info');
  }
});

api.on('tool-progress', (p) => {
  const bar = p.type === 'mp3' ? $('#mp3ProgressBar') : $('#mixProgressBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, p.percent || 0)) + '%';
});

/* ---------------------------------------------------------------- 启动 */

async function init() {
  try {
    const st = await api.getState();
    state.config = st.config || {};
    state.user = st.user || { isLogin: false };
    state.nameVars = st.nameVars || [];
    state.tasks = st.tasks || [];

    // 版本 / 构建标记：多个差异很大的包曾经都叫 v1.1.0，界面上必须能一眼分辨新旧
    state.version = st.version;
    state.build = st.build || {};
    const bd = st.build || {};
    const buildTxt = bd.builtAt || (bd.stamp && bd.stamp !== 'dev' ? bd.stamp : '开发版（源码运行）');
    $('#aboutVer').textContent = 'v' + st.version;
    $('#aboutEnv').innerHTML = `
      <span>运行平台：<b>${st.platform}</b></span>
      <span>Electron：<b>${st.packages.electron}</b></span>
      <span>Node：<b>${st.packages.node}</b></span>
      <span>下载引擎：<b>aria2</b> + <b>ffmpeg</b></span>
      <span>构建时间：<b>${escapeHtml(buildTxt)}</b></span>`;

    renderUser();
    renderQueue(state.tasks);
    renderSettings();
    refreshAriaInfo();
    updateClearBtn();
  } catch (e) {
    toast('初始化失败：' + (e.message || e), 'error', 6000);
  }
}

// 拖拽文本到窗口也能解析
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const text = e.dataTransfer.getData('text');
  if (text) {
    switchTab('home');
    $('#parseInput').value = text.trim();
    updateClearBtn();
    doParse();
  }
});

/* ---------------------------------------------------------------- 接口变更预警条 */

/**
 * 主进程启动后会在后台体检一次 B站 接口，只有「接口疑似变更」时才推过来。
 * 断网、超时都会静默，所以正常情况下用户完全不会看到这条。
 */
/** 最近一次体检结果（供「复制诊断信息」按钮打包成一段可直接发出去的文本） */
let lastHealth = null;

/** 把体检结果拼成一段纯文本，用户复制后直接粘贴过来即可定位 */
function buildHealthReport(h) {
  const b = (h && h.build) || state.build || {};
  const when = h && h.checkedAt ? new Date(h.checkedAt).toLocaleString('zh-CN') : '未知时间';
  const line = (f) => `  - ${f.name || '?'} [${f.key || '?'}]：${f.detail || '(无详情)'}`;
  return [
    '=== 视频下载器 接口体检诊断 ===',
    `程序版本：v${state.version || '?'}   构建：${b.builtAt || b.stamp || '开发版'}`,
    `检测时间：${when}   结论：${(h && h.kind) || '无'}`,
    '疑似失效环节：',
    ...((h && h.failed) || []).map(line),
    ((h && h.failed) || []).length ? '' : '  (无)',
    '环境类失败(不弹条)：',
    ...((h && h.netFailed) || []).map(line),
    ((h && h.netFailed) || []).length ? '' : '  (无)',
    h && h.logFile ? `运行日志：${h.logFile}` : '',
    '=================================',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** 复制文本到剪贴板（带 execCommand 兜底，老环境也能用） */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function renderHealthBanner(h) {
  const el = $('#healthBanner');
  if (!el) return;
  if (!h || h.kind !== 'changed') {
    el.classList.add('hidden');
    return;
  }
  lastHealth = h;
  const failed = h.failed || [];
  const names = failed.map((f) => f.name).filter(Boolean);
  const sub = $('.js-health-detail');
  if (sub) {
    // ★ 连「具体错误」一起显示：只写环节名，用户截图过来也定位不到原因
    const first = failed[0];
    const tail = first && first.detail ? '（' + String(first.detail).slice(0, 70) + '）' : '';
    sub.textContent = names.length ? '这些环节可能已失效：' + names.join('、') + tail : '';
  }
  // 指引里列出逐项明细，并把日志文件位置告诉用户
  const list = $('#healthGuideDetail');
  if (list) {
    const when = h.checkedAt ? new Date(h.checkedAt).toLocaleString('zh-CN') : '';
    list.innerHTML = failed.length
      ? '<p><b>本次失败明细</b>' +
        (when ? '（' + escapeHtml(when) + '）' : '') +
        '</p><ul>' +
        failed
          .map(
            (f) =>
              '<li>' +
              escapeHtml(f.name || '') +
              '<code>' +
              escapeHtml(f.key || '') +
              '</code>' +
              escapeHtml(f.detail || '') +
              '</li>'
          )
          .join('') +
        '</ul>'
      : '';
  }
  const lp = $('#healthLogPath');
  if (lp) {
    const b = h.build || {};
    lp.textContent = h.logFile
      ? '诊断信息已写入运行日志：' + h.logFile + (b.builtAt ? '（当前构建 ' + b.builtAt + '）' : '')
      : '';
  }
  el.classList.remove('hidden');
}

(function initHealthBanner() {
  try {
    const el = $('#healthBanner');
    if (!el) return; // 例如在预览页里没有这段结构
    const body = $('#healthGuideBody');
    const btn = $('#healthGuide');
    const close = $('#healthClose');
    if (btn && body) btn.addEventListener('click', () => body.classList.toggle('hidden'));
    if (close) close.addEventListener('click', () => el.classList.add('hidden'));
    // 「重新检测」：当场重跑一次体检，通过就撤掉本提示（并 toast 告知），异常则更新提示内容
    const recheck = $('#healthRecheck');
    if (recheck) {
      recheck.addEventListener('click', async () => {
        const label = recheck.textContent;
        recheck.disabled = true;
        recheck.textContent = '检测中…';
        try {
          const r = api && typeof api.healthCheck === 'function' ? await api.healthCheck() : null;
          renderHealthBanner(r);
          if (r && r.kind === 'ok') toast('接口检测通过，一切正常', 'success');
          else if (r && r.kind === 'offline') toast('网络不通，请检查网络后重试', 'warn');
          else if (r) toast('仍有环节异常，请点「查看修复指引」', 'warn');
        } catch (e) {
          toast('检测失败：' + (e.message || e), 'error');
        }
        recheck.disabled = false;
        recheck.textContent = label;
      });
    }
    // 订阅推送（启动时的体检结果）
    if (api && typeof api.on === 'function') api.on('health', renderHealthBanner);
    // 「复制诊断信息」：把结论 + 失败明细 + 日志路径打包成一段文本，用户粘贴给我即可定位
    const copy = $('#healthCopy');
    if (copy) {
      copy.addEventListener('click', async () => {
        const ok = await copyText(buildHealthReport(lastHealth));
        toast(ok ? '诊断信息已复制，直接粘贴给开发者即可' : '复制失败，请手动查看运行日志', ok ? 'success' : 'warn');
      });
    }
    // 再主动拉一次：万一推送早于本脚本就绪（或用户重载页面），也不会漏掉
    const p = api && typeof api.health === 'function' ? api.health() : null;
    if (p && typeof p.then === 'function') p.then(renderHealthBanner).catch(() => {});
  } catch (e) {
    /* 预警条是附加功能，任何异常都不该影响主流程 */
  }
})();

init();
