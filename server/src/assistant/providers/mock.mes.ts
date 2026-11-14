import type { LineCode } from '@lumitwin/shared';
import type { ToolOutcome } from '../assistant.common';
import { josa } from './josa';

/* eslint-disable @typescript-eslint/no-explicit-any -- 도구 결과(JSON)를 템플릿에 꽂기만 한다 */
type Any = any;
type Call = (name: string, input?: Record<string, unknown>) => Promise<ToolOutcome>;

/** 질문에서 뽑은 대상 (mock.provider의 Entities 중 여기서 쓰는 것) */
export interface MesEntities {
  station?: string;
  line?: LineCode;
  lot?: string;
  serial?: string;
  hold?: string;
  ncr?: string;
  wo?: string;
}

/** 모의 모드 도움말에 덧붙이는 실행 MES 질문 예 */
export const MES_HELP = [
  '지금 EM 라인 작업지시 어디까지 왔어?',
  'MRB 대기 NCR 있어?',
  '활성 Hold 영향 범위 알려 줘',
  'HL-AS-01 초물 대기 왜 걸렸어?',
  '칩 마운터 진동 괜찮아?',
  '어제 야간 교대 실적 요약해 줘',
  '이번 교대 전력 제일 많이 쓴 설비는?',
  '오늘 TBM에서 빠진 항목 있어?',
];

/**
 * 실행 MES·품질 체계·분석 질문이면 맞는 도구를 불러 정해진 틀로 답하고, 아니면 null (기존 규칙으로 넘긴다).
 * 순서가 중요하다: Hold·NCR은 LOT·시리얼과 함께 오고, '예지 보전'은 보전 질문과, '교대 전력'은 교대 일보와 겹친다.
 * 상태를 바꾸는 일은 답에서 화면과 권한만 안내한다 (비서는 조회만 한다)
 */
