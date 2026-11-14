import { Injectable } from '@nestjs/common';
import {
  AUTO_RULE_NAMES,
  CHANGE_CATEGORY_NAMES,
  CHANGE_KIND_NAMES,
  CHANGE_SOURCE_NAMES,
  CP_CHAR_NAMES,
  CP_SOURCE_NAMES,
  DEFECT_NAMES,
  DISPOSITION_NAMES,
  FA_STATUS_NAMES,
  FACTORY,
  HEALTH_LEVEL_NAMES,
  HOLD_KIND_NAMES,
  HOLD_RESULT_NAMES,
  HOLD_STATUS_NAMES,
  INSPECTION_NAMES,
  INTERLOCK_NAMES,
  LINES,
  NCR_OUTCOME_NAMES,
  NCR_STATUS_NAMES,
  SPECIAL_NAMES,
  STATIONS,
  WO_SOURCE_NAMES,
  WO_STATUS_NAMES,
  buildControlPlan,
  shiftLabel,
  shiftOf,
  type AssistantRef,
  type ChangeCategory,
  type ControlPlan,
  type ControlPlanRow,
  type HealthLevel,
  type HoldView,
  type InspectionType,
  type InterlockCode,
  type LineCode,
  type NcrStatus,
  type NcrView,
  type ShiftLineReport,
  type StationEnergy,
  type StationHealth,
  type WorkOrderView,
} from '@lumitwin/shared';
import { ExecutionService } from '../execution/execution.service';
import { EnergyService } from '../insights/energy.service';
import { HealthService } from '../insights/health.service';
import { ReportsService } from '../insights/reports.service';
import { LiveService } from '../live/live.service';
import { QualitySystemService } from '../quality-system/quality-system.service';
import {
  LINE_PROP,
  STATE_NAMES,
  STATION_PROP,
  fail,
  kst,
  lineArg,
  minutesSince,
  oneOf,
  pageRef,
  pct,
  r1,
  r2,
  stationArg,
  stationRef,
  str,
  type Input,
  type ToolOutcome,
} from './assistant.common';

// 실행 MES(P9) 조회 도구: 작업지시·인터록·불량 처리(NCR)·Hold, 4M 변경점·초물·관리계획서, 교대 일보·에너지·예지 보전.
// 모두 조회만 한다. 상태를 바꾸는 일(작업지시 만들기, NCR 판정, Hold 설정·해제, 변경점 승인, 보전 실시)은
// 권한·감사 기록이 걸려 있어 사람이 화면에서 한다. 비서는 어느 화면에서 하는지 안내만 한다.
// 결과는 모델이 읽기 좋게 줄인다: 긴 목록은 상위 몇 개만, 시각은 한국 시각 'MM-DD HH:mm'.

/** 작업지시 대기 순서에서 보여 줄 수 */
const QUEUE_N = 5;
/** NCR 목록에서 보여 줄 수 */
const NCR_N = 10;
/** 관리계획서 행을 보여 줄 수 */
const CP_ROWS_N = 12;
const NCR_FILTERS = ['ACTIVE', 'OPEN', 'WAIT_MRB', 'REPAIRING', 'REINSPECT', 'CLOSED'] as const;
const HOLD_FILTERS = ['ACTIVE', 'RELEASED', 'ALL'] as const;
const HOUR = 3_600_000;
const KST = 9 * HOUR;
/** 에너지 조회 최대 구간 (가상 시간, 서버 한도 31일과 같다) */
const ENERGY_MAX_H = 744;
const LEVEL_ORDER: Record<HealthLevel, number> = { danger: 0, warn: 1, watch: 2, good: 3 };
const MATERIALS = new Map(FACTORY.materials.map((m) => [m.code, m]));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const lineName = (code: string) => LINES.find((l) => l.code === code)?.name ?? code;
const stName = (code: string) => STATIONS[code]?.name ?? null;
const variantNameOf = (line: string, code: string | null) => LINES.find((l) => l.code === line)?.variants.find((v) => v.code === code)?.name ?? null;
/** 긴 글은 잘라서 모델에 준다 */
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const ORDERS_PAGE = pageRef('/orders', '작업지시');
const NCR_PAGE = pageRef('/ncr', '불량 처리');
const TRACE_PAGE = pageRef('/trace', '추적·Hold');
const CHANGES_PAGE = pageRef('/changes', '변경점·초물');
const CP_PAGE = pageRef('/control-plan', '관리계획서');
const REPORTS_PAGE = pageRef('/reports', '교대 일보');
const ENERGY_PAGE = pageRef('/energy', '에너지');
const MAINT_PAGE = pageRef('/maintenance', '설비 보전');

/** 관리계획서는 공장 정의로 만들고 바뀌지 않으므로 한 번만 만든다 */
let cpCache: ControlPlan | null = null;
const controlPlanOf = () => (cpCache ??= buildControlPlan());

// ───────────── 도구 정의 ─────────────

