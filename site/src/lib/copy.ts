/**
 * Copy-to-clipboard with visible feedback: a pending state the moment the
 * button is pressed, a 1.5 s timeout so a hung clipboard promise can never
 * leave the button stuck on "Copying…", and a plain-language fallback.
 */
export function wireCopy(btn: HTMLButtonElement, url: () => string, idle = 'Copy link'): void {
  let timer = 0;
  btn.addEventListener('click', async () => {
    clearTimeout(timer);
    btn.textContent = 'Copying…';
    btn.setAttribute('aria-busy', 'true');
    const write = navigator.clipboard?.writeText(url()) ?? Promise.reject(new Error('no clipboard'));
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500));
    try { await Promise.race([write, timeout]); btn.textContent = 'Link copied ✓'; }
    catch { btn.textContent = 'Copy failed — use the address bar'; }
    btn.removeAttribute('aria-busy');
    timer = window.setTimeout(() => (btn.textContent = idle), 1600);
  });
}
