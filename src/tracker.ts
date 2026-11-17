import type { Onset } from './onset';

/**
 * 타격 시각들에서 빠르기를 찾는다.
 *
 * 최근 타격들 사이의 간격을 모두 모아, 후보 빠르기마다 "한 박 뒤에도 타격이 있는가"를 센다
 * (자기상관). 최근 타격일수록 크게 쳐서 빠르기가 바뀌면 몇 초 안에 따라간다.
 *
 * 한 박·반 박·두 박은 모두 잘 맞기 때문에(2배/절반 문제) 다음으로 고른다.
 * - 센 타격(킥·스네어)끼리의 간격을 더 쳐 준다: 하이햇 8분음표보다 킥·스네어의 4분음표가 이긴다
 * - 똑같이 잘 맞으면 그중 가장 짧은 간격이 한 박이다 (두 박·한 마디가 아니라)
 * - 흔한 빠르기(105 BPM 근처)를 조금 더 쳐 준다
 * - 한번 정한 빠르기 근처를 더 쳐 줘서 2배·절반 사이를 오락가락하지 않는다
 * - 사용자가 ½×·2×를 누르거나 목표 템포를 정하면 그 근처에서만 찾는다 (hint)
 * - 사용자가 리듬(한 박을 어떻게 나눠 치는지)을 고르면, 한 박 안의 모양이 그 리듬과 맞는 간격을 고른다 (feel)
 */

export const MIN_BPM = 30;
export const MAX_BPM = 300;

const WINDOW_SEC = 8;
const MAX_ONSETS = 64;
/** 최근 타격의 무게가 1/e로 줄어드는 시간(초). 짧을수록 빨리 따라가지만 숫자가 흔들린다 */
const RECENCY = 1.5;
const PRIOR_BPM = 105;
const PRIOR_WIDTH = 1.0; // 옥타브
const HINT_WIDTH = 0.3;
const STEP = 1.01;
/** 필인으로 보는 가장 긴 길이(초) */
const FILL_SEC = 4;
/** 이만큼 같은 빠르기로 읽은 뒤부터 필인을 버틴다. 그 전에는 처음에 잘못 잡은 박을 바로 고친다 */
const SETTLED_SEC = 3;

export interface TempoEstimate {
  bpm: number;
  /** 0..1. 한 박 뒤에 짝이 되는 타격이 얼마나 꾸준히 있는지 */
  confidence: number;
}

/** period 근처(±3%)에서 가장 잘 맞는 박 길이 */
function bestNear(match: (period: number) => number, period: number) {
  let out = { period, match: match(period) };
  for (const r of [0.97, 0.98, 0.99, 1.01, 1.02, 1.03]) {
    const m = match(period * r);
    if (m > out.match) out = { period: period * r, match: m };
  }
  return out;
}

interface Timed {
  t: number;
  w: number;
}

/**
 * 리듬: 한 박 안에서 타격이 오는 자리 (0..1). 하이햇·라이드처럼 꾸준히 치는 악기를 기준으로 고른다.
 * 싱코페이션한 킥·스네어도 이 자리 중 하나에 떨어지므로 함께 맞는다.
 */
export const FEELS = {
  quarter: [0],
  eighth: [0, 1 / 2],
  sixteenth: [0, 1 / 4, 1 / 2, 3 / 4],
  shuffle: [0, 2 / 3],
  bounce: [0, 1 / 3, 1 / 2, 5 / 6],
  triplet: [0, 1 / 3, 2 / 3],
} as const;
export type Feel = keyof typeof FEELS;

/** 리듬이 있을 때 비교하는 후보: 지금 찾은 간격의 이 배수들 */
const FEEL_RATIOS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1, 4 / 3, 3 / 2, 2, 3, 4];
/** 리듬 맞추기에 쓰는 최근 길이(초). 길면 빠르기가 조금만 바뀌어도 박 자리가 밀린다 */
const FEEL_WINDOW = 5;

/**
 * 이 박 길이로 나눴을 때 타격들이 리듬의 자리에 얼마나 잘 맞는지 (0..1).
 * - 맞음: 타격들이 그 자리 근처에 떨어지는 정도 (박을 너무 길게 잡으면 자리 밖 타격이 생긴다)
 * - 채움: 박마다 그 자리들에 실제로 타격이 있는 정도 (박을 너무 짧게 잡으면 빈자리가 생긴다)
 * 둘을 곱한다. 박의 시작점(위상)은 가장 잘 맞는 쪽으로 잡는다.
 */
