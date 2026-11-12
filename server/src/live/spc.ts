import { SPC_SUBGROUP, STATIONS, type SpcChart, type SpcPoint, type SpcRule, type StationDef, type Term } from '@lumitwin/shared';

// X̄-R 관리도 상수 (부분군 n = 5)
const D2 = 2.326; // R의 기댓값 = d2·σ
const D2_UPPER = 4.918; // R 관리상한 = D2·σ (표준값이 주어진 경우)
/** 관리도에 남기는 부분군 수 (서버 재시작 때 이만큼 기록을 다시 흘려 복원한다) */
export const SPC_KEEP_POINTS = 80;
/** 같은 특성에서 알람을 다시 내기 전 쉬는 부분군 수 */
const ALARM_COOLDOWN = 12;
/** 알람을 내는 규칙. R3·R4는 화면 표시만 한다 (특성이 많아 모든 규칙으로 알람을 내면 오경보가 많다) */
const ALARM_RULES: SpcRule[] = ['R1', 'R2'];
/** R2 연속 길이 (Nelson 규칙 2: 9점) */
const RUN_LEN = 9;

type Station = StationDef & { line: string };

/** 부품 속성 정의 (모든 설비에서 모은다) */
const ATTRS = new Map(Object.values(STATIONS).flatMap((s) => (s.attrs ?? []).map((a) => [a.key, a] as const)));

/**
 * 참조 신호 z점수의 정상 분산. 시뮬레이터는 z = (값 − 기준)/sd 로 쓰는데,
 * 값 자체가 다른 신호에 끌려가면(terms) 실제 분산은 sd²보다 커진다. 그만큼을 더해 준다.
 */
function zVar(ref: string, here: Station, depth = 0): number {
  if (depth > 4) return 1;
  const [kind, name] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  if (kind === 'tag') {
    let st: Station | undefined = here;
    let key = name;
    if (name.includes('.')) {
      const [code, k] = name.split('.', 2);
      st = STATIONS[code];
      key = k;
    }
    const td = st?.tags.find((t) => t.key === key);
    if (!td || !st || !td.sd) return 1;
    if (td.mode === 'cycle' || !td.terms?.length) return 1;
    return (td.sd ** 2 + termsVar(td.terms, st, depth + 1)) / td.sd ** 2;
  }
  if (kind === 'attr') {
    const ad = ATTRS.get(name);
    if (!ad || !ad.sd) return 1;
    const owner = Object.values(STATIONS).find((s) => s.attrs?.some((a) => a.key === name)) ?? here;
    return (ad.sd ** 2 + termsVar(ad.terms, owner, depth + 1)) / ad.sd ** 2;
  }
  return 1;
}

