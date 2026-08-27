/**
 * Solvency Video Bench v0 — measured cost per completed clip.
 *
 *   FAL_KEY=... node bench/video/runner.mjs [--only <substr>] [--budget 30]
 *
 * Why this exists: video model pricing is quoted in three incompatible units
 * (per output-second, per opaque "unit", per GPU compute-second) — a buyer
 * cannot price a clip from the sheet. So Solvency measures it: the same five
 * production-shaped prompts through every endpoint at a 5s/16:9 target,
 * recording completion (a playable video URL returned), wall latency, and —
 * merged afterwards from fal's own billing records — the actual dollars.
 *
 * "Completed" is objective, not aesthetic: the endpoint returned a video
 * file. Prompt-adherence and quality grading are out of scope for v0 and
 * stated as such wherever this data is shown.
 *
 * Journals to bench/video/results/<runId>/results.jsonl (append-only,
 * resume-never-rebill: finished endpoint+prompt pairs are skipped on rerun).
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = process.env.FAL_KEY;
if (!KEY) { console.error('FAL_KEY is not set (see ~/.solvency-bench-env)'); process.exit(1); }

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const ONLY = arg('only', null);
const BUDGET_CEILING_USD = Number(arg('budget', 30)); // pessimistic ceiling gate, not a meter

/** The matrix: endpoint + the input that asks each for ~5s of 16:9 video.
 * Duration/resolution parameter names differ per family — each override is
 * from the endpoint's published schema; a rejected input is journaled as an
 * infra error, never guessed around. estCeilingUsd is the pessimistic
 * per-clip ceiling used only for the budget gate. */
const ENDPOINTS = [
  { id: 'bytedance/seedance-2.0/text-to-video', label: 'Seedance 2.0', input: { duration: '5', resolution: '720p', aspect_ratio: '16:9' }, estCeilingUsd: 0.9 },
  { id: 'bytedance/seedance-2.0/fast/text-to-video', label: 'Seedance 2.0 Fast', input: { duration: '5', resolution: '720p', aspect_ratio: '16:9' }, estCeilingUsd: 0.7 },
  { id: 'fal-ai/kling-video/v3/turbo/pro/text-to-video', label: 'Kling V3 Turbo Pro', input: { duration: '5', aspect_ratio: '16:9' }, estCeilingUsd: 0.7 },
  { id: 'fal-ai/kling-video/v3/turbo/standard/text-to-video', label: 'Kling V3 Turbo Std', input: { duration: '5', aspect_ratio: '16:9' }, estCeilingUsd: 0.56 },
  { id: 'minimax/h3/text-to-video', label: 'MiniMax H3', input: { duration: '5', aspect_ratio: '16:9' }, estCeilingUsd: 0.5 },
  { id: 'alibaba/happy-horse/v1.1/text-to-video', label: 'Happy Horse 1.1', input: { duration: 5, aspect_ratio: '16:9', resolution: '720p' }, estCeilingUsd: 0.7 },
  { id: 'alibaba/wan-3.0/text-to-video', label: 'Wan 3.0', input: { duration: '5', aspect_ratio: '16:9' }, estCeilingUsd: 0.5 },
  { id: 'fal-ai/veo3.1/lite', label: 'Veo 3.1 Lite', input: { aspect_ratio: '16:9' }, estCeilingUsd: 0.5 },
  { id: 'lightricks/ltx-2.5/text-to-video/fast', label: 'LTX 2.5 Fast', input: { aspect_ratio: '16:9' }, estCeilingUsd: 0.3 },
  { id: 'fal-ai/pixverse/c1/text-to-video', label: 'PixVerse C1', input: { duration: '5', aspect_ratio: '16:9' }, estCeilingUsd: 0.05 },
];

/** Five production-shaped prompts: product, character action, aerial, urban
 * documentary, slow-motion physics. Held constant across every endpoint. */
const PROMPTS = [
  { id: 'product-orbit', text: 'A slow orbit around a matte-black wireless headphone set on a marble pedestal, studio softbox lighting, shallow depth of field, premium product commercial look.' },
  { id: 'chef-pancake', text: 'A chef in a bright kitchen flips a pancake in a cast-iron pan; the pancake spins and lands cleanly back in the pan; natural morning light.' },
  { id: 'valley-aerial', text: 'Aerial drone shot pushing forward over a fog-covered pine valley at sunrise, god rays through the mist, cinematic color grade.' },
  { id: 'tokyo-rain', text: 'A rainy Tokyo street at night; neon reflections on wet asphalt as a cyclist crosses frame left to right; handheld documentary feel.' },
  { id: 'iced-tea-spill', text: 'A glass of iced tea tips over on a wooden table in slow motion; ice cubes scatter and liquid spreads toward the camera.' },
];

