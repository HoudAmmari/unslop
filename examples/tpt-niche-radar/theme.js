/* Applies the saved theme before the page paints, so there is no flash of the wrong theme. */
(function () {
  let choice = 'system';
  try {
    choice = localStorage.getItem('radar-theme') || 'system';
  } catch {
    /* storage can be blocked, the system theme is used then */
  }
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeChoice = choice;
})();