function termsVar(terms: Term[] | undefined, st: Station, depth: number): number {
  return (terms ?? []).reduce((s, t) => s + t.coef ** 2 * zVar(t.ref, st, depth), 0);
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** 한 설비의 한 특성에 대한 X̄-R 관리도 */
export class SpcSeries {
  readonly chart: SpcChart;
  private buf: number[] = [];
  private sinceAlarm = Infinity;

  constructor(chart: Omit<SpcChart, 'points' | 'cpk'>) {
    this.chart = { ...chart, points: [], cpk: null };
  }

  /** 값 하나를 넣는다. 부분군이 차면 점을 만들어 돌려준다 */
  add(v: number, t: string): { point: SpcPoint; alarmRule: SpcRule | null } | null {
    if (!Number.isFinite(v)) return null;
    this.buf.push(v);
    if (this.buf.length < this.chart.n) return null;
    const vs = this.buf;
    this.buf = [];
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    const range = Math.max(...vs) - Math.min(...vs);
    const c = this.chart;
    const pts = c.points;
    const flags: SpcRule[] = [];
    if (mean > c.ucl || mean < c.lcl) flags.push('R1');
    const means = [...pts.slice(-(RUN_LEN - 1)).map((p) => p.mean), mean];
    if (means.length === RUN_LEN && (means.every((m) => m > c.cl) || means.every((m) => m < c.cl))) flags.push('R2');
    const six = [...pts.slice(-5).map((p) => p.mean), mean];
    if (six.length === 6) {
      let up = true;
      let down = true;
      for (let i = 1; i < 6; i++) {
        if (!(six[i] > six[i - 1])) up = false;
        if (!(six[i] < six[i - 1])) down = false;
      }
      if (up || down) flags.push('R3');
    }
    if (range > c.rUcl) flags.push('R4');
    const point: SpcPoint = { t, mean: round(mean), range: round(range), flags };
    pts.push(point);
    if (pts.length > SPC_KEEP_POINTS) pts.shift();
    this.updateCpk();
    this.sinceAlarm++;
    let alarmRule: SpcRule | null = null;
    if (c.alarms && this.sinceAlarm > ALARM_COOLDOWN) {
      alarmRule = ALARM_RULES.find((r) => flags.includes(r)) ?? null;
      if (alarmRule) this.sinceAlarm = 0;
    }
    return { point, alarmRule };
  }

  /** 최근 25개 부분군의 공정능력 Cpk = min(USL−μ, μ−LSL) / 3σ (σ = R̄/d2, 군내 변동) */
  private updateCpk(): void {
    const c = this.chart;
    const pts = c.points.slice(-25);
    if ((c.lsl == null && c.usl == null) || pts.length < 5) {
      c.cpk = null;
      return;
    }
    const mu = pts.reduce((a, p) => a + p.mean, 0) / pts.length;
    const sigma = pts.reduce((a, p) => a + p.range, 0) / pts.length / D2;
    if (!(sigma > 0)) {
      c.cpk = null;
      return;
    }
    const sides = [c.usl != null ? (c.usl - mu) / (3 * sigma) : Infinity, c.lsl != null ? (mu - c.lsl) / (3 * sigma) : Infinity];
    c.cpk = round(Math.min(...sides), 2);
  }
}

/** 설비 하나에서 관리도를 그릴 특성들을 만든다 */
export function buildSeries(st: Station): Map<string, SpcSeries> {
  const out = new Map<string, SpcSeries>();
  const n = SPC_SUBGROUP;
  const make = (key: string, name: string, unit: string, source: SpcChart['source'], cl: number, sigma: number, lsl: number | undefined, usl: number | undefined, alarms: boolean) => {
    if (!(sigma > 0)) return;
    const se = sigma / Math.sqrt(n);
    out.set(
      key,
      new SpcSeries({
        station: st.code, key, name, unit, source, n,
        cl: round(cl), sigma: round(sigma), ucl: round(cl + 3 * se), lcl: round(cl - 3 * se),
        rCl: round(D2 * sigma), rUcl: round(D2_UPPER * sigma), lsl, usl, alarms,
      }),
    );
  };
  for (const t of st.tags) {
    if (t.mode === 'cycle') {
      // 공정 파라미터는 관리도만 그린다. 알람은 품질 특성(검사 측정값, CTQ)에만 낸다: 특성마다 알람을 내면 오경보가 쌓인다
      make(t.key, t.name, t.unit, 'cycle', t.nominal, t.sd, t.lsl, t.usl, false);
    } else if (t.sd > 0) {
      // 연속 공정값은 앞뒤 값이 서로 닮아(자기상관) 판정 규칙이 오경보를 많이 낸다. 그래프만 그리고 알람은 규격 경보로 한다
      const sigma = Math.sqrt(t.sd ** 2 + termsVar(t.terms, st, 0));
      make(t.key, t.name, t.unit, 'continuous', t.nominal, sigma, t.lsl, t.usl, false);
    }
  }
  for (const m of st.measures ?? []) {
    const sigma = Math.sqrt(m.sd ** 2 + termsVar(m.terms, st, 0));
    make(m.key, m.name, m.unit, 'measure', m.base, sigma, m.lsl, m.usl, true);
  }
  return out;
}