export async function mesAnswer(m: string, e: MesEntities, call: Call, wantsHow: boolean): Promise<string | null> {
  const has = (re: RegExp) => re.test(m);

  // TBM 회의 대조 ("TBM에서 Hold 공유 빠졌어?"가 Hold 규칙으로 가지 않게 먼저 본다. "TBM 하는 방법"은 작업표준서로)
  if (has(/TBM|티비엠|툴\s*박스|안전\s*회의|아침\s*회의|작업\s*전\s*회의/i) && (!wantsHow || has(/빠|놓|안\s*다|결과|대조|확인|미흡/))) {
    const out = await call('tbm_status', { line: e.line });
    return out.ok ? tbmText(out.data) : out.summary;
  }

  // Hold·격리 ("LOT 격리 방법"처럼 절차를 묻는 것은 작업표준서로 넘긴다)
  if (e.hold || has(/hold|홀드/i) || (has(/격리/) && !wantsHow)) {
    const code = e.hold ?? e.lot ?? e.serial;
    if (code) {
      const out = await call('hold_status', { code });
      if (out.ok) return holdDetailText(out.data);
      if (e.lot) {
        const t = await call('lot_trace', { lot: e.lot });
        return `${e.lot}에 걸린 Hold는 지금 없습니다.${t.ok ? `\n\n${lotBrief(t.data)}` : ''}\n\nHold는 /trace 에서 품질 담당·조장이 겁니다. 비서는 Hold를 걸거나 풀지 않습니다.`;
      }
      return `${out.summary}. 시리얼 이력은 시리얼만 넣어 물어보거나 /trace 에서 볼 수 있습니다.`;
    }
    const out = await call('hold_status', {});
    if (!out.ok) return out.summary;
    const d = out.data as Any;
    const first = (d.holds ?? [])[0];
    if (first && has(/영향|범위|어디까지|회수|출하|대상/)) {
      const one = await call('hold_status', { code: first.code });
      if (one.ok) return `${holdsText(d, true)}\n\n가장 최근 Hold의 영향 범위입니다.\n\n${holdDetailText(one.data)}`;
    }
    return holdsText(d);
  }

  // 불량 처리 (NCR·MRB)
  if (e.ncr || has(/\bNCR\b|MRB/i) || (has(/불량\s*처리|수리대|재검사|특채|부적합/) && !wantsHow)) {
    const code = e.ncr ?? e.serial;
    if (code) {
      const out = await call('ncr_status', { code });
      return out.ok ? ncrDetailText(out.data) : out.summary;
    }
    const mrb = has(/MRB|판정\s*대기/i);
    const out = await call('ncr_status', { line: e.line, status: mrb ? 'WAIT_MRB' : undefined });
    return out.ok ? ncrText(out.data, mrb) : out.summary;
  }

  // 예지 보전 ('예지 보전'에 '보전'이 들어 있어 설비 보전 규칙보다 먼저 본다)
  if (has(/진동|예지|건강|남은\s*수명|\bRUL\b|상태\s*감시|마모|베어링/i) && (!wantsHow || has(/수명|RUL|건강|예지|등급|괜찮/i))) {
    const out = await call('equipment_health', { station: e.station, line: e.station ? undefined : e.line });
    return out.ok ? healthText(out.data, !!e.station) : out.summary;
  }

  // 에너지 ("전원 차단 절차"는 안전 절차라 넘긴다)
  if (has(/전력|에너지|kwh|전기\s*(사용|소비|많이|요금)|소비\s*전력/i) && !has(/차단|LOTO|잠금|감전/i)) {
    const hours = /(\d+)\s*시간/.exec(m)?.[1];
    const shift = has(/교대/);
    const out = await call('energy_report', { line: e.line, current_shift: shift || undefined, hours: hours && !shift ? Number(hours) : undefined });
    return out.ok ? energyText(out.data) : out.summary;
  }

  // 관리계획서
  if (has(/관리\s*계획서|컨트롤\s*플랜|control\s*plan|특별\s*특성/i)) {
    const out = await call('control_plan', { station: e.station, line: e.station ? undefined : e.line, query: has(/특별\s*특성/) ? '특별 특성' : undefined });
    return out.ok ? controlPlanText(out.data) : out.summary;
  }

  // 4M 변경점·초중종물 ("초물 검사 방법"은 작업표준서로)
  if (has(/초물|중물|종물|변경점|4\s*M\b/i) && (!wantsHow || has(/대기|걸|막|기다|왜/))) {
    const out = await call('change_points', { station: e.station, line: e.station ? undefined : e.line });
    return out.ok ? changesText(out.data) : out.summary;
  }

  // 공정 인터록
  if (has(/인터록|인터락|interlock|투입\s*거부|MES\s*확인/i)) {
    const out = await call('interlock_status', { station: e.station, line: e.station ? undefined : e.line });
    return out.ok ? interlockText(out.data) : out.summary;
  }

  // 작업지시·생산 계획
  if (e.wo || has(/작업\s*지시|\bWO\b|기종\s*변경|생산\s*계획|계획\s*없음|투입\s*계획/i)) {
    const out = await call('work_orders', { line: e.line });
    return out.ok ? workOrdersText(out.data) : out.summary;
  }

  // 교대 일보
  if (has(/교대|일보/)) {
    const key = /\b(\d{4}-\d{2}-\d{2}-[DN])\b/i.exec(m)?.[1]?.toUpperCase();
    const day = has(/어제|전날/) ? 'yesterday' : has(/오늘|금일/) ? 'today' : undefined;
    const shift = has(/야간|밤/) ? 'N' : has(/주간|낮/) ? 'D' : undefined;
    const which = has(/지난|직전|이전|전\s*교대|앞\s*교대/) ? 'previous' : undefined;
    const input = key ? { key, line: e.line } : { day, shift, which: day || shift ? undefined : which, line: e.line };
    const out = await call('shift_report', input);
    return out.ok ? shiftText(out.data) : `${out.summary}${(out.data as Any)?.available?.length ? `\n\n고를 수 있는 교대: ${(out.data as Any).available.join(', ')}` : ''}`;
  }
  return null;
}

// ───────────── 답 틀 ─────────────

function tbmText(d: Any): string {
  const by: Record<string, string> = { claude: 'Claude', local: '로컬 LLM', mock: '모의 규칙' };
  const rows: string[] = [];
  for (const x of d.meetings ?? []) {
    if (!x.meeting) {
      rows.push(`- ${x.lineName}: 올린 TBM 회의가 없습니다`);
      continue;
    }
    const mt = x.meeting;
    const c = mt.counts;
    if (mt.status !== '완료') {
      rows.push(`- ${x.lineName} · 회의 #${mt.id} (${mt.shift}): ${mt.status}${mt.error ? ` — ${mt.error}` : ''}`);
      continue;
    }
    rows.push(`- ${x.lineName} · 회의 #${mt.id} (${mt.shift}, ${mt.createdBy ?? '−'}, 판정 ${by[mt.judgedBy] ?? mt.judgedBy}): 다룸 ${c.covered} · 부분 ${c.partial} · 안 다룸 ${c.missing} · 불확실 ${c.uncertain}, 확인 필요 ${mt.open}항목`);
    for (const st of ['안 다룸', '불확실', '부분']) {
      const items = (x.notCovered ?? []).filter((i: Any) => i.status === st);
      if (items.length) rows.push(`  · ${st}: ${items.map((i: Any) => `${i.title}${i.followUp ? ` [${i.followUp}]` : ''}`).join(', ')}`);
    }
  }
  return `TBM 체크리스트 대조 결과입니다.\n\n${rows.join('\n')}\n\n불확실은 판정기가 다뤘다고 했지만 근거 줄을 확인하지 못한 항목이라 사람이 확인해야 합니다. 빠진 항목의 보완 전달·확인 체크는 /tbm 에서 조장이 하고 감사 기록이 남습니다.`;
}

