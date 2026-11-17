import { describe, expect, it } from 'vitest';
import { TempoEngine } from '../src/engine';
import type { Feel } from '../src/tracker';
const RATE = 44100;
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
type Drum = 'kick' | 'snare' | 'hat';
interface Hit { time: number; drum: Drum; amp: number }
function render(hits: Hit[], seconds: number): Float32Array {
  const rand = rng(1); const out = new Float32Array(Math.ceil(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = (rand() - 0.5) * 0.004;
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
  return out;
}
// [박 위치, 악기, 세기]
type Ev = [number, Drum, number?];
function play(bar: Ev[], beatsPerBar: number, bpm: number, seconds: number, jitter = 0.008): Hit[] {
  const rand = rng(3); const len = 60 / bpm; const hits: Hit[] = [];
  for (let b = 0; 0.3 + (b + 1) * beatsPerBar * len < seconds; b++)
    for (const [pos, drum, amp] of bar) hits.push({ time: 0.3 + (b * beatsPerBar + pos) * len + (rand() - 0.5) * 2 * jitter, drum, amp: amp ?? 1 });
  return hits.sort((a, b) => a.time - b.time);
}
function measure(hits: Hit[], seconds: number, target?: number, feel?: Feel) {
  const audio = render(hits, seconds); const e = new TempoEngine(RATE); if (target) e.setTarget(target); if (feel) e.setFeel(feel); const got: number[] = []; let n = 0; let next = 6;
  for (let i = 0; i < audio.length; i += 512) { e.push(audio.subarray(i, i + 512)); if (e.time >= next) { n++; next += 0.25; const s = e.state(); if (s.phase === 'locked') got.push(s.bpm!); } }
  got.sort((a, b) => a - b);
  return { locked: got.length / n, med: got[got.length >> 1] ?? NaN, lo: got[0] ?? NaN, hi: got[got.length - 1] ?? NaN };
}
const T = 2 / 3;
const range = (n: number, f: (i: number) => Ev[]) => Array.from({ length: n }, (_, i) => f(i)).flat();
const P: Record<string, { bar: Ev[]; beats: number; tempos: number[]; note?: string }> = {
  '셔플': { beats: 4, tempos: [60, 80, 100, 120, 140, 170, 200], bar: [...range(4, (i) => [[i, 'hat'], [i + T, 'hat']] as Ev[]), [0, 'kick'], [2, 'kick'], [1, 'snare'], [3, 'snare']] },
  '셔플(하이햇 크게)': { beats: 4, tempos: [80, 120, 160], bar: [...range(4, (i) => [[i, 'hat', 3], [i + T, 'hat', 3]] as Ev[]), [0, 'kick'], [2, 'kick'], [1, 'snare'], [3, 'snare']] },
  '하프타임 셔플': { beats: 4, tempos: [80, 95, 110], bar: [...range(4, (i) => [[i, 'hat'], [i + 1 / 3, 'snare', 0.12], [i + T, 'hat']] as Ev[]), [0, 'kick'], [1 + T, 'kick'], [2, 'snare'], [3 + T, 'kick']] },
  '12/8 슬로 블루스': { beats: 4, tempos: [50, 60, 72], bar: [...range(4, (i) => [[i, 'hat'], [i + 1 / 3, 'hat'], [i + T, 'hat']] as Ev[]), [0, 'kick'], [2, 'kick'], [1, 'snare'], [3, 'snare']] },
  '스윙 재즈(라이드)': { beats: 4, tempos: [120, 160, 200, 240], bar: [[0, 'hat', 2.5], [1, 'hat', 3], [1 + T, 'hat', 2], [2, 'hat', 2.5], [3, 'hat', 3], [3 + T, 'hat', 2], [0, 'kick', 0.15], [1, 'kick', 0.15], [2, 'kick', 0.15], [3, 'kick', 0.15]] },
  '바운스(스윙 16분)': { beats: 4, tempos: [75, 88, 100], bar: [...range(4, (i) => [[i, 'hat'], [i + T / 2, 'hat', 0.6], [i + 0.5, 'hat'], [i + 0.5 + T / 2, 'hat', 0.6]] as Ev[]), [0, 'kick'], [1.5 + T / 2, 'kick'], [2.5, 'kick'], [1, 'snare'], [3, 'snare']] },
  '펑크 16비트+고스트': { beats: 4, tempos: [85, 100, 115], bar: [...range(16, (i) => [[i / 4, 'hat']] as Ev[]), [0, 'kick'], [0.75, 'kick'], [2.5, 'kick'], [1, 'snare'], [3, 'snare'], [1.75, 'snare', 0.15], [2.25, 'snare', 0.15], [3.75, 'snare', 0.15]] },
  '포온더플로어': { beats: 4, tempos: [110, 128, 140], bar: [...range(4, (i) => [[i, 'kick'], [i + 0.5, 'hat', 2]] as Ev[]), [1, 'snare'], [3, 'snare']] },
  '하프타임': { beats: 4, tempos: [120, 140, 160], note: '절반도 맞는 답', bar: [...range(8, (i) => [[i / 2, 'hat']] as Ev[]), [0, 'kick'], [2, 'snare'], [2.5, 'kick']] },
  '더블타임(펑크록)': { beats: 4, tempos: [160, 190, 220], bar: [...range(4, (i) => [[i, 'kick'], [i + 0.5, 'snare'], [i, 'hat'], [i + 0.5, 'hat']] as Ev[])] },
  '6/8': { beats: 6, tempos: [180, 240], note: '8분음표 기준. 점4분(÷3)도 맞는 답', bar: [...range(6, (i) => [[i, 'hat']] as Ev[]), [0, 'kick'], [3, 'snare']] },
  '7/8': { beats: 3.5, tempos: [100, 130], bar: [...range(7, (i) => [[i / 2, 'hat']] as Ev[]), [0, 'kick'], [1.5, 'kick'], [2, 'snare']] },
  '5/4': { beats: 5, tempos: [100, 150], bar: [...range(10, (i) => [[i / 2, 'hat']] as Ev[]), [0, 'kick'], [3, 'kick'], [1.5, 'snare'], [4, 'snare']] },
  '보사노바': { beats: 4, tempos: [120, 140], bar: [...range(8, (i) => [[i / 2, 'hat']] as Ev[]), [0, 'kick'], [1.5, 'kick'], [2, 'kick'], [3.5, 'kick'], [0, 'snare', 0.4], [1.5, 'snare', 0.4], [3, 'snare', 0.4]] },
  '원드롭(레게)': { beats: 4, tempos: [70, 85], bar: [...range(4, (i) => [[i, 'hat'], [i + T, 'hat']] as Ev[]), [2, 'kick'], [2, 'snare']] },
  '4분음표만(패드 연습)': { beats: 1, tempos: [50, 70, 100, 140, 180, 220], bar: [[0, 'snare']] },
  '8분음표만': { beats: 1, tempos: [60, 90, 120], note: '두 배도 맞는 답', bar: [[0, 'snare'], [0.5, 'snare']] },
  '록+필인': { beats: 16, tempos: [90, 120, 150], bar: [...range(12, (i) => [[i, i % 2 ? 'snare' : 'kick'], [i, 'hat'], [i + 0.5, 'hat']] as Ev[]), ...range(16, (i) => [[12 + i / 4, 'snare', 0.8]] as Ev[])] },
};
/** 목표 템포 없이도 맞게 읽는 리듬 */
const AUTO = ['셔플', '셔플(하이햇 크게)', '12/8 슬로 블루스', '스윙 재즈(라이드)', '포온더플로어', '더블타임(펑크록)', '4분음표만(패드 연습)'];
/** 싱코페이션이 많아 자동으로는 엉뚱한 배수로 읽을 수 있지만, 목표 템포를 넣으면 맞는 리듬 */
const WITH_TARGET = ['하프타임 셔플', '바운스(스윙 16분)', '펑크 16비트+고스트', '하프타임', '7/8', '5/4', '보사노바'];

describe('여러 리듬', () => {
  for (const name of AUTO) {
    const p = P[name];
    it(`${name}: 자동으로 맞게 읽는다`, () => {
      for (const bpm of p.tempos) {
        const r = measure(play(p.bar, p.beats, bpm, 24), 24);
        expect(r.locked, `${bpm} BPM 확정 비율`).toBeGreaterThan(0.8);
        expect(Math.abs(r.med / bpm - 1), `${bpm} BPM → ${r.med.toFixed(1)}`).toBeLessThan(0.02);
      }
    });
  }
  for (const name of WITH_TARGET) {
    const p = P[name];
    it(`${name}: 목표 템포를 넣으면 맞게 읽는다`, () => {
      for (const bpm of p.tempos) {
        const r = measure(play(p.bar, p.beats, bpm, 24), 24, bpm);
        expect(r.locked, `${bpm} BPM 확정 비율`).toBeGreaterThan(0.5);
        expect(Math.abs(r.med / bpm - 1), `${bpm} BPM → ${r.med.toFixed(1)}`).toBeLessThan(0.02);
      }
    });
  }
  it('록 비트 중간의 16분음표 필인에 두 배로 넘어가지 않는다', () => {
    const p = P['록+필인'];
    for (const bpm of p.tempos) {
      const r = measure(play(p.bar, p.beats, bpm, 24), 24);
      expect(Math.abs(r.med / bpm - 1), `${bpm} BPM → ${r.med.toFixed(1)}`).toBeLessThan(0.02);
    }
  });
});

/** 리듬만 고르면 (목표 템포 없이) 맞게 읽는다. [리듬 이름, 고를 리듬, 기대값 배수] */
const BY_FEEL: [string, Feel, number][] = [
  ['셔플', 'shuffle', 1],
  ['셔플(하이햇 크게)', 'shuffle', 1],
  ['하프타임 셔플', 'shuffle', 1],
  ['12/8 슬로 블루스', 'triplet', 1],
  ['스윙 재즈(라이드)', 'shuffle', 1],
  ['바운스(스윙 16분)', 'bounce', 1],
  ['펑크 16비트+고스트', 'sixteenth', 1],
  ['포온더플로어', 'eighth', 1],
  ['하프타임', 'eighth', 1],
  ['더블타임(펑크록)', 'eighth', 1],
  ['6/8', 'triplet', 1 / 3],
  ['7/8', 'eighth', 1],
  ['5/4', 'eighth', 1],
  ['보사노바', 'eighth', 1],
  ['원드롭(레게)', 'shuffle', 1],
  ['4분음표만(패드 연습)', 'quarter', 1],
  ['8분음표만', 'eighth', 1],
  ['록+필인', 'eighth', 1],
];

describe('리듬을 고르면', () => {
  for (const [name, feel, ratio] of BY_FEEL) {
    const p = P[name];
    it(`${name} (${feel}): 목표 템포 없이 맞게 읽는다`, () => {
      for (const bpm of p.tempos) {
        const want = bpm * ratio;
        const r = measure(play(p.bar, p.beats, bpm, 24), 24, undefined, feel);
        expect(Math.abs(r.med / want - 1), `${bpm} BPM → ${r.med.toFixed(1)} (기대 ${want.toFixed(1)}, 확정 ${(r.locked * 100).toFixed(0)}%)`).toBeLessThan(0.02);
        // 원드롭은 한 마디에 센 타격이 하나뿐이라 확신이 늦게 선다 (자동·목표 템포여도 같다)
        expect(r.locked, `${bpm} BPM 확정 비율`).toBeGreaterThan(name === '원드롭(레게)' ? 0.3 : 0.5);
      }
    });
  }
});
