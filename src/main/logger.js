'use strict';

/**
 * logger.js —— 极简运行日志
 *
 * 为什么需要它：程序此前**一点日志都不落盘**。用户报「弹了接口变更横幅」「解析失败」时，
 * 界面上只有一句概括，事后无从查证到底是哪个环节、什么错误——只能靠反复猜测。
 * 现在把关键事件（启动信息、体检结论与失败明细、任务级错误）追加写入
 * `<程序同级目录>\logs\app.log`（便携版就跟着 exe 走，不再塞进 %APPDATA%）；
 * 出问题时用户把这个文件发回来即可定位。
 *
 * 设计原则（都很重要）：
 *   - **绝不抛异常**：日志自身出错绝不能影响下载主流程，全部 try/catch 吞掉。
 *   - **必须带构建标记**：启动时写一行 build 信息，用来分辨用户到底跑的是哪个包
 *     （历史上多个包共用 v1.1.0，导致「改了但用户没生效」排查起来极费劲）。
 *   - **有上限**：超过 1MB 就砍掉前半，只留最近的（避免长期使用无限增长）。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // 1MB

let LOG_FILE = '';

/**
 * 指定日志基准目录，日志落在 <baseDir>/logs/app.log。
 * baseDir 由 main.js 的 resolveLogBaseDir() 决定：默认是程序同级目录，
 * 只有那儿不可写才回退 userData。
 */
function init(baseDir) {
  try {
    LOG_FILE = path.join(baseDir, 'logs', 'app.log');
  } catch (_) {
    LOG_FILE = '';
  }
  return LOG_FILE;
}

function getLogFile() {
  return LOG_FILE;
}

/** 本地时间戳（带毫秒），例如 2026-10-12 20:31:07.412 */
function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  );
}

/** 超大就截断：保留后半段（最近的才有价值） */
function rotate() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= MAX_BYTES) return;
    const buf = fs.readFileSync(LOG_FILE);
    // 从中间切，开头可能截到半个多字节字符 → 丢掉第一行残片
    const tail = buf.slice(-Math.floor(MAX_BYTES / 2)).toString('utf8').replace(/^[^\n]*\n/, '');
    fs.writeFileSync(LOG_FILE, '[日志已达上限，前段已截断]\n' + tail, 'utf8');
  } catch (_) {
    /* 轮转失败无所谓 */
  }
}

/**
 * 追加一行日志。任何异常都吞掉 —— 日志不能成为新的故障源。
 * @param {string} tag 分类，如 health / task / app
 * @param {string} msg 内容（内部换行会被压成空格，保证一行一条）
 */
function log(tag, msg) {
  if (!LOG_FILE) return;
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotate();
    const one = String(msg == null ? '' : msg).replace(/\r?\n/g, ' ');
    fs.appendFileSync(LOG_FILE, `[${stamp()}] [${tag}] ${one}\n`, 'utf8');
  } catch (_) {
    /* ignore */
  }
}

module.exports = { init, log, getLogFile, MAX_BYTES };