const n0 = (v: number | null | undefined) => (v == null ? '−' : v.toLocaleString('ko-KR'));
/** 분 → '35분' · '3시간 5분' */
function dur(min: number | null | undefined): string {
  if (min == null) return '−';
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return `${h}시간${r ? ` ${r}분` : ''}`;
}
/** 시간 → '7.5시간' · '3.2일' · 이미 넘었으면 '이미 넘음' */
const hours = (h: number) => (h <= 0 ? '이미 넘음' : h >= 48 ? `약 ${(h / 24).toFixed(1)}일` : `약 ${h}시간`);
/** 표 칸에 '|'가 들어가면 표가 깨진다 */
const cell = (s: unknown) => String(s ?? '−').replace(/\|/g, '/');

function workOrdersText(d: Any): string {
  const lines = (d.lines ?? []) as Any[];
  const intro = d.mesReady === false ? 'MES가 기록을 되살리는 중이라 값이 잠시 뒤 맞춰집니다.\n\n' : '';
  let body: string;
  if (lines.length === 1) {
    const l = lines[0];
    const c = l.current;
    const head = c
      ? `${josa(l.name, ['은', '는'])} ${c.code}(${c.variant}${c.variantName ? ` ${c.variantName}` : ''})${josa(c.code, ['을', '를']).slice(c.code.length)} ${c.releasing ? '투입하고 있습니다' : '다 투입하고 라인 안 재공을 마무리하고 있습니다'}. ` +
        `양품 ${n0(c.good)}/${n0(c.qty)}개(${c.donePct}%), 투입 ${n0(c.released)} · 라인 안 ${n0(c.wip)} · 폐기 ${n0(c.scrap)}${c.expectedEnd ? `, 예상 끝 ${c.expectedEnd}` : ''}.`
      : `${l.name}: ${l.state}.`;
    const queue = (l.queue as Any[]).map((q) => `- ${q.code} ${q.variant} ${q.qty}개 (${q.start ?? '−'} ~ ${q.end ?? '−'})${q.changeover ? ` · 기종 변경 ${q.changeover.from ?? '?'} → ${q.changeover.to}, 셋업 약 ${q.changeover.setupMin}분` : ''}`);
    body = `${head}${queue.length ? `\n\n대기 ${l.plannedCount}건 (순서대로)\n${queue.join('\n')}` : '\n\n대기 작업지시가 없습니다.'}`;
  } else {
    const rows = lines.map((l) => {
      const c = l.current;
      return c
        ? `| ${l.name} | ${c.code} | ${c.variant} | ${n0(c.good)}/${n0(c.qty)} (${c.donePct}%) | ${n0(c.released)} | ${n0(c.wip)} | ${c.expectedEnd ?? '−'} |`
        : `| ${l.name} | 없음 | − | − | − | − | ${cell(l.state)} |`;
    });
    body = `라인별 진행 작업지시입니다.\n\n| 라인 | 작업지시 | 기종 | 양품/수량 | 투입 | 라인 안 | 예상 끝 |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}`;
  }
  const changes = lines
    .filter((l) => l.nextChangeover)
    .map((l) => {
      const c = l.nextChangeover;
      return `- ${l.name}: ${c.from ?? '?'} → ${c.to}, ${c.code} 시작 예상 ${c.at ?? '−'}${c.inMin != null ? ` (약 ${dur(c.inMin)} 뒤)` : ''}, 셋업 약 ${c.setupMin}분`;
    });
  const issues = lines.filter((l) => l.waitMrb || l.quarantine).map((l) => `${l.name} MRB 대기 ${l.waitMrb}건 · 격리 ${l.quarantine}묶음`);
  return (
    `${intro}${body}` +
    `${changes.length ? `\n\n다음 기종 변경\n${changes.join('\n')}` : ''}` +
    `${issues.length ? `\n\n확인할 것: ${issues.join(', ')} (/ncr, /trace)` : ''}` +
    '\n\n예상 시각은 택트로 계산한 계획값(가상 시각)이고, 기종 변경 셋업은 보수적으로 잡았습니다. 작업지시 만들기·순서 바꾸기·수량·중단은 /orders 에서 조장이 합니다.'
  );
}

