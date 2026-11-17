import { describe, expect, it } from 'vitest';
import { TempoEngine } from '../src/engine';
import type { Feel } from '../src/tracker';
const RATE = 44100;
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
type Drum = 'kick' | 'snare' | 'hat';
// 드럼만 따로 그린다
function drums(hits: { time: number; drum: Drum; amp: number }[], out: Float32Array, rand: () => number) {
  for (const h of hits) {
    const start = Math.round(h.time * RATE); const len = Math.round((h.drum === 'kick' ? 0.18 : h.drum === 'snare' ? 0.12 : 0.03) * RATE); let prev = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / RATE; let v: number;
      if (h.drum === 'kick') v = 0.8 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 40)) * t) * Math.exp(-t * 22);
      else if (h.drum === 'snare') v = (0.5 * (rand() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 30);
      else { const n = rand() * 2 - 1; v = 0.12 * (n - prev) * Math.exp(-t * 120); prev = n; }
      out[start + i] += v * h.amp;
    }
  }
}
const rms = (a: Float32Array) => { let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / a.length); };
const NOTES = [41.2, 49, 55, 36.7]; // E1 G1 A1 D1 (한 마디씩)
/** 다른 악기들: 박에 맞춰 치는 것과 엇박·지속음이 섞여 있다 */
function band(bpm: number, seconds: number, parts: string[], seed = 5, guitarOff = false, swing = false): Float32Array {
  const sw = (x: number) => (swing && x % 1 === 0.5 ? Math.floor(x) + 2 / 3 : x);
  const rand = rng(seed); const out = new Float32Array(Math.ceil(seconds * RATE)); const beat = 60 / bpm;
  const add = (start: number, dur: number, f: (t: number, i: number) => number) => {
    const s0 = Math.round(start * RATE); const n = Math.round(dur * RATE);
    for (let i = 0; i < n && s0 + i < out.length; i++) if (s0 + i >= 0) out[s0 + i] += f(i / RATE, i);
  };
  for (let b = 0; 0.3 + b * beat < seconds; b++) {
    const t0 = 0.3 + b * beat; const root = NOTES[Math.floor(b / 4) % 4];
    if (parts.includes('bass')) {
      // 베이스: 8분음표, 가끔 엇박 싱코페이션, 줄 뜯는 소리 + 배음
      for (const [off, len] of b % 4 === 3 ? [[0, 0.45], [0.75, 0.25]] : [[0, 0.45], [0.5, 0.45]]) {
        const f = root * 2 * (rand() < 0.2 ? 1.5 : 1);
        add(t0 + sw(off) * beat, len * beat, (t) => 0.35 * Math.exp(-t * 4) * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t)) * Math.min(1, t * 400));
      }
    }
    if (parts.includes('guitar')) {
      // 디스토션 기타: 8분음표 다운 피킹 (guitarOff면 엇박 업스트로크만 = 스카/레게)
      for (const off of guitarOff ? [0.5] : [0, 0.5]) {
        const fs = [root * 4, root * 6, root * 8];
        let ph = 0;
        add(t0 + sw(off) * beat, 0.5 * beat * 0.95, (t) => { ph += 1; let v = 0; for (const f of fs) v += Math.tanh(4 * Math.sin(2 * Math.PI * f * t + ph * 1e-7)); return 0.12 * v * Math.exp(-t * 3) * Math.min(1, t * 300); });
      }
    }
    if (parts.includes('keys') && b % 4 === 0) {
      // 건반 패드: 마디 내내 이어지는 화음 (천천히 커진다)
      const fs = [root * 8, root * 10, root * 12, root * 16];
      add(t0, 4 * beat, (t) => { let v = 0; for (const f of fs) v += Math.sin(2 * Math.PI * f * t); return 0.09 * v * Math.min(1, t * 6); });
    }
    if (parts.includes('vocal') && b % 2 === 0 && rand() < 0.8) {
      // 보컬: 박과 상관없이 시작하는 프레이즈, 비브라토
      const f0 = 220 * Math.pow(2, Math.floor(rand() * 8) / 12); const start = t0 + rand() * beat;
      add(start, (1 + rand()) * beat, (t) => { const f = f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t)); return 0.25 * Math.min(1, t * 20) * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t)); });
    }
  }
  return out;
}
function rock(bpm: number, seconds: number) {
  const rand = rng(3); const beat = 60 / bpm; const hits: { time: number; drum: Drum; amp: number }[] = [];
  const j = () => (rand() - 0.5) * 0.016;
  for (let b = 0; 0.3 + b * beat < seconds - 0.3; b++) { const t = 0.3 + b * beat; hits.push({ time: t + j(), drum: b % 2 ? 'snare' : 'kick', amp: 1 }, { time: t + j(), drum: 'hat', amp: 1 }, { time: t + beat / 2 + j(), drum: 'hat', amp: 1 }); }
  return hits;
}
function shuffle(bpm: number, seconds: number) {
  const rand = rng(3); const beat = 60 / bpm; const hits: { time: number; drum: Drum; amp: number }[] = [];
  const j = () => (rand() - 0.5) * 0.016;
  for (let b = 0; 0.3 + b * beat < seconds - 0.3; b++) { const t = 0.3 + b * beat; hits.push({ time: t + j(), drum: b % 2 ? 'snare' : 'kick', amp: 1 }, { time: t + j(), drum: 'hat', amp: 1 }, { time: t + beat * 2 / 3 + j(), drum: 'hat', amp: 1 }); }
  return hits;
}
function measure(audio: Float32Array, feel?: Feel) {
  const e = new TempoEngine(RATE); if (feel) e.setFeel(feel); const got: number[] = []; let n = 0; let next = 6;
  for (let i = 0; i < audio.length; i += 512) { e.push(audio.subarray(i, i + 512)); if (e.time >= next) { n++; next += 0.25; const s = e.state(); if (s.phase === 'locked') got.push(s.bpm!); } }
  got.sort((a, b) => a - b);
  return { locked: got.length / n, med: got[got.length >> 1] ?? NaN, p10: got[Math.floor(got.length * 0.1)] ?? NaN, p90: got[Math.floor(got.length * 0.9)] ?? NaN };
}
/** 드럼 대비 다른 악기 음량(dB)을 맞춰 섞는다 */
function mix(groove: typeof rock, parts: string[], bpm: number, db: number, opts: { offbeat?: boolean } = {}) {
  const SEC = 24;
  const rand = rng(1);
  const d = new Float32Array(Math.ceil(SEC * RATE));
  drums(groove(bpm, SEC), d, rand);
  const o = band(bpm, SEC, parts, 5, opts.offbeat ?? false, groove === shuffle);
  const g = (rms(d) / rms(o)) * Math.pow(10, db / 20);
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] + g * o[i] + (rand() - 0.5) * 0.004;
  return out;
}
const ALL = ['bass', 'guitar', 'keys', 'vocal'];
const expectBpm = (r: ReturnType<typeof measure>, bpm: number, label: string) => {
  expect(Math.abs(r.med / bpm - 1), `${label}: ${r.med.toFixed(1)} (확정 ${(r.locked * 100).toFixed(0)}%)`).toBeLessThan(0.02);
  expect(r.locked, `${label} 확정 비율`).toBeGreaterThan(0.6);
};

describe('합주 (베이스·기타·건반·보컬이 함께 들어올 때)', () => {
  it('리듬을 고르면 다른 악기가 드럼보다 4배(+12dB) 커도 맞게 읽는다', () => {
    for (const bpm of [92, 128]) {
      for (const db of [0, 6, 12]) {
        expectBpm(measure(mix(rock, ALL, bpm, db), 'eighth'), bpm, `록 ${bpm} +${db}dB`);
        expectBpm(measure(mix(shuffle, ALL, bpm, db), 'shuffle'), bpm, `셔플 ${bpm} +${db}dB`);
        expectBpm(measure(mix(rock, ['bass', 'guitar'], bpm, db, { offbeat: true }), 'eighth'), bpm, `엇박 기타 ${bpm} +${db}dB`);
      }
    }
  }, 60000);

  it('자동이어도 다른 악기가 드럼만큼 작으면 맞게 읽는다', () => {
    for (const bpm of [92, 128]) {
      for (const db of [-6, 0]) expectBpm(measure(mix(rock, ALL, bpm, db)), bpm, `록 ${bpm} ${db}dB`);
    }
  }, 60000);
});