export const MES_TOOL_DEFS = [
  {
    name: 'work_orders',
    description:
      '작업지시(생산 계획) 현황: 라인별 지금 투입 중인 작업지시(기종·수량·투입·양품·폐기·라인 안 재공·예상 끝 시각), 대기 순서(예상 시작·끝, 기종 변경 셋업이 들어가는지), 다음 기종 변경, 최근 끝난 작업지시, ' +
      '라인의 불량 처리 대기·격리 수. 작업지시가 하나도 없으면 투입 공정이 "생산 계획 없음"으로 선다. "작업지시 어디까지 왔어", "다음 기종 변경 언제야"에 쓴다. 라인으로 거를 수 있다.',
    input_schema: { type: 'object', properties: { line: LINE_PROP }, additionalProperties: false },
  },
  {
    name: 'interlock_status',
    description:
      '공정 인터록(게이트 설비가 투입 직전에 MES에 묻는 확인) 현황: 이번 실행의 거부(NG)·대기(WAIT) 사유별 건수(Hold 대상·불량 미처리·재검사 순서·공정 순서·작업지시 불일치·초물 미승인), ' +
      '설비별 통과·거부·대기, 최근 거부 기록(시리얼·사유), MES 응답이 늦어 확인 없이 통과한 수. 라인·설비로 거를 수 있다.',
    input_schema: { type: 'object', properties: { line: LINE_PROP, station: STATION_PROP }, additionalProperties: false },
  },
  {
    name: 'ncr_status',
    description:
      '불량 처리(NCR) 현황: 처리 중인 NCR(MRB 판정 대기 먼저)과 상태별 수, 수리 성공률·평균 수리 시간·폐기·특채 수, 많이 난 불량. ' +
      'code에 NCR 번호(예: NCR-261113-0001)나 시리얼을 주면 그 건의 상세(자동 판정 규칙, 수리·재검사 결과, 같은 시리얼 이력, 불량 처리 기준이 권하는 처리). 판정은 하지 않는다.',
    input_schema: {
      type: 'object',
      properties: {
        line: LINE_PROP,
        status: { type: 'string', enum: [...NCR_FILTERS], description: 'ACTIVE = 종결 전 전부(기본) · WAIT_MRB = 품질 판정 대기 · REPAIRING 수리 중 · REINSPECT 재검사 대기 · CLOSED 종결' },
        code: { type: 'string', description: 'NCR 번호 또는 시리얼' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'hold_status',
    description:
      'Hold(격리) 현황: Hold 목록(자재 LOT·시리얼, 사유, 건 사람, 격리 구역에 걸린 수)과 지금 격리 구역에 있는 투입 묶음(인터록 거부 사유별). ' +
      'code에 Hold 번호(예: HOLD-261113-001)·자재 LOT 번호·시리얼을 주면 그 Hold의 영향 범위(대상 부품 수, 맨 위 제품 상태별 수: 완제품 = 출하 보류·회수 검토, 공정 안 = 다음 게이트에서 격리). Hold 설정·해제는 하지 않는다.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Hold 번호, 자재 LOT 번호 또는 시리얼' },
        status: { type: 'string', enum: [...HOLD_FILTERS], description: '목록 조건 (기본 ACTIVE)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'change_points',
    description:
      '4M 변경점과 초·중·종물: 설비별 초물 대기(어느 변경점 때문에 언제부터, 초물이 불합격해 다시 기다리는지 — 게이트 설비면 그동안 인터록이 초물 말고는 투입을 대기시킨다), ' +
      '최근 변경점(사람·설비·자재·방법, 설비 감지·사람 신고, 초물 결과, 승인 여부), 최근 초·중·종물 검사 결과. "초물 대기 왜 걸렸어"에 쓴다. 설비·라인으로 거를 수 있다.',
    input_schema: { type: 'object', properties: { station: STATION_PROP, line: LINE_PROP }, additionalProperties: false },
  },
  {
    name: 'control_plan',
    description:
      '관리계획서(공장 정의에서 자동 생성, AIAG 양식): 공정·설비별 관리 항목(제품 특성·공정 특성), 특별 특성(◆ 법규·안전, ▲ 핵심 기능), 규격, 평가·측정 방법, 시료 크기·주기, 관리 방법, 이상 시 조치. ' +
      '설비·라인·키워드(특성 이름, "특별 특성")로 거른다. 아무것도 안 주면 라인별 항목 수와 법규·안전 특별 특성만 준다.',
    input_schema: {
      type: 'object',
      properties: { station: STATION_PROP, line: LINE_PROP, query: { type: 'string', description: '특성 이름 일부(예: 광축, 토크, 기밀) 또는 "특별 특성"' } },
      additionalProperties: false,
    },
  },
  {
    name: 'shift_report',
    description:
      '교대 일보(주간 08~20시 · 야간 20~익일 08시, 가상 한국 시각): 라인별 목표·투입·생산 OK·불량·폐기·직행률·OEE, 비가동 사유 상위, 불량 상위, NCR 발생·종결·미결, 4M 변경점·초물 불합격, 초·중·종물, 인터록 거부, ' +
      '전력량·개당 전력, 교대 중 작업지시. 교대는 key(예: 2026-11-13-N), which(current 지금 · previous 직전), 또는 day(today·yesterday: 교대가 시작한 한국 날짜)+shift(D 주간 · N 야간)로 고른다. 아무것도 안 주면 지금 교대. 진행 중 교대는 지금까지 값이다.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '교대 키 YYYY-MM-DD-D|N' },
        which: { type: 'string', enum: ['current', 'previous'] },
        day: { type: 'string', enum: ['today', 'yesterday'] },
        shift: { type: 'string', enum: ['D', 'N'] },
        line: LINE_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'energy_report',
    description:
      '에너지(전력량 kWh, 설비 상태 시간 × 상태별 소비 전력으로 낸 추정값): 가동·대기·정지 몫과 대기 전력 비중, 라인별 완성품 개당 kWh, 전력을 많이 쓴 설비 순위, 대기 전력이 큰 설비, 시간대별 추이. ' +
      '기본은 최근 24시간(가상). current_shift = true면 지금 교대가 시작한 때부터, hours로 최근 몇 시간. 라인으로 거를 수 있다.',
    input_schema: {
      type: 'object',
      properties: {
        line: LINE_PROP,
        current_shift: { type: 'boolean', description: 'true면 지금 교대 시작부터 지금까지' },
        hours: { type: 'integer', minimum: 1, maximum: ENERGY_MAX_H, description: '지금부터 거슬러 몇 시간(가상)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'equipment_health',
    description:
      '예지 보전(상태 감시): 진동·전류·온도를 보내는 설비의 진동 등급(ISO 10816 구역: 양호·관찰·경고 = 보전 계획·위험 = 즉시 보전), 건강 지수, 정상 대비 전류·온도, ' +
      '남은 수명 추정(경고·위험 경계까지 가상 시간, 진동 추세 직선 외삽), 마지막 보전. "이 설비 진동 괜찮아?"에 쓴다. 설비 하나나 라인으로 거를 수 있다. 고장 이력·MTBF·계획 보전 주기는 maintenance 도구.',
    input_schema: { type: 'object', properties: { station: STATION_PROP, line: LINE_PROP }, additionalProperties: false },
  },
];

const MES_TOOL_NAMES = new Set(MES_TOOL_DEFS.map((t) => t.name));

/** 화면에 보일 도구 호출 이름. 이 파일의 도구가 아니면 null */
export function mesToolLabel(name: string, input: Input): string | null {
  const arg = (k: string) => (typeof input[k] === 'string' ? ` · ${input[k] as string}` : '');
  switch (name) {
    case 'work_orders': return `작업지시 현황 조회${arg('line')}`;
    case 'interlock_status': return `인터록 현황 조회${arg('station')}${arg('line')}`;
    case 'ncr_status': return `불량 처리(NCR) 조회${arg('code')}${arg('status')}${arg('line')}`;
    case 'hold_status': return `Hold 조회${arg('code')}${arg('status')}`;
    case 'change_points': return `변경점·초물 조회${arg('station')}${arg('line')}`;
    case 'control_plan': return `관리계획서 조회${arg('station')}${arg('line')}${arg('query')}`;
    case 'shift_report': return `교대 일보 조회${arg('key')}${arg('which')}${arg('day')}${arg('shift')}${arg('line')}`;
    case 'energy_report': return `에너지 조회${arg('line')}${input.current_shift === true ? ' · 이번 교대' : ''}${typeof input.hours === 'number' ? ` · ${input.hours}시간` : ''}`;
    case 'equipment_health': return `예지 보전 조회${arg('station')}${arg('line')}`;
    default: return null;
  }
}

const failFor = (a: { error: string; candidates?: string[] }) => fail(a.error, a.candidates ? { candidates: a.candidates } : undefined);

/** 실행 MES·품질 체계·분석 조회 도구 실행기 (AssistantTools가 이름으로 넘겨준다) */
@Injectable()
export class MesTools {
  constructor(
    private readonly live: LiveService,
    private readonly exec: ExecutionService,
    private readonly quality: QualitySystemService,
    private readonly reports: ReportsService,
    private readonly energy: EnergyService,
    private readonly health: HealthService,
  ) {}

  static has(name: string): boolean {
    return MES_TOOL_NAMES.has(name);
  }

  async run(name: string, input: Input): Promise<ToolOutcome> {
    switch (name) {
      case 'work_orders': return this.workOrders(input);
      case 'interlock_status': return await this.interlock(input);
      case 'ncr_status': return this.ncr(input);
      case 'hold_status': return await this.holds(input);
      case 'change_points': return await this.changes(input);
      case 'control_plan': return this.controlPlan(input);
      case 'shift_report': return await this.shiftReport(input);
      case 'energy_report': return await this.energyReport(input);
      case 'equipment_health': return this.equipmentHealth(input);
      default: return fail(`알 수 없는 도구 ${name}`);
    }
  }

  private now(): number {
    return Date.parse(this.live.virtualNow ?? '') || Date.now();
  }

  // ───────────── 작업지시 ─────────────

  workOrders(input: Input): ToolOutcome {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const sum = this.exec.summary();
    const orders = this.exec.orders(line.v);
    const nowMs = this.now();
    const brief = (w: WorkOrderView) => ({
      code: w.code, variant: w.variant, variantName: variantNameOf(w.line, w.variant), status: WO_STATUS_NAMES[w.status],
      qty: w.qty, released: w.released, good: w.doneQty, scrap: w.scrapQty, wip: w.wip,
      donePct: w.qty ? pct(w.doneQty / w.qty) : 0, leftToRelease: Math.max(0, w.qty - w.released), releasing: w.releasing,
      started: kst(w.startedAt), expectedEnd: kst(w.plan?.end), source: WO_SOURCE_NAMES[w.source], note: w.note,
    });
    const lines = sum.lines
      .filter((l) => !line.v || l.line === line.v)
      .map((l) => {
        const mine = orders.filter((o) => o.line === l.line);
        const planned = mine.filter((o) => o.status === 'PLANNED').sort((a, b) => a.seq - b.seq);
        const past = mine.filter((o) => o.status === 'DONE' || o.status === 'CANCELLED').slice(0, 3);
        const cur = l.current;
        // 대기 순서마다 앞 작업지시의 기종을 이어 보며 기종 변경(셋업)을 찾는다
        let prev = cur?.variant ?? null;
        const queue = planned.map((w) => {
          const from = prev;
          prev = w.variant;
          return {
            code: w.code, variant: w.variant, qty: w.qty, start: kst(w.plan?.start), end: kst(w.plan?.end), source: WO_SOURCE_NAMES[w.source],
            changeover: w.plan?.changeover ? { from, to: w.variant, setupMin: w.plan.setupMin } : null,
            startsInMin: w.plan ? Math.max(0, Math.round((Date.parse(w.plan.start) - nowMs) / 60_000)) : null,
          };
        });
        const nextChange = queue.find((q) => q.changeover);
        const state = cur
          ? cur.releasing
            ? '투입 중'
            : '투입 끝, 라인 안 재공 마무리 중 (다음 작업지시 요청 대기)'
          : planned.length
            ? '진행 작업지시 없음 (대기 작업지시를 투입 공정이 요청하기 전)'
            : '작업지시 없음 — 투입 공정이 "생산 계획 없음"으로 정지';
        return {
          line: l.line, name: lineName(l.line), state,
          current: cur ? brief(cur) : null,
          finishingInLine: l.running.filter((w) => w.id !== cur?.id).map((w) => ({ code: w.code, variant: w.variant, wip: w.wip, good: w.doneQty, qty: w.qty })),
          plannedCount: planned.length, queue: queue.slice(0, QUEUE_N),
          nextChangeover: nextChange
            ? { code: nextChange.code, from: nextChange.changeover!.from, to: nextChange.changeover!.to, at: nextChange.start, inMin: nextChange.startsInMin, setupMin: nextChange.changeover!.setupMin }
            : null,
          recentDone: past.map((w) => ({ code: w.code, variant: w.variant, status: WO_STATUS_NAMES[w.status], good: w.doneQty, scrap: w.scrapQty, qty: w.qty, ended: kst(w.endedAt) })),
          ncrOpen: l.ncrOpen, waitMrb: l.waitMrb, repairing: l.repairing, quarantine: l.quarantine,
        };
      });
    const data = {
      virtualTime: kst(sum.t), mesReady: sum.ready, holdsActive: sum.holdsActive, lines,
      note:
        '예상 시각은 택트·병목 사이클로 계산한 계획값(가상 시각)이다. 기종 변경 셋업은 라인 설비 셋업 시간의 합이라 보수적이다. ' +
        'mesReady=false면 서버가 기록을 되살리는 중이라 인터록이 잠깐 대기로 답한다. 작업지시 만들기·순서 바꾸기·수량 고치기·중단은 /orders 에서 조장(작업지시 관리 권한)이 한다.',
    };
    const head = lines.map((l) => `${l.line} ${l.current ? `${l.current.variant} ${l.current.good}/${l.current.qty}` : '진행 없음'}`).join(' · ');
    return {
      ok: true, data,
      summary: `${head} · 대기 ${lines.reduce((a, l) => a + l.plannedCount, 0)}건`,
      refs: [ORDERS_PAGE],
    };
  }

  // ───────────── 인터록 ─────────────

  async interlock(input: Input): Promise<ToolOutcome> {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const st = stationArg(input, false);
    if (!st.ok) return failFor(st);
    if (st.v && !STATIONS[st.v]?.gate) {
      const gates = Object.values(STATIONS).filter((s) => s.gate && s.line === STATIONS[st.v!]?.line).map((s) => `${s.code} ${s.name}`);
      return fail(`${st.v} ${stName(st.v) ?? ''}은(는) 인터록 게이트 설비가 아닙니다`, { gates });
    }
    const r = await this.exec.interlock(line.v, st.v);
    const s = r.stats;
    const byCode = s.byCode.map((c) => ({ code: c.code, name: INTERLOCK_NAMES[c.code], ng: c.ng, wait: c.wait }));
    const rejected = byCode.reduce((a, c) => a + c.ng, 0);
    const waited = byCode.reduce((a, c) => a + c.wait, 0);
    const byStation = s.byStation
      .filter((x) => x.ok || x.ng || x.wait)
      .sort((a, b) => b.ng - a.ng || b.wait - a.wait)
      .slice(0, 8)
      .map((x) => ({ station: x.station, stationName: stName(x.station), passedSinceStart: x.ok, ng: x.ng, wait: x.wait }));
    const view = (x: (typeof r.recent)[number]) => ({ t: kst(x.at), station: x.station, serial: x.serial, code: x.code, name: INTERLOCK_NAMES[x.code], reason: clip(x.reason), comps: x.comps.length });
    const recentRejects = r.recent.filter((x) => x.verdict === 'NG').slice(0, 8).map(view);
    const recentWaits = r.recent.filter((x) => x.verdict === 'WAIT').slice(0, 3).map(view);
    const scope = st.v ? `${st.v} ${stName(st.v) ?? ''}` : line.v ? lineName(line.v) : '공장 전체';
    const data = {
      scope,
      sinceServerStart: { ok: s.live.ok, ng: s.live.ng, wait: s.live.wait, since: kst(s.live.since) },
      rejected, waited, byCode, byStation, recentRejects, recentWaits, skippedNoReply: s.skipped,
      note:
        '거부(NG)된 투입 묶음은 라인 격리 구역으로 가고 개체 상태가 HOLD가 된다(hold_status의 quarantine). 대기(WAIT)는 앞 공정 실적·초물 판정·기동 복원을 기다리는 것이다. ' +
        '통과(OK)는 DB에 남기지 않아 서버가 켜진 뒤 센 값(sinceServerStart)만 있다. skippedNoReply = MES 응답이 3초 안에 오지 않아 확인 없이 통과한 개체. 인터록 현황 화면은 /orders.',
    };
    const top = [...byCode].sort((a, b) => b.ng - a.ng)[0];
    return {
      ok: true, data,
      summary: `거부 ${rejected} · 대기 ${waited}${top?.ng ? ` · 거부 1위 ${top.name} ${top.ng}` : ''}`,
      refs: [...new Set([...(st.v ? [st.v] : []), ...recentRejects.map((x) => x.station)])].slice(0, 4).map(stationRef).concat(ORDERS_PAGE),
    };
  }

  // ───────────── 불량 처리 (NCR) ─────────────

  private ncrBrief(n: NcrView, nowMs: number) {
    return {
      code: n.code, serial: n.serial, item: n.item, line: n.line, station: n.station, stationName: stName(n.station),
      defect: n.defect, defectName: DEFECT_NAMES[n.defect] ?? n.defect, variant: n.variant, workOrder: n.woCode, attempt: n.attempt,
      status: NCR_STATUS_NAMES[n.status], disposition: n.disposition ? DISPOSITION_NAMES[n.disposition] : null, rule: n.rule ? AUTO_RULE_NAMES[n.rule] : null,
      decidedBy: n.decidedBy, opened: kst(n.openedAt), waitingMin: n.status === 'CLOSED' ? null : minutesSince(n.openedAt, nowMs), closed: kst(n.closedAt),
      repairMin: n.repairMin, reinspect: n.reinspect, outcome: n.outcome ? NCR_OUTCOME_NAMES[n.outcome] : null, note: n.note,
    };
  }

  ncr(input: Input): ToolOutcome {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const status = oneOf(input, 'status', NCR_FILTERS);
    if (!status.ok) return fail(status.error);
    const code = str(input, 'code', false);
    if (!code.ok) return fail(code.error);
    const nowMs = this.now();
    if (code.v) return this.ncrOne(code.v.toUpperCase(), nowMs);

    const filter = status.v ?? 'ACTIVE';
    const list = this.exec.ncrList(filter, line.v);
    // MRB 판정 대기를 맨 앞으로 (그 안에서는 서비스 순서 = 최근 것부터)
    const items = [...list.items].sort((a, b) => Number(b.status === 'WAIT_MRB') - Number(a.status === 'WAIT_MRB'));
    const s = list.summary;
    const byStatus = Object.fromEntries((Object.entries(s.byStatus) as [NcrStatus, number][]).filter(([, n]) => n > 0).map(([k, n]) => [NCR_STATUS_NAMES[k], n]));
    const data = {
      scope: line.v ? lineName(line.v) : '공장 전체',
      filter: filter === 'ACTIVE' ? '종결 전 전부' : NCR_STATUS_NAMES[filter as NcrStatus],
      matched: list.items.length, shown: items.slice(0, NCR_N).map((n) => this.ncrBrief(n, nowMs)),
      summary: {
        total: s.total, open: s.open, waitMrb: s.byStatus.WAIT_MRB ?? 0, byStatus,
        repairSuccessPct: s.repairSuccess != null ? pct(s.repairSuccess) : null, repairDone: s.repairDone,
        avgRepairMin: s.avgRepairMin != null ? r1(s.avgRepairMin) : null, scrapped: s.scrapped, uai: s.uai,
        topDefects: s.topDefects.slice(0, 5).map((d) => ({ defect: d.defect, name: DEFECT_NAMES[d.defect] ?? d.defect, n: d.n })),
      },
      note:
        'MRB 판정 대기는 불량 처리 기준에 자동 처리가 없는 불량이라 품질 담당·조장이 /ncr 에서 수리·재작업·폐기·특채를 판정해야 한다(불량 처리 판정 권한, 특채는 근거 메모 필수). ' +
        '수리·재작업은 라인 수리대에서 하고 검출 설비로 돌아가 재검사한다. 재검사에서 다시 불합격하면 자동 폐기. 수리 성공률 = 수리가 끝난 건 중 재검사 합격 비율.',
    };
    return {
      ok: true, data,
      summary: `NCR ${data.filter} ${list.items.length}건 · MRB 대기 ${data.summary.waitMrb} · 처리 중 ${s.open}`,
      refs: [...items.slice(0, 3).map((n): AssistantRef => ({ kind: 'serial', id: n.serial, label: `${n.code} ${n.serial}` })), NCR_PAGE],
    };
  }

  private ncrOne(q: string, nowMs: number): ToolOutcome {
    const all = this.exec.ncrList(undefined, undefined).items;
    const hit = all.find((n) => n.code === q) ?? all.find((n) => n.serial === q);
    if (!hit) return fail(`${q}에 맞는 NCR이 지금 실행에 없습니다 (최근 NCR 안에서 찾았습니다)`);
    const d = this.exec.ncrDetail(hit.id);
    const data = {
      ...this.ncrBrief(d, nowMs),
      otherNcrsOfSerial: d.history.map((h) => ({ code: h.code, station: h.station, defectName: DEFECT_NAMES[h.defect] ?? h.defect, status: NCR_STATUS_NAMES[h.status], outcome: h.outcome ? NCR_OUTCOME_NAMES[h.outcome] : null, opened: kst(h.openedAt) })),
      suggested: {
        action: d.suggested.action === 'MRB' ? 'MRB 판정 (자동 처리 없음)' : DISPOSITION_NAMES[d.suggested.action],
        rule: AUTO_RULE_NAMES[d.suggested.rule], repairMin: d.suggested.minutes, repairSuccessPct: pct(d.suggested.prob),
      },
      note: '판정(수리·재작업·폐기·특채)은 접수·MRB 대기 상태에서만 /ncr 에서 할 수 있다. 시리얼의 공정 이력은 trace_serial.',
    };
    return {
      ok: true, data,
      summary: `${d.code} · ${NCR_STATUS_NAMES[d.status]} · ${d.station} ${DEFECT_NAMES[d.defect] ?? d.defect}`,
      refs: [{ kind: 'serial', id: d.serial, label: d.serial }, stationRef(d.station), NCR_PAGE],
    };
  }

  // ───────────── Hold·격리 ─────────────

  private holdBrief(h: HoldView, nowMs: number) {
    const target =
      h.kind === 'LOT'
        ? `${h.material ?? ''}(${MATERIALS.get(h.material ?? '')?.name ?? '자재'}) LOT ${h.lot ?? ''}`
        : `${h.serials.slice(0, 5).join(', ')}${h.serials.length > 5 ? ` 외 ${h.serials.length - 5}개` : ''}`;
    return {
      code: h.code, kind: HOLD_KIND_NAMES[h.kind], target, reason: h.reason, status: HOLD_STATUS_NAMES[h.status],
      createdBy: h.createdBy, created: kst(h.createdAt), heldMin: h.status === 'ACTIVE' ? minutesSince(h.createdAt, nowMs) : null,
      quarantinedNow: h.quarantined.length,
      released: h.releasedAt ? { by: h.releasedBy, t: kst(h.releasedAt), result: h.result ? HOLD_RESULT_NAMES[h.result] : null, note: h.releaseNote } : null,
    };
  }

  private holdRefs(h: HoldView): AssistantRef[] {
    const refs: AssistantRef[] = h.kind === 'LOT' && h.lot ? [{ kind: 'lot', id: h.lot, label: h.lot }] : h.serials.slice(0, 2).map((s): AssistantRef => ({ kind: 'serial', id: s, label: s }));
    return [...refs, TRACE_PAGE];
  }

  async holds(input: Input): Promise<ToolOutcome> {
    const code = str(input, 'code', false);
    if (!code.ok) return fail(code.error);
    const status = oneOf(input, 'status', HOLD_FILTERS);
    if (!status.ok) return fail(status.error);
    const nowMs = this.now();
    const list = this.exec.holdList();

    if (code.v) {
      const q = code.v.toUpperCase();
      const h =
        list.holds.find((x) => x.code === q) ??
        list.holds.find((x) => x.lot === q && x.status === 'ACTIVE') ??
        list.holds.find((x) => x.lot === q) ??
        list.holds.find((x) => x.serials.includes(q) || x.quarantined.includes(q));
      if (!h) {
        const quar = list.quarantine.find((x) => x.serial === q || x.comps.includes(q));
        if (quar)
          return {
            ok: true,
            data: {
              hold: null,
              quarantine: { serial: quar.serial, comps: quar.comps.length, line: quar.line, station: quar.station, code: quar.code, name: INTERLOCK_NAMES[quar.code], reason: clip(quar.reason), t: kst(quar.at) },
              note: '이 시리얼에 걸린 Hold는 없지만 인터록 거부로 격리 구역에 있다. 풀거나 폐기하려면 /trace Hold 영역에서 시리얼 Hold로 묶은 뒤 해제·폐기한다(품질).',
            },
            summary: `${q} · Hold 없음 · 격리 구역(${INTERLOCK_NAMES[quar.code]})`,
            refs: [{ kind: 'serial', id: quar.serial, label: quar.serial }, TRACE_PAGE],
          };
        return fail(`${q}에 걸린 Hold가 지금 실행에 없습니다`, { hint: 'LOT를 쓴 부품·제품 범위만 보려면 lot_trace, 시리얼 이력은 trace_serial' });
      }
      const d = await this.exec.holdDetail(h.id);
      const im = d.impact;
      const data = {
        ...this.holdBrief(d, nowMs),
        impact: {
          baseParts: im.base,
          topProducts: Object.values(im.byStatus).reduce((a, n) => a + n, 0),
          byStatus: im.byStatus,
          finished: im.finished,
          inProcess: im.inProcess,
          examples: im.tops.slice(0, 8).map((t) => ({ serial: t.serial, item: t.item, line: t.line, status: t.status, defect: t.defect, parts: t.parts, last: kst(t.lastAt) })),
          truncated: im.truncated,
        },
        quarantinedSample: d.quarantined.slice(0, 5),
        note:
          '영향 범위 = 대상(LOT를 쓴 부품 또는 Hold 시리얼)이 조립돼 들어간 맨 위 제품. byStatus: DONE = 완제품·창고(출하 보류·회수 검토, MES 표시만), WIP·REPAIR·NG = 공정 안(다음 게이트 인터록에서 HOLD로 걸려 격리 구역에 모인다), HOLD = 이미 격리, SCRAP = 폐기. ' +
          '해제(다시 흘림)·폐기 판정은 /trace Hold 영역에서 품질·관리자가 메모와 함께 한다.',
      };
      return {
        ok: true, data,
        summary: `${d.code} · ${HOLD_STATUS_NAMES[d.status]} · 영향 제품 ${data.impact.topProducts} (완제품 ${im.finished} · 공정 안 ${im.inProcess})`,
        refs: this.holdRefs(d),
      };
    }

    const want = status.v ?? 'ACTIVE';
    const holds = list.holds.filter((h) => want === 'ALL' || h.status === want);
    const byReason = new Map<InterlockCode, number>();
    const byLine: Partial<Record<LineCode, number>> = {};
    for (const q of list.quarantine) {
      byReason.set(q.code, (byReason.get(q.code) ?? 0) + 1);
      byLine[q.line] = (byLine[q.line] ?? 0) + 1;
    }
    const data = {
      active: list.holds.filter((h) => h.status === 'ACTIVE').length,
      released: list.holds.filter((h) => h.status === 'RELEASED').length,
      filter: want,
      holds: holds.slice(0, 8).map((h) => this.holdBrief(h, nowMs)),
      quarantine: {
        total: list.quarantine.length,
        byReason: [...byReason].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ code: c, name: INTERLOCK_NAMES[c], n })),
        byLine,
        notInHold: list.quarantine.filter((q) => q.holdId == null).length,
        latest: list.quarantine.slice(0, 6).map((q) => ({ serial: q.serial, line: q.line, station: q.station, reason: INTERLOCK_NAMES[q.code], hold: q.holdCode, t: kst(q.at) })),
      },
      note:
        '격리 구역 = 게이트 인터록이 거부한 투입 묶음이 모이는 곳(Hold 대상뿐 아니라 공정 순서·불량 미처리 거부도 있다). Hold가 아닌 사유로 걸린 묶음(notInHold)은 /trace 에서 시리얼 Hold로 묶어 해제·폐기한다. ' +
        'Hold 설정은 /trace 에서 품질·조장(Hold 설정 권한), 해제·폐기는 품질·관리자(Hold 해제 권한)가 한다.',
    };
    return {
      ok: true, data,
      summary: `활성 Hold ${data.active}건 · 격리 묶음 ${list.quarantine.length}`,
      refs: holds.slice(0, 2).flatMap((h) => this.holdRefs(h).filter((r) => r.kind !== 'page')).concat(TRACE_PAGE),
    };
  }

  // ───────────── 4M 변경점·초중종물 ─────────────

  async changes(input: Input): Promise<ToolOutcome> {
    const st = stationArg(input, false);
    if (!st.ok) return failFor(st);
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const station = st.v;
    const lineCode = station ? (STATIONS[station]?.line as LineCode | undefined) : line.v;
    const nowMs = this.now();
    const fa = this.quality.faStatus().filter((f) => (!station || f.station === station) && (!lineCode || f.line === lineCode));
    const filter = { line: station ? undefined : line.v, station, limit: '100' };
    const [changes, insp] = await Promise.all([this.quality.changes(filter), this.quality.inspections(filter)]);

    const pending = fa
      .filter((f) => f.pending.length)
      .map((f) => ({
        station: f.station, stationName: stName(f.station), gate: !!STATIONS[f.station]?.gate,
        waitingMin: minutesSince(f.pending[0].since, nowMs), count: f.pending.length,
        items: f.pending.slice(0, 3).map((p) => ({
          id: p.simId, since: kst(p.since), category: CHANGE_CATEGORY_NAMES[p.category], kind: CHANGE_KIND_NAMES[p.kind], detail: clip(p.detail, 80), status: FA_STATUS_NAMES[p.status],
        })),
        lastFirst: f.lastFirst ? { t: kst(f.lastFirst.at), serial: f.lastFirst.serial, result: f.lastFirst.result, change: f.lastFirst.changeSimId } : null,
      }))
      .sort((a, b) => (b.waitingMin ?? 0) - (a.waitingMin ?? 0));
    const one = station ? fa[0] : undefined;

    const byCategory: Partial<Record<string, number>> = {};
    for (const c of changes) byCategory[CHANGE_CATEGORY_NAMES[c.category as ChangeCategory]] = (byCategory[CHANGE_CATEGORY_NAMES[c.category as ChangeCategory]] ?? 0) + 1;
    const byType: Partial<Record<string, number>> = {};
    for (const i of insp) byType[INSPECTION_NAMES[i.type as InspectionType]] = (byType[INSPECTION_NAMES[i.type as InspectionType]] ?? 0) + 1;
    const inspView = (i: (typeof insp)[number]) => ({ t: kst(i.at), station: i.station, type: INSPECTION_NAMES[i.type], serial: i.serial, result: i.result, change: i.changeSimId });

    const data = {
      scope: station ? `${station} ${stName(station) ?? ''}` : line.v ? lineName(line.v) : '공장 전체',
      ...(station && {
        faRequired: one?.faRequired ?? false,
        gate: !!STATIONS[station]?.gate,
        lastFirst: one?.lastFirst ? { t: kst(one.lastFirst.at), serial: one.lastFirst.serial, result: one.lastFirst.result, change: one.lastFirst.changeSimId } : null,
      }),
      faPendingStations: pending.length,
      faPending: pending.slice(0, 8),
      changes: {
        recentCount: changes.length, byCategory,
        faNg: changes.filter((c) => c.faStatus === 'NG').length,
        awaitingApproval: changes.filter((c) => !c.approvedBy && (c.faStatus === 'OK' || c.faStatus === 'NONE')).length,
        recent: changes.slice(0, station ? 8 : 10).map((c) => ({
          t: kst(c.at), station: c.station, id: c.simId, category: CHANGE_CATEGORY_NAMES[c.category], kind: CHANGE_KIND_NAMES[c.kind], detail: clip(c.detail, 80),
          source: CHANGE_SOURCE_NAMES[c.source], fa: FA_STATUS_NAMES[c.faStatus], approved: c.approvedBy ? `${c.approvedBy} ${kst(c.approvedAt) ?? ''}`.trim() : null,
        })),
      },
      inspections: {
        recentCount: insp.length, byType, ng: insp.filter((i) => i.result === 'NG').length,
        recentNg: insp.filter((i) => i.result === 'NG').slice(0, 5).map(inspView),
        recent: insp.slice(0, 5).map(inspView),
      },
      note:
        '초물 대기 = 4M 변경점(교대·고장 수리·자재 LOT·기종 변경·보전·사람 신고) 뒤 첫 개체 검증이 아직 합격하지 않은 상태. 게이트 설비(gate)면 그동안 인터록이 초물 개체만 통과시키고 나머지는 대기(WAIT)로 답해 설비가 "MES 확인 대기"로 선다. ' +
        '초물이 불합격하면 다음 개체가 다시 초물이 된다. 중물은 4시간마다, 종물은 교대 끝·작업지시 마지막 개체. 최근 목록은 최근 100건 안에서 센 값이다. ' +
        '변경점 신고는 /changes·작업자 태블릿(/operator), 승인(서명)은 초물 판정 뒤 /changes 에서 품질(변경점 승인 권한)이 한다.',
    };
    return {
      ok: true, data,
      summary: station
        ? `${station} · 초물 대기 ${one?.pending.length ?? 0}건 · 최근 변경점 ${changes.length}`
        : `초물 대기 설비 ${pending.length}대 · 최근 변경점 ${changes.length} · 초물 불합격 ${data.changes.faNg}`,
      refs: [...new Set([...(station ? [station] : []), ...pending.slice(0, 4).map((p) => p.station)])].map(stationRef).concat(CHANGES_PAGE),
    };
  }

  // ───────────── 관리계획서 ─────────────

  controlPlan(input: Input): ToolOutcome {
    const st = stationArg(input, false);
    if (!st.ok) return failFor(st);
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const q = str(input, 'query', false);
    if (!q.ok) return fail(q.error);
    const plan = controlPlanOf();
    const lineCode = st.v ? (STATIONS[st.v]?.line as LineCode | undefined) : line.v;
    const lines = plan.lines.filter((l) => !lineCode || l.line === lineCode);
    const rowView = (r: ControlPlanRow) => ({
      no: r.no, op: `OP${r.opNo} ${r.stepName}`, station: r.station, stationName: r.stationName, char: CP_CHAR_NAMES[r.charKind], source: CP_SOURCE_NAMES[r.source],
      name: r.name, special: r.special ? `${r.special.symbol} ${SPECIAL_NAMES[r.special.type]}: ${clip(r.special.reason, 80)}` : null, spec: r.spec.text,
      evaluation: r.evaluation, sample: r.sampleSize, frequency: r.frequency, controls: clip(r.controls.join(' / '), 160), reactions: r.reactions.slice(0, 2).map((x) => clip(x, 120)),
    });
    const counts = lines.map((l) => ({ line: l.line, docNo: l.docNo, phase: l.phase, rows: l.rows.length, product: l.counts.product, process: l.counts.process, cc: l.counts.cc, sc: l.counts.sc }));
    const note = '공장 정의(설비 태그·측정·불량·검사)에서 자동으로 만든 관리계획서다. 특별 특성(◆·▲) 지정은 공개 법규·자료와 공정 인과로 정한 가정이고 근거 등급이 붙어 있다. 인쇄용 표는 /control-plan.';

    let rows = lines.flatMap((l) => l.rows).filter((r) => !st.v || r.station === st.v);
    if (!st.v && !line.v && !q.v) {
      // 범위가 없으면 개요만: 라인별 항목 수와 법규·안전 특별 특성
      const cc = rows.filter((r) => r.special?.type === 'CC');
      return {
        ok: true,
        data: { scope: '공장 전체', counts, safetyCritical: cc.slice(0, CP_ROWS_N).map(rowView), note: `${note} 설비·라인·특성 이름을 주면 그 범위의 관리 항목을 준다.` },
        summary: `관리계획서 ${counts.map((c) => `${c.line} ${c.rows}항목`).join(' · ')} · ◆ ${cc.length}`,
        refs: [CP_PAGE],
      };
    }
    if (q.v) {
      const query = q.v;
      if (/특별|◆|▲|법규|안전|핵심|\bCC\b|\bSC\b/i.test(query)) {
        const type = /법규|안전|◆|\bCC\b/i.test(query) ? 'CC' : /핵심|▲|\bSC\b/i.test(query) ? 'SC' : null;
        rows = rows.filter((r) => r.special && (!type || r.special.type === type));
      } else {
        const words = query.split(/[\s,·]+/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2);
        const text = (r: ControlPlanRow) => `${r.name} ${r.key} ${r.stepName} ${r.stationName} ${r.evaluation}`.toLowerCase();
        rows = rows
          .map((r) => ({ r, hit: words.filter((w) => text(r).includes(w)).length }))
          .filter((x) => x.hit > 0)
          .sort((a, b) => b.hit - a.hit)
          .map((x) => x.r);
      }
    }
    const scope = st.v ? `${st.v} ${stName(st.v) ?? ''}` : lineCode ? lineName(lineCode) : '공장 전체';
    return {
      ok: true,
      data: { scope, query: q.v ?? null, counts, matched: rows.length, truncated: rows.length > CP_ROWS_N, rows: rows.slice(0, CP_ROWS_N).map(rowView), basis: plan.basis, note },
      summary: `관리계획서 ${scope}${q.v ? ` · '${q.v}'` : ''} · ${rows.length}항목`,
      refs: [...new Set(rows.slice(0, 3).map((r) => r.station))].map(stationRef).concat(CP_PAGE),
    };
  }

  // ───────────── 교대 일보 ─────────────

  async shiftReport(input: Input): Promise<ToolOutcome> {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const key = str(input, 'key', false);
    if (!key.ok) return fail(key.error);
    const which = oneOf(input, 'which', ['current', 'previous'] as const);
    if (!which.ok) return fail(which.error);
    const day = oneOf(input, 'day', ['today', 'yesterday'] as const);
    if (!day.ok) return fail(day.error);
    const shift = oneOf(input, 'shift', ['D', 'N'] as const);
    if (!shift.ok) return fail(shift.error);

    const list = await this.reports.shifts();
    if (!list.shifts.length) return fail('아직 실행 기록이 없어 교대 일보를 만들 수 없습니다 (시뮬레이터를 켜 주세요)');
    const available = list.shifts.slice(0, 6).map((s) => `${s.key} ${s.name}${s.current ? ' (진행 중)' : ''}`);
    let k = key.v?.toUpperCase();
    if (!k && (day.v || shift.v)) {
      if (day.v) {
        const nowMs = Date.parse(list.now ?? '') || this.now();
        const today = new Date(nowMs + KST).toISOString().slice(0, 10);
        const date = day.v === 'yesterday' ? new Date(Date.parse(`${today}T00:00:00Z`) - 24 * HOUR).toISOString().slice(0, 10) : today;
        k = shift.v ? `${date}-${shift.v}` : list.shifts.find((s) => s.date === date)?.key;
        if (!k) return fail(`${date}에 시작한 교대가 이 실행에 없습니다`, { available });
      } else k = list.shifts.find((s) => s.code === shift.v)?.key;
    }
    if (!k) {
      const idx = Math.max(0, list.shifts.findIndex((s) => s.current));
      k = (which.v === 'previous' ? list.shifts[idx + 1] : list.shifts[idx])?.key;
      if (!k) return fail('직전 교대가 이번 실행 전입니다', { available });
    }
    if (!list.shifts.some((s) => s.key === k)) return fail(`${k} 교대는 이 실행에서 지나지 않았거나 실행 전입니다`, { available });

    const r = await this.reports.shift(k, line.v);
    const lineView = (x: ShiftLineReport) => {
      const ilkTop = (Object.entries(x.interlock.byCode) as [InterlockCode, number][]).sort((a, b) => b[1] - a[1])[0];
      return {
        line: x.line, name: lineName(x.line),
        target: x.target, input: x.input, ok: x.ok, ng: x.ng, scrap: x.scrap,
        achievementPct: x.target ? pct(x.ok / x.target) : null,
        fpyPct: x.fpy != null ? pct(x.fpy) : null,
        oee: x.oee ? { oeePct: pct(x.oee.oee), availabilityPct: pct(x.oee.availability), performancePct: pct(x.oee.performance), qualityPct: pct(x.oee.quality) } : null,
        downtimeTop: x.downtime.slice(0, 3).map((d) => ({ state: STATE_NAMES[d.state], reason: d.reason, minutes: Math.round(d.sec / 60), count: d.count, stations: d.stations.slice(0, 3) })),
        defectsTop: x.defects.slice(0, 3).map((d) => ({ name: d.name, count: d.count, stations: d.stations.slice(0, 2) })),
        ncr: x.ncr,
        changes: { total: x.changes.total, faNg: x.changes.faNg, byCategory: Object.fromEntries((Object.entries(x.changes.byCategory) as [ChangeCategory, number][]).filter(([, n]) => n).map(([c, n]) => [CHANGE_CATEGORY_NAMES[c], n])) },
        inspections: { first: x.inspections.FIRST, mid: x.inspections.MID, last: x.inspections.LAST, ng: x.inspections.ng },
        interlock: { ng: x.interlock.ng, wait: x.interlock.wait, topReject: ilkTop ? `${INTERLOCK_NAMES[ilkTop[0]]} ${ilkTop[1]}` : null },
        energy: { kwh: x.energy.kwh != null ? r1(x.energy.kwh) : null, perUnitKwh: x.energy.perUnit != null ? r3(x.energy.perUnit) : null },
        orders: x.orders.slice(0, 4).map((o) => ({ code: o.code, variant: o.variant, status: WO_STATUS_NAMES[o.status], shiftInput: o.input, shiftGood: o.good, total: `${o.doneQty}/${o.qty}` })),
      };
    };
    const lines = r.lines.map(lineView);
    const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((a, l) => a + f(l), 0);
    const data = {
      shift: r.name, key: r.key, period: `${kst(r.from)} ~ ${kst(r.to)}`, inProgress: r.current,
      totals: { input: sum((l) => l.input), ok: sum((l) => l.ok), ng: sum((l) => l.ng), scrap: sum((l) => l.scrap), kwh: r1(sum((l) => l.energy.kwh ?? 0)) },
      lines, available,
      note:
        '목표 = 교대 중 실행 시간 ÷ 택트(계획 정지 포함한 상한). 생산 OK = 최종 공정 양품, 불량 = 모든 공정 불량 판정 수, 폐기 = 제품 경로 밖 불량 + NCR 폐기·수리 실패 + Hold 폐기. ' +
        'OEE·직행률은 6대 로스·실시간 화면과 같은 정의. 진행 중 교대는 지금까지 값. 인쇄·CSV는 /reports.',
    };
    return {
      ok: true, data,
      summary: `${r.name}${r.current ? '(진행 중)' : ''} · 생산 OK ${data.totals.ok} · 불량 ${data.totals.ng} · 폐기 ${data.totals.scrap}`,
      refs: [REPORTS_PAGE],
    };
  }

  // ───────────── 에너지 ─────────────

  async energyReport(input: Input): Promise<ToolOutcome> {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    if (input.hours != null && (typeof input.hours !== 'number' || !(input.hours > 0))) return fail('hours는 0보다 큰 수입니다');
    const hours = typeof input.hours === 'number' ? Math.min(ENERGY_MAX_H, input.hours) : undefined;
    let from: string | undefined;
    let label: string;
    if (input.current_shift === true) {
      const now = this.live.virtualNow;
      if (!now) return fail('가상 시각을 몰라 지금 교대를 정할 수 없습니다 (시뮬레이터 연결 전)');
      const s = shiftOf(now);
      from = s.start;
      label = `${shiftLabel(s.date, s.code)} 교대 시작부터`;
    } else label = `최근 ${hours ?? 24}시간`;
    const r = await this.energy.report({ from, hours: from ? undefined : hours != null ? String(hours) : undefined, line: line.v });
    const st = r.stations.filter((s) => s.kw);
    const view = (s: StationEnergy) => ({
      station: s.station, name: stName(s.station), kwh: r1(s.total), run: r1(s.run), idle: r1(s.idle), off: r1(s.off),
      idleSharePct: s.idleShare != null ? pct(s.idleShare) : null, perUnitKwh: s.perUnit != null ? r3(s.perUnit) : null,
      kw: s.kw ? `${s.kw.run}/${s.kw.idle}/${s.kw.off}` : null, hours: { run: r1(s.hours.run), idle: r1(s.hours.idle), off: r1(s.hours.off) },
    });
    const top = [...st].sort((a, b) => b.total - a.total).slice(0, 8);
    const topIdle = [...st].filter((s) => s.idle > 0).sort((a, b) => b.idle - a.idle).slice(0, 5);
    const data = {
      period: { label, from: kst(r.from), to: kst(r.to), hours: r1((Date.parse(r.to) - Date.parse(r.from)) / HOUR) },
      scope: line.v ? lineName(line.v) : '공장 전체',
      total: { kwh: r1(r.total.total), run: r1(r.total.run), idle: r1(r.total.idle), off: r1(r.total.off), idleSharePct: r.total.idleShare != null ? pct(r.total.idleShare) : null },
      lines: r.lines.map((l) => ({ line: l.line, name: lineName(l.line), kwh: r1(l.total), good: l.good, perUnitKwh: l.perUnit != null ? r3(l.perUnit) : null, idleSharePct: l.idleShare != null ? pct(l.idleShare) : null })),
      topStations: top.map(view),
      topIdle: topIdle.map((s) => ({ station: s.station, name: stName(s.station), idleKwh: r1(s.idle), idleSharePct: s.idleShare != null ? pct(s.idleShare) : null, idleHours: r1(s.hours.idle) })),
      hourly: r.hourly.slice(-8).map((b) => ({ t: kst(b.t), kwh: r1(b.run + b.idle + b.off), partial: b.partial })),
      missingStations: r.missing.length,
      note:
        '전력량 = 상태 시간 × 상태별 정격 소비 전력(가동 = RUN, 대기 = 투입 대기·배출 대기·셋업, 정지 = 계획 정지·고장)으로 낸 추정값이다. 실측 전력량계 값이 아니다. kw = 가동/대기/정지 소비 전력. ' +
        '개당 kWh는 설비 = 그 설비 양품 처리 수, 라인 = 완성품으로 나눈다. 대기 전력이 큰 설비는 대기 시간(앞뒤 공정 막힘)과 대기 중 절전 설정을 본다. 화면은 /energy.',
    };
    return {
      ok: true, data,
      summary: `${label} 총 ${data.total.kwh} kWh · 대기 ${data.total.idleSharePct ?? '−'}%${top[0] ? ` · 1위 ${top[0].station} ${r1(top[0].total)} kWh` : ''}`,
      refs: top.slice(0, 3).map((s) => stationRef(s.station)).concat(ENERGY_PAGE),
    };
  }

  // ───────────── 예지 보전 ─────────────

  equipmentHealth(input: Input): ToolOutcome {
    const st = stationArg(input, false);
    if (!st.ok) return failFor(st);
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const v = this.health.view();
    if (st.v && !v.stations.some((s) => s.station === st.v))
      return fail(`${st.v} ${stName(st.v) ?? ''}은(는) 상태 감시(진동·전류·온도) 대상이 아닙니다`, { monitored: v.stations.map((s) => `${s.station} ${stName(s.station) ?? ''}`) });
    const list = v.stations
      .filter((s) => (!st.v || s.station === st.v) && (!line.v || s.line === line.v))
      .sort((a, b) => (a.level ? LEVEL_ORDER[a.level] : 4) - (b.level ? LEVEL_ORDER[b.level] : 4) || (a.index ?? 2) - (b.index ?? 2));
    const byLevel: Record<string, number> = {};
    for (const s of list) byLevel[s.level ? HEALTH_LEVEL_NAMES[s.level] : '자료 없음'] = (byLevel[s.level ? HEALTH_LEVEL_NAMES[s.level] : '자료 없음'] ?? 0) + 1;
    const view = (s: StationHealth) => ({
      station: s.station, name: stName(s.station), part: s.part,
      level: s.level ? HEALTH_LEVEL_NAMES[s.level] : '자료 없음', vibMmS: s.vib, normalVib: s.base.vib, warnAt: s.zones.bc, dangerAt: s.zones.cd,
      healthIndexPct: s.index != null ? pct(s.index) : null,
      currentVsNormalPct: s.latest ? pct(s.latest.cur / s.base.cur) : null,
      tempRiseC: s.latest ? r1(s.latest.temp - s.base.temp) : null,
      rul: s.rul ? { toWarnH: r1(s.rul.warnH), toDangerH: r1(s.rul.dangerH), slopePerH: r3(s.rul.slopePerH), samples: s.rul.n } : null,
      rulNote: s.rul ? null : s.rulNote,
      lastMaint: s.lastMaint ? `${s.lastMaint.kind === 'pm' ? '보전' : '고장 수리'} ${kst(s.lastMaint.at)}` : '이번 실행에서 없음',
      samples: s.samples,
      ...(st.v && { trend: s.trend.slice(-6).map((p) => ({ t: kst(p.t), vib: r2(p.vib) })) }),
    });
    const bad = list.filter((s) => s.level === 'warn' || s.level === 'danger');
    const data = {
      virtualTime: kst(v.t), monitored: list.length, unmonitoredInFactory: v.unmonitored, byLevel,
      stations: list.slice(0, st.v ? 1 : 10).map(view),
      note:
        '진동 등급은 ISO 10816 구역(양호 A · 관찰 B · 경고 C = 장기 운전 부적합, 보전 계획 · 위험 D = 손상 우려, 즉시 보전)이고 경계값은 2차 자료(weak)다. 최근 가동 표본 5개 중앙값으로 정한다. ' +
        '남은 수명(rul)은 마지막 보전 뒤 최근 6시간 진동 추세를 직선으로 늘린 가상 시간이라 마모가 빨라지는 끝 무렵에는 실제보다 길게(낙관적으로) 나온다. ' +
        '보전 실시(설비를 세우고 마모를 되돌림)는 /maintenance 예지 보전 영역에서 보전 담당(수리 완료·보전 실시 권한)이 한다.',
    };
    const one = st.v ? list[0] : undefined;
    return {
      ok: true, data,
      summary: one
        ? `${one.station} · ${one.level ? HEALTH_LEVEL_NAMES[one.level] : '자료 없음'} · 진동 ${one.vib ?? '−'} mm/s`
        : `감시 ${list.length}대 · 위험 ${list.filter((s) => s.level === 'danger').length} · 경고 ${list.filter((s) => s.level === 'warn').length}`,
      refs: [...new Set([...(st.v ? [st.v] : []), ...bad.slice(0, 4).map((s) => s.station)])].map(stationRef).concat(MAINT_PAGE),
    };
  }
}