function interlockText(d: Any): string {
  const codes = ((d.byCode ?? []) as Any[]).filter((c) => c.ng || c.wait);
  const head = d.rejected || d.waited ? `${d.scope} 인터록은 이번 실행에서 거부 ${n0(d.rejected)}건, 대기 ${n0(d.waited)}건입니다.` : `${d.scope}에는 이번 실행의 인터록 거부·대기 기록이 없습니다.`;
  const live = d.sinceServerStart ? ` 서버가 켜진 뒤 통과 ${n0(d.sinceServerStart.ok)}건.` : '';
  const byCode = codes.length ? `\n\n사유별: ${codes.map((c) => `${c.name} 거부 ${c.ng}·대기 ${c.wait}`).join(', ')}` : '';
  const stations = ((d.byStation ?? []) as Any[]).filter((s) => s.ng).slice(0, 3);
  const st = stations.length ? `\n거부가 많은 설비: ${stations.map((s) => `${s.station} ${s.stationName ?? ''} ${s.ng}건`).join(', ')}` : '';
  const recent = ((d.recentRejects ?? []) as Any[]).slice(0, 4).map((r) => `- ${r.t} ${r.station} ${r.serial}: ${r.name} — ${r.reason}`);
  const skipped = d.skippedNoReply ? `\n\nMES 응답이 늦어 확인 없이 통과한 개체가 ${n0(d.skippedNoReply)}개 있습니다.` : '';
  return `${head}${live}${byCode}${st}${recent.length ? `\n\n최근 거부\n${recent.join('\n')}` : ''}${skipped}\n\n거부된 투입 묶음은 격리 구역으로 갑니다. 풀거나 폐기하는 것은 /trace Hold 영역에서, 인터록 현황은 /orders 에서 볼 수 있습니다.`;
}

function ncrRow(n: Any): string {
  return `| ${n.code} | ${n.station} | ${cell(n.defectName)} | ${n.status} | ${n.waitingMin != null ? dur(n.waitingMin) : (n.closed ?? '−')} |`;
}

function ncrText(d: Any, mrbFocus: boolean): string {
  const s = d.summary;
  const items = (d.shown ?? []) as Any[];
  const head = mrbFocus
    ? s.waitMrb
      ? `MRB 판정을 기다리는 NCR이 ${s.waitMrb}건 있습니다.`
      : `MRB 판정을 기다리는 NCR은 없습니다. 처리 중인 NCR은 ${s.open}건입니다.`
    : `${d.scope} 처리 중인 NCR은 ${s.open}건입니다${s.waitMrb ? ` (MRB 판정 대기 ${s.waitMrb}건)` : ''}.`;
  const table = items.length ? `\n\n| NCR | 설비 | 불량 | 상태 | 경과 |\n|---|---|---|---|---|\n${items.slice(0, 6).map(ncrRow).join('\n')}${d.matched > 6 ? `\n\n외 ${d.matched - 6}건` : ''}` : '';
  const stats = `\n\n수리 성공률 ${s.repairSuccessPct ?? '−'}%(끝난 수리 ${s.repairDone}건) · 평균 수리 ${s.avgRepairMin ?? '−'}분 · 폐기 ${s.scrapped} · 특채 ${s.uai}`;
  const top = (s.topDefects ?? []) as Any[];
  const topLine = top.length ? `\n많이 난 불량: ${top.slice(0, 3).map((x) => `${x.name} ${x.n}`).join(', ')}` : '';
  const foot = s.waitMrb
    ? '\n\nMRB 대기 건은 품질 담당·조장이 /ncr 에서 수리·재작업·폐기·특채 중 하나로 판정해야 합니다(특채는 근거 메모 필수). 비서는 판정하지 않습니다.'
    : '\n\n상세와 판정은 /ncr 에서 볼 수 있습니다.';
  return `${head}${table}${stats}${topLine}${foot}`;
}

