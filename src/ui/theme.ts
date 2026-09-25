const KEY = 'foam-slicer-theme';

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function initTheme(button: HTMLButtonElement): void {
  const root = document.documentElement;
  const s = stored();
  if (s === 'light' || s === 'dark') root.dataset.theme = s;
  button.addEventListener('click', () => {
    const current =
      root.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable */
    }
  });
}
