// Runs before the page is drawn, so the dark theme does not flash: the saved choice, otherwise the system setting.
(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let choice = 'auto';
  try { choice = localStorage.getItem('theme') || 'auto'; } catch { /* private mode: follow the system */ }
  const apply = () => { document.documentElement.dataset.theme = choice === 'auto' ? (media.matches ? 'dark' : 'light') : choice; };
  apply();
  media.addEventListener('change', () => { if (choice === 'auto') apply(); });
  window.jumpadsTheme = {
    get: () => choice,
    set(next) { choice = next; try { localStorage.setItem('theme', next); } catch { /* still applied for this page */ } apply(); }
  };
})();