function ncrDetailText(d: Any): string {
  const head = `${d.code}: ${d.serial}(${d.item}) · ${d.station} ${d.stationName ?? ''}에서 ${d.defectName} 불량, ${d.opened} 접수. 상태는 ${d.status}${d.waitingMin != null ? `(${dur(d.waitingMin)}째)` : ''}입니다.`;
  const how = d.disposition
    ? `처리: ${d.disposition}${d.rule ? ` — ${d.rule}` : ''}${d.decidedBy ? ` (${d.decidedBy})` : ''}`
    : `처리 기준이 권하는 처리: ${d.suggested.action} (${d.suggested.rule}${d.suggested.action.startsWith('수리') || d.suggested.action.startsWith('재작업') ? `, 약 ${d.suggested.repairMin}분 · 성공 ${d.suggested.repairSuccessPct}%` : ''})`;
  const facts = [d.repairMin != null ? `수리대 ${d.repairMin}분` : '', d.reinspect ? `재검사 ${d.reinspect}` : '', d.outcome ? `결말 ${d.outcome}` : ''].filter(Boolean).join(' · ');
  const hist = ((d.otherNcrsOfSerial ?? []) as Any[]).map((h) => `${h.code} ${h.station} ${h.defectName} ${h.outcome ?? h.status}`);
  const open = d.status === '접수' || d.status === 'MRB 판정 대기';
  return `${head}\n\n${how}${facts ? `\n${facts}` : ''}${hist.length ? `\n\n같은 시리얼의 다른 NCR: ${hist.join(', ')}` : ''}\n\n${open ? '판정은 /ncr 에서 품질 담당·조장이 합니다. 비서는 판정하지 않습니다.' : '이력은 /ncr 에서 볼 수 있습니다.'}`;
}

function holdsText(d: Any, short = false): string {
  const holds = (d.holds ?? []) as Any[];
  const head = d.active ? `활성 Hold가 ${d.active}건 있습니다.` : '지금 걸려 있는 Hold는 없습니다.';
  const list = holds
    .slice(0, short ? 3 : 5)
    .map((h) => `- ${h.code} ${h.kind} ${h.target}: ${h.reason} (${h.createdBy ?? '−'}, ${h.created}${h.heldMin != null ? `, ${dur(h.heldMin)}째` : ''}${h.quarantinedNow ? ` · 격리 ${h.quarantinedNow}묶음` : ''})`);
  const q = d.quarantine ?? { total: 0, byReason: [] };
  const quar = q.total
    ? `\n\n격리 구역에 투입 묶음 ${q.total}개가 있습니다(${(q.byReason as Any[]).map((r) => `${r.name} ${r.n}`).join(' · ')})${q.notInHold ? `. 이 중 ${q.notInHold}개는 Hold에 묶이지 않은 인터록 거부라 /trace 에서 시리얼 Hold로 묶어 해제하거나 폐기해야 합니다` : ''}.`
    : '\n\n격리 구역은 비어 있습니다.';
  const foot = short ? '' : '\n\nHold 설정은 /trace 에서 품질 담당·조장이, 해제·폐기는 품질 담당·관리자가 메모와 함께 합니다. 비서는 Hold를 걸거나 풀지 않습니다.';
  return `${head}${list.length ? `\n${list.join('\n')}` : ''}${quar}${foot}`;
}

function holdDetailText(d: Any): string {
  if (!d.impact) {
    // Hold는 없고 격리 구역에만 있는 시리얼
    const q = d.quarantine;
    return `${q.serial}에 걸린 Hold는 없지만 ${q.t} ${q.station}에서 인터록(${q.name})으로 거부돼 격리 구역에 있습니다. 사유: ${q.reason}\n\n${d.note}`;
  }
  const im = d.impact;
  const st = im.byStatus ?? {};
  // 대상 글에 괄호가 겹쳐 들어갈 수 있어 조사는 번호에 맞춘다
  const particle = josa(d.code, ['은', '는']).slice(d.code.length);
  const head = `${d.code}(${d.kind} ${d.target})${particle} ${d.status} 상태입니다. 사유: ${d.reason} (${d.createdBy ?? '−'}, ${d.created})`;
  const rows = [
    `- 대상 부품 ${n0(im.baseParts)}개 → 들어간 맨 위 제품 ${n0(im.topProducts)}개${im.truncated ? ' (일부만 셈)' : ''}`,
    `- 완제품·창고 (출하 보류·회수 검토): ${n0(im.finished)}개`,
    `- 공정 안 (다음 게이트에서 격리): ${n0(im.inProcess)}개`,
    st.HOLD ? `- 이미 격리: ${n0(st.HOLD)}개` : '',
    st.SCRAP ? `- 폐기: ${n0(st.SCRAP)}개` : '',
  ].filter(Boolean);
  const ex = ((im.examples ?? []) as Any[]).slice(0, 3).map((x) => `${x.serial}(${x.status ?? '−'})`);
  const rel = d.released ? `\n\n해제: ${d.released.t} ${d.released.by ?? ''} · ${d.released.result ?? ''} — ${d.released.note ?? ''}` : '';
  return `${head}\n\n영향 범위\n${rows.join('\n')}${ex.length ? `\n예: ${ex.join(', ')}` : ''}${rel}\n\n해제(다시 흘림)·폐기 판정은 /trace Hold 영역에서 품질 담당·관리자가 메모와 함께 합니다.`;
}

