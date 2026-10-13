// 截图前注入：切到「关于」页，并回传几个关键文案供核对。
//
// ★ 为什么要点两次：init() 是异步的，它跑完会调 switchTab('home')；
//   只点一次的话可能正好被它覆盖回首页。等一会儿再点一次最稳妥。
//   （注：CSS 动画由主进程的截图链路统一关掉，这里不用管。）
(async () => {
  const apply = () => {
    const nav = document.querySelector('.nav-item[data-tab="about"]');
    if (nav) nav.click();
  };

  apply();
  await new Promise((r) => setTimeout(r, 1200));
  apply();
  await new Promise((r) => setTimeout(r, 400));

  const name = document.querySelector('.tb-name');
  const h2 = document.querySelector('.about-card h2');
  const desc = document.querySelector('.about-desc');
  const active = document.querySelector('.tab-panel.active');
  const ver = document.querySelector('#aboutVer');
  const env = document.querySelector('#aboutEnv');
  return [
    'activePanel=' + (active ? active.id : '(无)'),
    'title=' + document.title,
    'tb-name=' + (name ? name.textContent.trim() : '(未找到)'),
    'about-h2=' + (h2 ? h2.textContent.trim() : '(未找到)'),
    'about-ver=' + (ver ? ver.textContent.trim() : '(未找到)'),
    // 构建时间就印在这一行里 —— 用来确认「跑的是不是新包」
    'about-env=' + (env ? env.textContent.replace(/\s+/g, ' ').trim() : '(未找到)'),
    'about-desc=' + (desc ? desc.textContent.replace(/\s+/g, ' ').trim().slice(0, 46) : '(未找到)'),
    'about-logo-svg=' + !!document.querySelector('.about-logo svg'),
    'tb-logo-svg=' + !!document.querySelector('.tb-logo svg'),
  ].join(' | ');
})();