const ceiling = ENDPOINTS.filter((e) => !ONLY || e.id.includes(ONLY))
  .reduce((s, e) => s + e.estCeilingUsd * PROMPTS.length, 0);
console.log(`[estimate] ${PROMPTS.length} prompts x ${ENDPOINTS.filter((e) => !ONLY || e.id.includes(ONLY)).length} endpoints, ceiling $${ceiling.toFixed(2)}; gate $${BUDGET_CEILING_USD}`);
if (ceiling > BUDGET_CEILING_USD) { console.error('ceiling exceeds budget gate — narrow with --only or raise --budget'); process.exit(1); }

const runId = arg('run', `video-v0-${new Date().toISOString().slice(0, 10)}`);
const outDir = join(ROOT, 'bench', 'video', 'results', runId);
mkdirSync(outDir, { recursive: true });
const journalPath = join(outDir, 'results.jsonl');
const done = new Set(existsSync(journalPath)
  ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ok || !r.infra).map((r) => `${r.endpoint}::${r.promptId}`)
  : []);

const headers = { authorization: `Key ${KEY}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(ep, prompt) {
  const t0 = Date.now();
  const submit = await fetch(`https://queue.fal.run/${ep.id}`, {
    method: 'POST', headers,
    body: JSON.stringify({ prompt: prompt.text, ...ep.input }),
  });
  if (!submit.ok) {
    return { ok: false, infra: submit.status === 422, error: `submit HTTP ${submit.status}: ${(await submit.text()).slice(0, 180)}`, ms: Date.now() - t0 };
  }
  const { request_id, status_url, response_url } = await submit.json();
  const statusUrl = status_url ?? `https://queue.fal.run/${ep.id}/requests/${request_id}/status`;
  const resultUrl = response_url ?? `https://queue.fal.run/${ep.id}/requests/${request_id}`;
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) return { ok: false, infra: true, error: 'poll timeout after 15m', requestId: request_id, ms: Date.now() - t0 };
    await sleep(5000);
    const st = await fetch(statusUrl, { headers }).then((r) => r.json()).catch(() => null);
    if (!st) continue;
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.status === 'CANCELLED') {
      return { ok: false, infra: false, error: `status ${st.status}`, requestId: request_id, ms: Date.now() - t0 };
    }
  }
  const result = await fetch(resultUrl, { headers }).then((r) => r.json()).catch((e) => ({ _err: String(e) }));
  const video = result?.video?.url ?? result?.video_url ?? result?.videos?.[0]?.url ?? null;
  const duration = result?.video?.duration ?? result?.duration ?? null;
  return video
    ? { ok: true, videoUrl: video, durationS: duration, requestId: request_id, ms: Date.now() - t0 }
    : { ok: false, infra: true, error: `completed without video: ${JSON.stringify(result).slice(0, 220)}`, requestId: request_id, ms: Date.now() - t0 };
}

const startedAt = new Date().toISOString();
for (const ep of ENDPOINTS) {
  if (ONLY && !ep.id.includes(ONLY)) continue;
  for (const prompt of PROMPTS) {
    const key = `${ep.id}::${prompt.id}`;
    if (done.has(key)) { console.log(`skip (journaled) ${ep.label} ${prompt.id}`); continue; }
    const r = await attempt(ep, prompt);
    appendFileSync(journalPath, JSON.stringify({
      endpoint: ep.id, label: ep.label, promptId: prompt.id, at: new Date().toISOString(), ...r,
    }) + '\n');
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${ep.label.padEnd(20)} ${prompt.id.padEnd(16)} ${(r.ms / 1000).toFixed(0)}s${r.ok ? '' : '  ' + r.error}`);
  }
}
writeFileSync(join(outDir, 'run.json'), JSON.stringify({
  runId, startedAt, finishedAt: new Date().toISOString(),
  prompts: PROMPTS, endpoints: ENDPOINTS.map(({ id, label, input }) => ({ id, label, input })),
  protocol: 'solvency-video-v0: 5 prompts x 1 trial, ~5s 16:9 target, completion = playable video returned; dollars merged from fal billing records per endpoint over the run window',
}, null, 2));
console.log(`run complete -> ${outDir} (merge billed dollars from fal usage records next)`);
