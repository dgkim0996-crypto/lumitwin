'use client';

import { WHATIF_LIMITS } from '@lumitwin/shared';
import { C } from '@/components/charts/kit';
import { Meter } from '@/components/charts/small';
import { rolesFor } from '@/lib/auth';
import { cx } from '@/lib/format';
import { HORIZON_OPTIONS, REPS_OPTIONS } from '@/lib/whatif';

function Choice<T extends number>({ label, items, value, onChange, unit, testid }: { label: string; items: readonly T[]; value: T; onChange: (v: T) => void; unit: string; testid: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-sub">{label}</span>
      <div role="group" aria-label={label} className="flex overflow-hidden rounded border border-line text-xs">
        {items.map((v) => (
          <button
            key={v}
            type="button"
            data-testid={testid}
            data-value={v}
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={cx('num px-2.5 py-1', value === v ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}
          >
            {v}
            {unit}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 실행 설정: 내다볼 시간·반복 횟수, 가상 시간 총량(한도), 실행 버튼(권한·검증으로 막는다) */
export function RunSettings({
  horizonH,
  setHorizon,
  reps,
  setReps,
  plans,
  budget,
  problems,
  gate,
  ready,
  pending,
  error,
  onRun,
}: {
  horizonH: number;
  setHorizon: (h: number) => void;
  reps: number;
  setReps: (r: number) => void;
  plans: number;
  budget: number;
  problems: string[];
  gate: { ok: boolean; title?: string; readOnly: boolean };
  /** 기준 상태와 계획이 준비됐나 */
  ready: boolean;
  pending: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const over = budget > WHATIF_LIMITS.budgetH;
  const blocked = !gate.ok || !ready || over || problems.length > 0 || pending;
  const why = !gate.ok
    ? gate.title
    : !ready
      ? '기준 상태를 읽는 중입니다'
      : over
        ? `가상 시간 총량이 한도(${WHATIF_LIMITS.budgetH}시간)를 넘습니다`
        : problems.length
          ? problems[0]
          : undefined;

  return (
    <section className="card min-w-0 p-4" data-testid="whatif-settings">
      <header className="mb-3">
        <h2 className="text-sm font-semibold">실행 설정</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-sub">
          계획마다 같은 난수 씨앗 목록으로 반복합니다(공통 난수). 계획끼리 고장 시각·불량 운이 같아서, 차이는 운이 아니라 계획에서 나옵니다. 반복이 많을수록 분포(10~90 백분위)가 믿을 만해지고
          오래 걸립니다.
        </p>
      </header>
      <div className="flex flex-col gap-2 @4xl:flex-row @4xl:flex-wrap @4xl:items-center @4xl:gap-x-6">
        <Choice label="시간" items={HORIZON_OPTIONS} value={horizonH as (typeof HORIZON_OPTIONS)[number]} onChange={setHorizon} unit="시간" testid="whatif-horizon" />
        <Choice label="반복" items={REPS_OPTIONS} value={reps as (typeof REPS_OPTIONS)[number]} onChange={setReps} unit="회" testid="whatif-reps" />
        <div className="min-w-0 flex-1 @4xl:max-w-sm">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-sub">가상 시간 총량</span>
            <span className={cx('num', over ? 'font-semibold text-down' : 'text-ink')}>
              {budget} / {WHATIF_LIMITS.budgetH}시간
            </span>
          </div>
          <div className="mt-1">
            <Meter value={budget / WHATIF_LIMITS.budgetH} color={over ? C.ng : C.series} />
          </div>
          <div className="mt-0.5 text-[11px] text-dim">
            계획 {plans} × 반복 {reps} × {horizonH}시간{over ? ' · 한도를 넘습니다: 반복이나 시간을 줄이세요' : ''}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="whatif-run"
          onClick={onRun}
          disabled={blocked}
          title={why}
          className="h-9 rounded-md border border-info/50 bg-info/15 px-4 text-sm font-medium hover:bg-info/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? '보내는 중…' : '시뮬레이션 실행'}
        </button>
        {!gate.ok && (
          <span className="text-xs text-sub">
            {gate.readOnly ? '공개 링크는 보기 전용입니다. 저장된 결과만 볼 수 있습니다.' : `${rolesFor('whatif.run')}만 실행할 수 있습니다.`}
            {gate.title && !gate.readOnly && <span className="ml-1 text-dim">({gate.title})</span>}
          </span>
        )}
        {gate.ok && <span className="text-[11px] text-dim">계산은 서버에서 한 번에 1건씩 돕니다. 앞 실행이 있으면 끝난 뒤 시작합니다.</span>}
      </div>

      {gate.ok && problems.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-down">
          {problems.slice(0, 4).map((p) => (
            <li key={p}>{p}</li>
          ))}
          {problems.length > 4 && <li className="text-dim">외 {problems.length - 4}건</li>}
        </ul>
      )}
      {error && (
        <div role="alert" className="mt-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-ink">
          {error}
        </div>
      )}
    </section>
  );
}
