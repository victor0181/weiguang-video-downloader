// 打包版渲染自检：确认 index.html / CSS / JS 在打包目录下都加载成功（不是白屏）。
(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const q = (s) => document.querySelector(s);
  let cssOk = 'unknown';
  try {
    cssOk = document.styleSheets.length > 0 && document.styleSheets[0].cssRules.length > 0;
  } catch (e) {
    cssOk = 'ERR ' + e.message;
  }
  return [
    'url=' + location.href,
    'title=' + document.title,
    'tb-name=' + (q('.tb-name') ? q('.tb-name').textContent.trim() : '(none)'),
    'navItems=' + document.querySelectorAll('.nav-item').length,
    'styleSheets=' + document.styleSheets.length,
    'cssRulesOk=' + cssOk,
    'bodyBg=' + getComputedStyle(document.body).backgroundColor,
    'logo=' + !!q('.tb-logo svg'),
    'appVersion=' + (q('.about-ver') ? q('.about-ver').textContent.trim() : '(n/a)'),
  ].join(' | ');
})();
