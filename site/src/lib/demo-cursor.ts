/**
 * demo-cursor: the shared runtime behind the landing page's product demos
 * (2026-08-28 rebuild: "live demos of the portal working with a mouse moving
 * around clicking on things"). A synthetic cursor glides between elements of
 * a mock console scene, clicks with a ripple, and advances the scene's
 * data-state attribute; every visual response is plain CSS keyed off
 * [data-state]. Transform/opacity only. The loop runs while the scene is on
 * screen (IntersectionObserver) and never starts under reduced motion: the
 * scene jumps straight to its final state instead.
 */

export interface DemoStep {
  /** Selector (within the scene) the cursor travels to. */
  sel: string;
  /** Travel time in ms (default 700). */
  dur?: number;
  /** Pause after arriving, ms (default 350). */
  wait?: number;
  /** Play the click ripple on arrival. */
  click?: boolean;
  /** Set the scene's data-state to this value on arrival (after the click). */
  state?: string;
}

const CURSOR_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M5 3l14 8.5-6.1 1.6L9.5 19 5 3z" fill="#fff" stroke="#101828" stroke-width="1.6" stroke-linejoin="round"/></svg>';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Center of el, in the scene's coordinate space. */
function centerIn(scene: HTMLElement, el: Element): { x: number; y: number } {
  const s = scene.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
}

export function runDemo(scene: HTMLElement, steps: DemoStep[], finalState: string): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scene.dataset.state = finalState;
    return;
  }

  const cursor = document.createElement('div');
  cursor.className = 'demo-cursor';
  cursor.innerHTML = CURSOR_SVG;
  cursor.setAttribute('aria-hidden', 'true');
  scene.appendChild(cursor);

  let playing = false;
  let running = false;

  async function loop() {
    if (running) return;
    running = true;
    while (playing) {
      scene.dataset.state = '';
      cursor.style.transitionDuration = '0ms';
      cursor.style.transform = 'translate(12px, 12px)';
      cursor.style.opacity = '0';
      await delay(500);
      if (!playing) break;
      cursor.style.opacity = '1';
      for (const step of steps) {
        if (!playing) break;
        const el = scene.querySelector(step.sel);
        if (!el) continue;
        const { x, y } = centerIn(scene, el);
        const dur = step.dur ?? 700;
        cursor.style.transitionDuration = `${dur}ms`;
        cursor.style.transform = `translate(${x}px, ${y}px)`;
        await delay(dur + 60);
        if (!playing) break;
        if (step.click) {
          const ripple = document.createElement('span');
          ripple.className = 'demo-ripple';
          ripple.style.transform = `translate(${x}px, ${y}px)`;
          scene.appendChild(ripple);
          cursor.classList.add('down');
          await delay(160);
          cursor.classList.remove('down');
          setTimeout(() => ripple.remove(), 650);
        }
        if (step.state !== undefined) scene.dataset.state = step.state;
        await delay(step.wait ?? 350);
      }
      if (playing) { cursor.style.opacity = '0'; await delay(1600); }
    }
    running = false;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      playing = e.isIntersecting;
      if (playing) loop();
    }
  }, { threshold: 0.3 });
  io.observe(scene);
}
