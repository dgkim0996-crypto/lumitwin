'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { WHATIF_DEFAULTS, whatIfBudgetH, type LineCode, type WhatIfBase, type WhatIfBaseSource, type WhatIfRequest } from '@lumitwin/shared';
import { Empty } from '@/components/charts/kit';
import { PageShell } from '@/components/mes/PageShell';
import { BaseCard } from '@/components/whatif/BaseCard';
import { PlanEditor } from '@/components/whatif/PlanEditor';
import { RunResult } from '@/components/whatif/Results';
import { RunList } from '@/components/whatif/RunList';
import { RunSettings } from '@/components/whatif/RunSettings';
import { ApiError } from '@/lib/api';
import { rolesFor, useGate } from '@/lib/auth';
import { errText } from '@/lib/execution';
import {
  WHATIF_KEYS,
  emptyLine,
  lineDiff,
  planFromBase,
  planProblems,
  toScenarioInput,
  useWhatIfBase,
  useWhatIfRun,
  useWhatIfRuns,
  useWhatIfStart,
  type DraftPlan,
  type Dues,
} from '@/lib/whatif';

/** 실행 요청이 막혔을 때 한국어 안내 (서버 문구는 그대로 붙인다) */
function runErrorText(e: unknown, readOnly: boolean): string {
  if (e instanceof ApiError) {
    if (e.status === 403 && (readOnly || /보기 전용/.test(e.message))) return '공개 링크는 보기 전용이라 실행할 수 없습니다. 저장된 결과만 볼 수 있습니다.';
    if (e.status === 403) return `실행 권한이 없습니다 (${rolesFor('whatif.run')}만 실행): ${e.message}`;
    if (e.status === 401) return `로그인이 필요합니다 (${rolesFor('whatif.run')} 계정으로 로그인하세요)`;
    if (e.status === 400) return `${e.message} · 미리 본 뒤 MES 작업지시가 바뀌었으면 기준 상태 '다시 읽기'를 눌러 보세요`;
  }
  return errText(e, '실행을 시작하지 못했습니다');
}

