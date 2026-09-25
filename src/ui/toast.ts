const host = () => document.getElementById('toasts')!;

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host().append(el);
  setTimeout(() => el.remove(), ms);
}
