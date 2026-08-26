/**
 * Reference-rig catalog for the local-hardware vs cloud page (site/src/pages/local-hardware.astro).
 *
 * Every entry seeds a RigSpecV1 (site/src/lib/rig-cost.ts) as an EDITABLE DEFAULT, never a fixed
 * quote: selecting a rig prefills the form, and every field stays editable. rig-cost.ts and
 * rig-limits.ts are used as-is here — this module only supplies data and small pure assembly
 * helpers, no engine logic.
 *
 * Honesty rule (matches docs/local-hardware-tier-plan.md's "Honesty invariants" and the
 * 2026-08-26 build brief): a catalog default that claims `assertionOrigin: 'source_verified'`
 * must carry a real sourceUrl + lastVerified — see test/rig-catalog.test.ts. Numbers this research
 * pass could not independently verify (Apple Silicon inference throughput for M5-generation
 * hardware that has not shipped yet as of 2026-08-26; RTX 30/40-series throughput at this exact
 * model+quant; resale residuals; the non-GPU portion of a used-GPU rig's price and power draw) are
 * marked `assertionOrigin: 'solvency_template'` (a modelled/editable default) instead of inventing
 * a citation, exactly as the brief allows for throughput. Component prices and the electricity
 * rate ARE independently sourced and dated 2026-08-26.
 */
import type {
  LocalModelV1,
  RigComponentV1,
  RigPowerV1,
  RigSpecV1,
  RigThroughputV1,
} from './rig-cost.ts';

export type RigCatalogFamily = 'apple_silicon' | 'used_gpu';

export interface ReferenceRigCatalogEntry {
  id: string;
  name: string;
  family: RigCatalogFamily;
  /** One-line, non-marketing description of what this rig trades off. */
  summary: string;
  components: RigComponentV1[];
  resale: RigSpecV1['resale'];
  power: RigPowerV1;
  throughput: RigThroughputV1;
  model: LocalModelV1;
  defaultHorizonMonths: number;
}

/**
 * U.S. average residential electricity price. EIA publishes this monthly; the page most recently
 * available as of verification reported May 2026 data. Editable: a visitor's real rate varies by
 * state and utility.
 */
export const ELECTRICITY_DEFAULT: RigSpecV1['electricity'] = {
  usdPerKwh: 0.1844,
  region: 'US average (EIA, May 2026 data)',
  assertionOrigin: 'source_verified',
  sourceUrl: 'https://www.eia.gov/electricity/monthly/update/end-use.php',
  lastVerified: '2026-08-26',
};

export const DEFAULT_WORKLOAD: RigSpecV1['workload'] = {
  tasksPerMonth: 500,
  tokensPerAttempt: 8000,
  overheadSecondsPerAttempt: 30,
};

export const DEFAULT_HORIZON_MONTHS = 36;

/** Same reference model across every catalog entry: an unquantified pass rate is a structural gap
 * (docs/local-hardware-tier-plan.md), not something Solvency invents. Every catalog entry ships
 * with `model.passRate` unset — the quote stays valid but cost-per-solved-task renders as Missing
 * until the visitor supplies a real pass rate for their own model + quant + benchmark. */
const REFERENCE_MODEL: LocalModelV1 = {
  modelName: 'Llama-3-8B-Instruct',
  quantization: 'Q4_K_M',
};

const LLAMA_CPP_APPLE_SILICON_THREAD = 'https://github.com/ggml-org/llama.cpp/discussions/4167';
const NVIDIA_RTX_4090_SPEC = 'https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4090/';
const NVIDIA_RTX_3090_SPEC = 'https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3090-3090ti/';

