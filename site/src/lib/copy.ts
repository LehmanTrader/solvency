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
    // Both outcomes fit the button's fixed min-width, so the action row never
    // reflows; the longer instruction rides along as the button's title.
    try { await Promise.race([write, timeout]); btn.textContent = 'Link copied ✓'; btn.removeAttribute('title'); }
    catch { btn.textContent = 'Copy failed ✕'; btn.title = 'Copy the address bar instead.'; }
    btn.removeAttribute('aria-busy');
    timer = window.setTimeout(() => { btn.textContent = idle; btn.removeAttribute('title'); }, 1600);
  });
}
