// 截图前的注入脚本：走一遍真实的抖音解析流程，然后把关键状态回传主进程。
// 用法（bat 里）：set BD_SHOT_JS=@tools\_shot-douyin.js
(async () => {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];

  $('#parseInput').value = window.__DY_URL || 'https://www.douyin.com/video/7686384944582593846';
  $('#btnParse').click();

  // 等解析完成（抖音要冷启动隐藏浏览器窗口，给足时间）
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (!$('#mediaBox').classList.contains('hidden')) break;
    if ($('#parseStatus').classList.contains('err')) break;
  }
  await sleep(1500);

  out.push('status=' + ($('#parseStatus').textContent || '(空)'));
  out.push('statusCls=' + $('#parseStatus').className);
  out.push('mediaType=' + $('#mediaType').textContent);
  out.push('mediaUp=' + $('#mediaUp').textContent);
  out.push('mediaStat=' + $('#mediaStat').textContent);
  out.push('videoChips=' + $('#videoChips').children.length);
  out.push('activeChip=' + (($('#videoChips .chip.active') || {}).textContent || '').replace(/\s+/g, ' ').trim());
  out.push('audioRowHidden=' + $('#audioRow').classList.contains('hidden'));
  out.push('audioChips=' + $('#audioChips').children.length);
  out.push('partsBoxHidden=' + $('#partsBox').classList.contains('hidden'));
  out.push('coverSrc=' + ($('#mediaCover').getAttribute('src') || '').slice(0, 60));
  out.push('dlCount=' + $('#dlCount').textContent);
  out.push('btnDownloadDisabled=' + $('#btnDownload').disabled);
  out.push('tip=' + ($('#streamTip').textContent || '').slice(0, 60));

  return out.join(' || ');
})();