export const RIG_CATALOG: ReferenceRigCatalogEntry[] = [
  {
    id: 'mac-mini-m5-pro',
    name: 'Mac mini, M5 Pro (24GB)',
    family: 'apple_silicon',
    summary: 'Apple’s current entry Pro-chip desktop: smallest footprint and lowest draw of these four, at the base memory tier.',
    components: [{
      componentId: 'mac-mini-m5-pro-unit',
      label: 'Mac mini, M5 Pro chip, 15-core CPU/16-core GPU, 24GB unified memory, 512GB SSD',
      condition: 'new',
      priceUsd: 1699,
      assertionOrigin: 'source_verified',
      sourceUrl: 'https://www.macrumors.com/roundup/mac-mini/',
      lastVerified: '2026-08-26',
    }],
    resale: { residualUsd: 600, assertionOrigin: 'solvency_template' },
    power: { systemWatts: 55, method: 'nameplate_tdp', assertionOrigin: 'solvency_template' },
    throughput: {
      tokensPerSecond: 55,
      runtime: 'llama.cpp',
      runtimeVersion: null,
      contextTokens: 8192,
      method: 'self_reported',
      assertionOrigin: 'solvency_template',
      sourceUrl: LLAMA_CPP_APPLE_SILICON_THREAD,
      lastVerified: '2026-08-26',
    },
    model: { ...REFERENCE_MODEL },
    defaultHorizonMonths: DEFAULT_HORIZON_MONTHS,
  },
  {
    id: 'mac-studio-m5-max',
    name: 'Mac Studio, M5 Max (36GB)',
    family: 'apple_silicon',
    summary: 'Apple’s current mid-tier Studio: more GPU cores and memory bandwidth than the mini, still no discrete GPU to isolate.',
    components: [{
      componentId: 'mac-studio-m5-max-unit',
      label: 'Mac Studio, M5 Max chip, 18-core CPU/32-core GPU, 36GB unified memory, 512GB SSD',
      condition: 'new',
      priceUsd: 2499,
      assertionOrigin: 'source_verified',
      sourceUrl: 'https://www.macrumors.com/roundup/mac-studio/',
      lastVerified: '2026-08-26',
    }],
    resale: { residualUsd: 900, assertionOrigin: 'solvency_template' },
    power: { systemWatts: 140, method: 'nameplate_tdp', assertionOrigin: 'solvency_template' },
    throughput: {
      tokensPerSecond: 90,
      runtime: 'llama.cpp',
      runtimeVersion: null,
      contextTokens: 8192,
      method: 'self_reported',
      assertionOrigin: 'solvency_template',
      sourceUrl: LLAMA_CPP_APPLE_SILICON_THREAD,
      lastVerified: '2026-08-26',
    },
    model: { ...REFERENCE_MODEL },
    defaultHorizonMonths: DEFAULT_HORIZON_MONTHS,
  },
  {
    id: 'used-rtx-4090',
    name: 'Used RTX 4090 rig (24GB VRAM)',
    family: 'used_gpu',
    summary: 'A used flagship consumer GPU plus a modelled budget host system — the fastest, most power-hungry reference rig.',
    components: [
      {
        componentId: 'rtx-4090-used',
        label: 'RTX 4090 24GB (used)',
        condition: 'used',
        priceUsd: 2500,
        assertionOrigin: 'source_verified',
        sourceUrl: 'https://resaleprices.com/gpu/nvidia-rtx-4090',
        lastVerified: '2026-08-26',
      },
      {
        componentId: 'rtx-4090-host',
        label: 'Host system (CPU, RAM, case, PSU, storage)',
        condition: 'used',
        priceUsd: 800,
        assertionOrigin: 'solvency_template',
      },
    ],
    resale: { residualUsd: 1000, assertionOrigin: 'solvency_template' },
    power: {
      systemWatts: 600,
      method: 'nameplate_tdp',
      assertionOrigin: 'solvency_template',
      sourceUrl: NVIDIA_RTX_4090_SPEC,
      lastVerified: '2026-08-26',
    },
    throughput: {
      tokensPerSecond: 100,
      runtime: 'llama.cpp',
      runtimeVersion: null,
      contextTokens: 8192,
      method: 'self_reported',
      assertionOrigin: 'solvency_template',
    },
    model: { ...REFERENCE_MODEL },
    defaultHorizonMonths: DEFAULT_HORIZON_MONTHS,
  },
  {
    id: 'used-rtx-3090',
    name: 'Used RTX 3090 rig (24GB VRAM)',
    family: 'used_gpu',
    summary: 'The value used-GPU pick: same 24GB VRAM class as the 4090 at roughly 40% of the used price.',
    components: [
      {
        componentId: 'rtx-3090-used',
        label: 'RTX 3090 24GB (used)',
        condition: 'used',
        priceUsd: 1000,
        assertionOrigin: 'source_verified',
        sourceUrl: 'https://gpudojo.com/rtx-3090',
        lastVerified: '2026-08-26',
      },
      {
        componentId: 'rtx-3090-host',
        label: 'Host system (CPU, RAM, case, PSU, storage)',
        condition: 'used',
        priceUsd: 700,
        assertionOrigin: 'solvency_template',
      },
    ],
    resale: { residualUsd: 650, assertionOrigin: 'solvency_template' },
    power: {
      systemWatts: 500,
      method: 'nameplate_tdp',
      assertionOrigin: 'solvency_template',
      sourceUrl: NVIDIA_RTX_3090_SPEC,
      lastVerified: '2026-08-26',
    },
    throughput: {
      tokensPerSecond: 75,
      runtime: 'llama.cpp',
      runtimeVersion: null,
      contextTokens: 8192,
      method: 'self_reported',
      assertionOrigin: 'solvency_template',
    },
    model: { ...REFERENCE_MODEL },
    defaultHorizonMonths: DEFAULT_HORIZON_MONTHS,
  },
];

export function referenceRigById(id: string): ReferenceRigCatalogEntry | undefined {
  return RIG_CATALOG.find((entry) => entry.id === id);
}

/**
 * Assembles a full RigSpecV1 from a catalog entry plus the parts of the spec the visitor supplies
 * or edits: name, workload, horizon, electricity rate and (optionally) a pass rate. Every other
 * field is deep-copied from the catalog entry so callers can hand the result straight to a form
 * without ever mutating catalog data. Component/power/throughput edits happen by patching the
 * returned object directly (or passing pre-patched arrays in `componentsOverride` etc.) — this
 * function's job is only to give a clean, independent starting RigSpecV1.
 */
export function catalogEntryToRigSpec(
  entry: ReferenceRigCatalogEntry,
  opts: {
    name?: string;
    workload?: RigSpecV1['workload'];
    horizonMonths?: number;
    electricity?: RigSpecV1['electricity'];
    passRate?: NonNullable<LocalModelV1['passRate']>;
    componentsOverride?: RigComponentV1[];
    resaleOverride?: RigSpecV1['resale'];
    powerOverride?: RigPowerV1;
    throughputOverride?: RigThroughputV1;
  } = {},
): RigSpecV1 {
  return {
    schemaVersion: 1,
    name: opts.name ?? entry.name,
    components: opts.componentsOverride ?? entry.components.map((c) => ({ ...c })),
    resale: opts.resaleOverride ?? { ...entry.resale },
    horizonMonths: opts.horizonMonths ?? entry.defaultHorizonMonths,
    power: opts.powerOverride ?? { ...entry.power },
    electricity: opts.electricity ?? { ...ELECTRICITY_DEFAULT },
    throughput: opts.throughputOverride ?? { ...entry.throughput },
    model: {
      ...entry.model,
      passRate: opts.passRate ?? entry.model.passRate,
    },
    workload: opts.workload ?? { ...DEFAULT_WORKLOAD },
  };
}
