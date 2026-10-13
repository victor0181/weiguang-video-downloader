'use strict';

/**
 * aria2.js —— aria2 JSON-RPC 客户端
 * 只依赖 Node 内置 http，无需第三方包。
 */

const http = require('http');

class Aria2 {
  /**
   * @param {number} port   RPC 端口
   * @param {string} secret RPC 密钥
   */
  constructor(port, secret) {
    this.port = port;
    this.secret = secret || '';
    this._id = 0;
  }

  _call(method, params) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 'bd-' + ++this._id,
        method,
        params: this.secret ? [`token:${this.secret}`, ...params] : params,
      });

      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/jsonrpc',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let json;
            try {
              json = JSON.parse(data);
            } catch (e) {
              return reject(new Error('aria2 返回非法 JSON: ' + data.slice(0, 160)));
            }
            if (json.error) return reject(new Error(json.error.message || 'aria2 调用失败'));
            resolve(json.result);
          });
        }
      );

      req.setTimeout(20000, () => req.destroy(new Error('aria2 RPC 超时')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // ---- 基础 ----

  getVersion() {
    return this._call('aria2.getVersion', []);
  }

  getGlobalStat() {
    return this._call('aria2.getGlobalStat', []);
  }

  // ---- 任务控制 ----

  /**
   * 添加下载任务
   * @param {string|string[]} uris 下载地址（可多个，实现多来源加速）
   * @param {object} options aria2 选项
   * @returns {Promise<string>} gid
   */
  addUri(uris, options = {}) {
    const list = Array.isArray(uris) ? uris : [uris];
    return this._call('aria2.addUri', [list, options]);
  }

  tellStatus(gid, keys) {
    return this._call('aria2.tellStatus', keys ? [gid, keys] : [gid]);
  }

  tellActive(keys) {
    return this._call('aria2.tellActive', keys ? [keys] : []);
  }

  tellWaiting(offset = 0, num = 100, keys) {
    return this._call('aria2.tellWaiting', keys ? [offset, num, keys] : [offset, num]);
  }

  tellStopped(offset = 0, num = 100, keys) {
    return this._call('aria2.tellStopped', keys ? [offset, num, keys] : [offset, num]);
  }

  pause(gid) {
    return this._call('aria2.pause', [gid]);
  }

  unpause(gid) {
    return this._call('aria2.unpause', [gid]);
  }

  remove(gid) {
    return this._call('aria2.remove', [gid]);
  }

  forceRemove(gid) {
    return this._call('aria2.forceRemove', [gid]);
  }

  pauseAll() {
    return this._call('aria2.pauseAll', []);
  }

  unpauseAll() {
    return this._call('aria2.unpauseAll', []);
  }

  purgeDownloadResult() {
    return this._call('aria2.purgeDownloadResult', []);
  }

  removeDownloadResult(gid) {
    return this._call('aria2.removeDownloadResult', [gid]);
  }

  changeGlobalOption(options) {
    return this._call('aria2.changeGlobalOption', [options]);
  }
}

const STATUS_KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'downloadSpeed',
  'uploadSpeed',
  'connections',
  'errorCode',
  'errorMessage',
  'files',
  'dir',
];

module.exports = { Aria2, STATUS_KEYS };
