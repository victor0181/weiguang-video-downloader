// 截图前注入：切到「设置」页（用于公众号文章配图）。
// 同 _shot-about.js：点两次防 init() 异步覆盖回首页。
(async () => {
  const apply = () => {
    const nav = document.querySelector('.nav-item[data-tab="settings"]');
    if (nav) nav.click();
  };

  apply();
  await new Promise((r) => setTimeout(r, 1200));
  apply();
  await new Promise((r) => setTimeout(r, 400));

  const active = document.querySelector('.tab-panel.active');
  return 'activePanel=' + (active ? active.id : '(无)');
})();