function lotBrief(d: Any): string {
  const s = d.byStatus ?? {};
  return `이 LOT를 쓴 부품은 ${n0(d.partsUsed)}개이고, 그 부품이 들어간 맨 위 제품은 ${n0(d.topProducts)}개입니다(완성 ${s.DONE ?? 0} · 공정 중 ${s.WIP ?? 0} · 불량 ${s.NG ?? 0}).`;
}

function changesText(d: Any): string {
  const pending = (d.faPending ?? []) as Any[];
  const c = d.changes;
  const recent = ((c?.recent ?? []) as Any[]).slice(0, 5).map((x) => `- ${x.t} ${x.station} ${x.category}·${x.kind}${x.detail ? `: ${x.detail}` : ''} (${x.source}, ${x.fa}${x.approved ? ', 승인' : ''})`);
  const foot = '\n\n변경점 신고는 /changes·작업자 태블릿에서, 승인(서명)은 초물 판정 뒤 /changes 에서 품질 담당이 합니다.';
  if (d.faRequired !== undefined) {
    const p = pending[0];
    const last = d.lastFirst ? `마지막 초물: ${d.lastFirst.t} ${d.lastFirst.serial} ${d.lastFirst.result}${d.lastFirst.change ? ` (${d.lastFirst.change})` : ''}.` : '이번 실행에서 이 설비의 초물 판정은 아직 없습니다.';
    if (p) {
      const x = p.items[0];
      const why = `원인은 ${x.since} ${x.category} 변경점(${x.kind}${x.detail ? `: ${x.detail}` : ''})입니다${x.status === '초물 불합격' ? '. 초물이 불합격해 다음 개체를 다시 초물로 기다리는 중입니다' : ''}.`;
      const effect = p.gate
        ? '게이트 설비라 초물이 합격할 때까지 인터록이 초물 개체 말고는 투입을 대기시킵니다(설비 사유 "MES 확인 대기").'
        : '게이트 설비가 아니라 투입을 막지는 않고, 다음 개체를 초물로 검사합니다.';
      return (
        `${josa(d.scope, ['은', '는'])} 초물 대기 ${p.count}건으로 ${dur(p.waitingMin)}째 기다리고 있습니다. ${why}\n\n${effect} ${last}\n\n` +
        '초물 개체가 나와 합격하면 풀립니다. 오래 걸리면 앞 공정에서 부품이 오는지(투입 대기), 초물 개체가 불량 처리 중인지 확인하세요.' +
        `${recent.length ? `\n\n최근 변경점\n${recent.join('\n')}` : ''}${foot}`
      );
    }
    return `${josa(d.scope, ['은', '는'])} 지금 초물 대기가 없습니다.${d.faRequired ? '' : ' (초물 검사 대상 설비가 아닙니다)'} ${last}${recent.length ? `\n\n최근 변경점\n${recent.join('\n')}` : ''}${foot}`;
  }
  const head = pending.length ? `${d.scope}에 초물을 기다리는 설비가 ${d.faPendingStations}대 있습니다.` : `${d.scope}에 지금 초물을 기다리는 설비는 없습니다.`;
  const list = pending.slice(0, 5).map((p) => {
    const x = p.items[0];
    return `- ${p.station} ${p.stationName ?? ''}: ${x.category}·${x.kind} 뒤 ${dur(p.waitingMin)}째${p.gate ? ' (투입 대기 중)' : ''}${x.status === '초물 불합격' ? ' · 초물 불합격' : ''}`;
  });
  const cats = Object.entries(c?.byCategory ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ');
  const sum = `\n\n최근 변경점 ${c?.recentCount ?? 0}건${cats ? `(${cats})` : ''} · 초물 불합격 ${c?.faNg ?? 0} · 승인 대기 ${c?.awaitingApproval ?? 0}`;
  const ins = d.inspections;
  const ng = ((ins?.recentNg ?? []) as Any[]).slice(0, 3).map((x) => `${x.t} ${x.station} ${x.type} ${x.serial}`);
  const insLine = ins ? `\n초·중·종물 최근 ${ins.recentCount}건 중 불합격 ${ins.ng}건${ng.length ? `: ${ng.join(', ')}` : ''}` : '';
  return `${head}${list.length ? `\n${list.join('\n')}` : ''}${sum}${insLine}${recent.length ? `\n\n최근 변경점\n${recent.join('\n')}` : ''}${foot}`;
}

function controlPlanText(d: Any): string {
  const counts = ((d.counts ?? []) as Any[]).map((c) => `${c.line}(${c.docNo}) ${c.rows}항목 · ◆ ${c.cc} · ▲ ${c.sc}`).join(', ');
  if (d.safetyCritical) {
    const rows = (d.safetyCritical as Any[]).slice(0, 8).map((r) => `- ${r.no} ${r.station} ${r.name}: ${r.spec} · ${r.evaluation}`);
    return `관리계획서는 공장 정의에서 자동으로 만듭니다. ${counts}.\n\n법규·안전 특별 특성(◆)\n${rows.join('\n')}\n\n설비나 라인 이름을 넣어 물으면 그 공정의 관리 항목을 보여 줍니다. 인쇄용 표는 /control-plan 에 있습니다.`;
  }
  const rows = (d.rows ?? []) as Any[];
  if (!rows.length) return `${d.scope}${d.query ? `에서 '${d.query}'` : ''}에 맞는 관리 항목이 없습니다. 인쇄용 표는 /control-plan 에 있습니다.`;
  const table = rows
    .slice(0, 8)
    .map((r) => `| ${r.no} | ${r.special ? `${String(r.special).slice(0, 1)} ` : ''}${cell(r.name)} (${r.char}) | ${cell(r.spec)} | ${cell(r.evaluation)} · ${cell(r.frequency)} | ${cell(r.controls)} |`);
  const key = rows.find((r) => r.special) ?? rows[0];
  const shown = Math.min(8, rows.length);
  return (
    `${d.scope} 관리계획서${d.query ? `에서 '${d.query}'에 맞는` : ''} 항목은 ${d.matched}개입니다${d.matched > shown ? ` (앞 ${shown}개만 표로 보입니다)` : ''}.\n\n| 번호 | 특성 | 규격 | 방법·주기 | 관리 방법 |\n|---|---|---|---|---|\n${table.join('\n')}` +
    `\n\n이상 시 조치(${key.no} ${key.name}): ${(key.reactions as string[]).join(' / ')}` +
    `${key.special ? `\n특별 특성: ${key.special}` : ''}\n\n인쇄용 표는 /control-plan 에 있습니다.`
  );
}

function shiftText(d: Any): string {
  const t = d.totals;
  const lines = (d.lines ?? []) as Any[];
  const head = `${d.shift} 교대${d.inProgress ? '(진행 중, 지금까지)' : ''} 실적입니다 (${d.period}). 생산 OK ${n0(t.ok)}개 · 불량 ${n0(t.ng)} · 폐기 ${n0(t.scrap)} · 전력 ${n0(t.kwh)} kWh.`;
  const table = `| 라인 | 목표 | 생산 OK | 달성 | 불량 | 직행률 | OEE |\n|---|---|---|---|---|---|---|\n${lines
    .map((l) => `| ${l.name} | ${n0(l.target)} | ${n0(l.ok)} | ${l.achievementPct ?? '−'}% | ${n0(l.ng)} | ${l.fpyPct ?? '−'}% | ${l.oee ? `${l.oee.oeePct}%` : '−'} |`)
    .join('\n')}`;
  const notes = lines.map((l) => {
    const dt = l.downtimeTop?.[0];
    const df = l.defectsTop?.[0];
    const parts = [
      dt ? `비가동 1위 ${dt.state} ${dt.reason} ${dur(dt.minutes)}` : '',
      df ? `불량 1위 ${df.name} ${df.count}` : '',
      `NCR 발생 ${l.ncr.opened}·종결 ${l.ncr.closed}·미결 ${l.ncr.openAtEnd}`,
      `변경점 ${l.changes.total}${l.changes.faNg ? `(초물 불합격 ${l.changes.faNg})` : ''}`,
      l.interlock.ng ? `인터록 거부 ${l.interlock.ng}${l.interlock.topReject ? `(${l.interlock.topReject})` : ''}` : '',
    ].filter(Boolean);
    return `- ${l.name}: ${parts.join(' · ')}`;
  });
  return `${head}\n\n${table}\n\n${notes.join('\n')}\n\n목표는 교대 시간 ÷ 택트(계획 정지 포함한 상한)입니다. 인쇄·CSV는 교대 일보 화면(/reports)에서 받을 수 있습니다.`;
}

function energyText(d: Any): string {
  const t = d.total;
  const top = (d.topStations ?? []) as Any[];
  const head = `${d.period.label}(${d.period.from} ~ ${d.period.to}) ${d.scope} 전력량은 ${n0(t.kwh)} kWh입니다(추정). 가동 ${n0(t.run)} · 대기 ${n0(t.idle)} · 정지 ${n0(t.off)} kWh, 대기 전력 비중 ${t.idleSharePct ?? '−'}%.`;
  if (!top.length) return `${head}\n\n아직 집계된 설비가 없습니다.`;
  const lead = `가장 많이 쓴 설비는 ${top[0].station} ${top[0].name ?? ''}(${n0(top[0].kwh)} kWh, 대기 비중 ${top[0].idleSharePct ?? '−'}%)입니다.`;
  const table = `| 설비 | kWh | 가동 | 대기 | 정지 | 개당 kWh |\n|---|---|---|---|---|---|\n${top
    .slice(0, 5)
    .map((s) => `| ${s.station} ${cell(s.name)} | ${n0(s.kwh)} | ${n0(s.run)} | ${n0(s.idle)} | ${n0(s.off)} | ${s.perUnitKwh ?? '−'} |`)
    .join('\n')}`;
  const per = ((d.lines ?? []) as Any[]).map((l) => `${l.name} ${l.perUnitKwh ?? '−'} kWh`).join(', ');
  const idle = ((d.topIdle ?? []) as Any[]).slice(0, 3).map((s) => `${s.station} ${n0(s.idleKwh)} kWh(대기 ${s.idleHours}시간)`);
  return (
    `${head}\n\n${lead}\n\n${table}` +
    `${per ? `\n\n완성품 개당: ${per}` : ''}${idle.length ? `\n대기 전력이 큰 설비: ${idle.join(', ')}` : ''}` +
    '\n\n상태 시간 × 정격 소비 전력으로 낸 추정값이라 실측과 다를 수 있습니다. 시간대별 추이는 /energy 에서 볼 수 있습니다.'
  );
}

function healthText(d: Any, one: boolean): string {
  const list = (d.stations ?? []) as Any[];
  const foot = '\n\n보전 실시는 /maintenance 예지 보전 영역에서 보전 담당이 합니다. 남은 수명은 직선 추세라 마모가 빨라지는 끝 무렵에는 실제보다 길게 나올 수 있습니다.';
  if (one && list[0]) {
    const s = list[0];
    if (s.vibMmS == null) return `${s.station} ${s.name ?? ''}의 가동 중 진동 표본이 아직 없어 등급을 내지 못했습니다(표본 ${s.samples}개).${foot}`;
    const advice = String(s.level).startsWith('위험')
      ? '손상이 우려되는 구간입니다. 바로 보전을 검토하세요.'
      : String(s.level).startsWith('경고')
        ? '장기 운전에 맞지 않는 구간입니다. 보전 계획을 잡으세요.'
        : '지금은 운전에 문제없는 수준입니다.';
    const r = s.rul;
    const slope = r ? `(가상 시간, 진동 증가 ${r.slopePerH} mm/s/시간)` : '';
    const rul = !r
      ? `남은 수명은 아직 추정하지 않습니다: ${s.rulNote}.`
      : r.toDangerH <= 0
        ? `진동이 이미 위험 기준을 넘었습니다${slope}.`
        : r.toWarnH <= 0
          ? `경고 기준은 이미 넘었고, 추세대로면 위험까지 ${hours(r.toDangerH)}입니다${slope}.`
          : `추세대로면 경고까지 ${hours(r.toWarnH)}, 위험까지 ${hours(r.toDangerH)}입니다${slope}.`;
    return (
      `${s.station} ${josa(s.name ?? s.station, ['은', '는'])} 진동 ${s.vibMmS} mm/s로 ${s.level}입니다 (정상 ${s.normalVib}, 경고 ${s.warnAt}, 위험 ${s.dangerAt} mm/s). ${advice}\n\n` +
      `건강 지수 ${s.healthIndexPct ?? '−'}% · 전류 정상 대비 ${s.currentVsNormalPct ?? '−'}% · 온도 +${s.tempRiseC ?? '−'}℃\n${rul}\n마지막 보전: ${s.lastMaint} · 닳는 부위: ${s.part}${foot}`
    );
  }
  const levels = Object.entries(d.byLevel ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ');
  const bad = list.filter((s) => !String(s.level).startsWith('양호')).slice(0, 5);
  const rows = bad.map(
    (s) => `- ${s.station} ${s.name ?? ''}: ${s.level}, ${s.vibMmS == null ? '진동 표본 없음' : `진동 ${s.vibMmS} mm/s`}${s.rul && s.rul.toWarnH > 0 ? `, 경고까지 ${hours(s.rul.toWarnH)}` : ''}`,
  );
  return `상태 감시 설비 ${d.monitored}대: ${levels || '자료 없음'}.${rows.length ? `\n\n살펴볼 설비\n${rows.join('\n')}` : '\n\n모두 양호합니다.'}${foot}`;
}