export function feelFit(times: number[], weights: number[], period: number, slots: readonly number[]): number {
  const n = times.length;
  if (n < 3) return 0;
  let minGap = 1;
  for (let i = 0; i < slots.length; i++) {
    const next = i + 1 < slots.length ? slots[i + 1] : slots[0] + 1;
    minGap = Math.min(minGap, next - slots[i]);
  }
  const sigma = Math.min(0.016 + 0.012 * period, 0.22 * minGap * period) / period; // 박 단위
  const phase = times.map((t) => t / period - Math.floor(t / period));
  const near = (p: number, r: number) => {
    let d = 1;
    for (const s of slots) {
      const x = (((p - r - s) % 1) + 1.5) % 1 - 0.5;
      d = Math.min(d, Math.abs(x));
    }
    return Math.exp(-0.5 * (d / sigma) * (d / sigma));
  };
  let total = 0;
  for (const w of weights) total += w;
  let bestR = 0;
  let precision = -1;
  for (let i = 0; i < n; i++) {
    for (const s of slots) {
      const r = (((phase[i] - s) % 1) + 1) % 1;
      let sum = 0;
      for (let j = 0; j < n; j++) sum += weights[j] * near(phase[j], r);
      if (sum > precision) {
        precision = sum;
        bestR = r;
      }
    }
  }
  precision /= total;

  // 처음 타격부터 마지막 타격까지 꽉 찬 박들에서 자리마다 타격이 있었는지
  const tol = 2.5 * sigma * period;
  const from = Math.ceil(times[0] / period - bestR - 1e-6);
  const to = Math.floor(times[n - 1] / period - bestR + 1e-6);
  let slotsSeen = 0;
  let filled = 0;
  let j = 0;
  for (let k = from; k < to; k++) {
    for (const s of slots) {
      const at = (k + bestR + s) * period;
      while (j < n && times[j] < at - tol) j++;
      slotsSeen++;
      if (j < n && Math.abs(times[j] - at) <= tol) filled++;
    }
  }
  const coverage = slotsSeen >= slots.length * 2 ? filled / slotsSeen : 0.5;
  return precision * coverage;
}

const gauss = (x: number, width: number) => Math.exp(-0.5 * (x / width) * (x / width));

export class TempoTracker {
  /** 이 빠르기 근처에서만 찾는다 (사용자가 정한 배수·목표 템포) */
  hint: number | null = null;
  /** 직전에 확정한 빠르기. 근처 후보를 더 쳐 준다 */
  last: number | null = null;
  /** 사용자가 고른 리듬. null이면 자동 */
  feel: Feel | null = null;

  private onsets: Onset[] = [];
  private fasterSince: number | null = null;
  /** 지금 빠르기(last)로 읽기 시작한 시각 */
  private settledAt = Infinity;
  private settledBpm = 0;
  private loudest = 0;

  get size() {
    return this.onsets.length;
  }

  add(onset: Onset) {
    this.onsets.push(onset);
    if (this.onsets.length > MAX_ONSETS) this.onsets.shift();
    this.loudest = Math.max(onset.strength, this.loudest * 0.98);
  }

  clear() {
    this.onsets = [];
    this.last = null;
    this.loudest = 0;
    this.fasterSince = null;
  }

  estimate(now: number): TempoEstimate | null {
    while (this.onsets.length && this.onsets[0].time < now - WINDOW_SEC) this.onsets.shift();
    const n = this.onsets.length;
    if (this.last === null) this.settledAt = Infinity;
    else if (this.settledAt === Infinity || Math.abs(this.last / this.settledBpm - 1) > 0.06) {
      this.settledAt = now;
      this.settledBpm = this.last;
    } else this.settledBpm = this.last;
    if (n < 4) return null;

    const pts: Timed[] = this.onsets.map((o) => ({
      t: o.time,
      w: Math.min(1, Math.max(0.1, o.strength / (this.loudest || 1))),
    }));
    // 타격 쌍. 무게는 두 타격의 세기 × 나중 타격이 얼마나 최근인지
    const gaps: number[] = [];
    const weights: number[] = [];
    let self = 0;
    for (let j = 0; j < n; j++) {
      const recent = Math.exp(-(now - pts[j].t) / RECENCY);
      self += pts[j].w * pts[j].w * recent;
      for (let i = 0; i < j; i++) {
        gaps.push(pts[j].t - pts[i].t);
        weights.push(pts[i].w * pts[j].w * recent);
      }
    }
    if (self <= 0) return null;

    const match = (period: number) => {
      // 사람이 치면 10~20ms는 어긋난다. 긴 간격이라고 더 봐주면 두 박이 한 박보다 잘 맞아 보인다
      const sigma = 0.022 * period + 0.007;
      let sum = 0;
      for (let k = 0; k < gaps.length; k++) {
        const d = gaps[k] - period;
        if (d > 3 * sigma || d < -3 * sigma) continue;
        sum += weights[k] * gauss(d, sigma);
      }
      return sum;
    };

    // 그 간격만큼 앞에 짝이 있을 수 있었던 타격들의 무게. 막 치기 시작했을 때 긴 간격이 불리하지 않게 나눠 준다
    const first = pts[0].t;
    const support = (period: number) => {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (pts[j].t - period < first - 0.05) continue;
        sum += pts[j].w * pts[j].w * Math.exp(-(now - pts[j].t) / RECENCY);
      }
      return sum;
    };
    /** 0..1쯤: 이 간격 뒤에도 같은 세기의 타격이 얼마나 꾸준히 있는지. 아직 알 수 없으면 null */
    const repeat = (period: number) => {
      const sup = support(period);
      return sup < 0.25 * self ? null : match(period) / sup;
    };
    // 한 박이면 두 박이나 네 박(한 마디) 뒤에도 같은 모양이 되풀이된다. 그렇지 않은 간격은 깎는다:
    // 한 박만 보면 싱코페이션한 킥끼리의 간격(3/4박, 1.5박 등)에 속는다
    const comb = (period: number) => {
      const one = repeat(period);
      if (one === null) return 0;
      const two = repeat(period * 2);
      const four = repeat(period * 4);
      const again = two === null && four === null ? 0.8 : Math.max(two ?? 0, four ?? 0);
      return one * (0.35 + 0.65 * Math.min(1, again));
    };