export default function WhatIfPage() {
  const qc = useQueryClient();
  const [source, setSource] = useState<WhatIfBaseSource>('live');
  const baseQ = useWhatIfBase(source);
  /** 계획 초안을 만든 기준 상태 (바꾼 점은 이것과 견준다) */
  const [refBase, setRefBase] = useState<WhatIfBase>();
  const [plans, setPlans] = useState<DraftPlan[] | null>(null);
  const [dues, setDues] = useState<Dues>({});
  const [horizonH, setHorizon] = useState<number>(WHATIF_DEFAULTS.horizonH);
  const [reps, setReps] = useState<number>(WHATIF_DEFAULTS.reps);
  const [selected, setSelected] = useState<number | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const gate = useGate('whatif.run');
  const runs = useWhatIfRuns(10);
  const run = useWhatIfRun(selected);
  const start = useWhatIfStart();
  const resultsRef = useRef<HTMLDivElement>(null);
  const autoPicked = useRef(false);

  // 첫 기준 상태를 받으면 '지금 계획'으로 첫 계획을 만든다
  useEffect(() => {
    if (baseQ.data && !plans) {
      setRefBase(baseQ.data);
      setPlans([planFromBase(baseQ.data)]);
    }
  }, [baseQ.data, plans]);

  // 들어오면 가장 최근 완료 결과를 한 번 불러온다 (보기 전용 방문자도 저장된 결과를 본다)
  useEffect(() => {
    if (autoPicked.current || selected != null || !runs.data) return;
    autoPicked.current = true;
    const r = runs.data.find((x) => x.status === 'DONE') ?? runs.data[0];
    if (r) setSelected(r.id);
  }, [runs.data, selected]);

  // 계산이 끝나면 목록(계획별 양품 평균)을 다시 부른다
  const status = run.data?.status;
  useEffect(() => {
    if (status === 'DONE' || status === 'FAILED') void qc.invalidateQueries({ queryKey: WHATIF_KEYS.runs });
  }, [status, qc]);

  const request = useMemo<WhatIfRequest | null>(
    () => (plans ? { horizonH, reps, base: source, scenarios: plans.map((p) => toScenarioInput(p, refBase, dues)) } : null),
    [plans, horizonH, reps, source, refBase, dues],
  );
  const problems = useMemo(() => (plans ?? []).flatMap((p, i) => planProblems(p, i, horizonH, dues)), [plans, horizonH, dues]);
  const budget = whatIfBudgetH({ horizonH, reps, scenarios: request?.scenarios ?? [] });

  /** 기준 상태 다시 읽기: 계획마다 작업지시 순서를 새 지금 계획으로 되돌린다 (이름·사건·자동 채우기·납기는 둔다) */
  const reload = async () => {
    const touched = plans?.some((p) => (Object.keys(p.orders) as LineCode[]).some((l) => lineDiff(refBase?.lines?.[l] ?? emptyLine, p.orders[l]).count > 0));
    if (touched && !window.confirm('기준 상태를 다시 읽으면 계획마다 고친 작업지시 순서를 새 지금 계획으로 되돌립니다 (사건은 그대로). 계속할까요?')) return;
    setReloading(true);
    try {
      const r = await baseQ.refetch();
      if (r.data) {
        const b = r.data;
        setRefBase(b);
        setPlans((ps) => (ps ? ps.map((p) => ({ ...planFromBase(b, p.name), key: p.key, events: p.events, autoFill: p.autoFill })) : [planFromBase(b)]));
      }
    } finally {
      setReloading(false);
    }
  };

  const onRun = () => {
    if (!request) return;
    setRunErr(null);
    start.mutate(request, {
      onSuccess: (v) => {
        setSelected(v.id);
        requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      },
      onError: (e) => setRunErr(runErrorText(e, gate.readOnly)),
    });
  };

  return (
    <PageShell
      title="What-if 계획 시뮬레이션"
      desc={
        <>
          지금 공장 상태(작업지시·재공·고장·보전·마모·공정 이상)를 복사해 계획 몇 개를 시뮬레이터로 여러 번 돌리고, 생산량·납기·OEE·에너지를 분포(평균과 10~90 백분위)로 비교합니다. 작업지시 화면의 예상
          시작·끝은 투입 간격 × 수량 + 셋업으로 낸 계산식 예상이라 고장·불량·수리·막힘을 모릅니다. 여기서는 같은 계획을 이산 사건 시뮬레이션으로 돌려 그 빈틈을 봅니다.
        </>
      }
    >
      <div className="grid gap-3 @6xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <BaseCard
          source={source}
          onSource={setSource}
          base={baseQ.data}
          loading={baseQ.isPending || (baseQ.isFetching && !baseQ.data)}
          error={baseQ.error ? errText(baseQ.error, '기준 상태를 읽지 못했습니다') : null}
          onReload={reload}
          reloading={reloading}
        />
        <RunList
          runs={runs.data ?? []}
          loading={runs.isPending}
          error={runs.error}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
          }}
        />
      </div>

      <div className="mt-3">
        <PlanEditor base={refBase} plans={plans} setPlans={setPlans} dues={dues} setDues={setDues} horizonH={horizonH} />
      </div>

      <div className="mt-3">
        <RunSettings
          horizonH={horizonH}
          setHorizon={setHorizon}
          reps={reps}
          setReps={setReps}
          plans={plans?.length ?? 0}
          budget={budget}
          problems={problems}
          gate={gate}
          ready={!!plans && !!baseQ.data}
          pending={start.isPending}
          error={runErr}
          onRun={onRun}
        />
      </div>

      <div ref={resultsRef} className="mt-3 scroll-mt-3">
        {selected == null ? (
          <section className="card p-4">
            <Empty h={100}>{runs.isPending ? '불러오는 중…' : '아직 결과가 없습니다. 계획을 고치고 시뮬레이션을 실행하면 결과가 여기에 나옵니다.'}</Empty>
          </section>
        ) : run.data ? (
          <RunResult run={run.data} />
        ) : (
          <section className="card p-4">
            <Empty h={100}>{run.isPending ? '결과를 불러오는 중…' : errText(run.error, '결과를 불러오지 못했습니다')}</Empty>
          </section>
        )}
      </div>
    </PageShell>
  );
}