    let best = 0;
    let bestScore = 0;
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm *= STEP) {
      let score = comb(60 / bpm);
      if (this.hint) score *= gauss(Math.log2(bpm / this.hint), HINT_WIDTH);
      else {
        score *= gauss(Math.log2(bpm / PRIOR_BPM), PRIOR_WIDTH);
        if (this.last) score *= 1 + 1.5 * gauss(Math.log2(bpm / this.last), 0.12);
      }
      if (score > bestScore) {
        bestScore = score;
        best = bpm;
      }
    }
    if (!best) return null;

    if (this.feel && !this.hint) {
      // 리듬을 알면 2배·절반뿐 아니라 3/4배·3/2배 같은 엇갈린 간격 중에서도 한 박을 고를 수 있다
      const recentFrom = now - FEEL_WINDOW;
      const times: number[] = [];
      const ws: number[] = [];
      for (const p of pts) {
        if (p.t < recentFrom) continue;
        times.push(p.t);
        ws.push((0.4 + 0.6 * p.w) * Math.exp(-(now - p.t) / 3));
      }
      const slots = FEELS[this.feel];
      let pick = best;
      let pickScore = 0;
      for (const r of FEEL_RATIOS) {
        const bpm = best * r;
        if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
        let score = feelFit(times, ws, 60 / bpm, slots);
        if (this.last) score *= 1 + 0.25 * gauss(Math.log2(bpm / this.last), 0.06);
        if (score > pickScore) {
          pickScore = score;
          pick = bpm;
        }
      }
      if (pickScore > 0.25) best = pick;
    } else if (!this.hint) {
      // 한 박·두 박·한 마디는 똑같이 잘 맞는다. 반으로 줄여도 거의 그대로 맞으면 그쪽이 한 박이다
      // (반 박에 하이햇만 있으면 약한 타격이라 덜 맞는다)
      let faster = false;
      while (best * 2 <= MAX_BPM) {
        const near = this.last !== null && Math.abs(this.last / (best * 2) - 1) < 0.06;
        const peak = bestNear((p) => repeat(p) ?? 0, 30 / best);
        if (peak.match < (near ? 0.6 : 0.65) * (repeat(60 / best) ?? 0)) break;
        // 이미 정한 박이 있으면 필인(잠깐 치는 16분음표)에 두 배로 넘어가지 않는다. 오래 이어질 때만 바꾼다
        if (this.last !== null && Math.abs(this.last / best - 1) < 0.06 && now - this.settledAt > SETTLED_SEC) {
          faster = true;
          this.fasterSince ??= now;
          if (now - this.fasterSince < FILL_SEC) break;
        }
        best = 60 / peak.period;
      }
      if (!faster) this.fasterSince = null;
    }
    const bestMatch = Math.max(match(60 / best), match(120 / best));

    // 1~4박 떨어진 쌍들로 박 길이를 다듬는다 (멀리 떨어진 쌍일수록 정밀하다)
    let period = 60 / best;
    for (let pass = 0; pass < 2; pass++) {
      let num = 0;
      let den = 0;
      for (let k = 0; k < gaps.length; k++) {
        const beats = Math.round(gaps[k] / period);
        if (beats < 1 || beats > 4) continue;
        if (Math.abs(gaps[k] - beats * period) > 0.07 * period) continue;
        num += weights[k] * beats * gaps[k];
        den += weights[k] * beats * beats;
      }
      if (den > 0) period = num / den;
    }
    const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, 60 / period));
    return { bpm, confidence: Math.min(1, bestMatch / self) };
  }
}
