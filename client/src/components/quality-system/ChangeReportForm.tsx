'use client';

import { useEffect, useState } from 'react';
import {
  CHANGE_DETAIL_MAX,
  CHANGE_KIND_NAMES,
  CHANGE_PRESETS,
  LINES,
  STATIONS,
  faRequired,
  type ChangeCategory,
  type ChangePointView,
  type ChangeUserKind,
} from '@lumitwin/shared';
import { useGate } from '@/lib/auth';
import { cx, kst } from '@/lib/format';
import { CATEGORY_COLOR, CATEGORY_ORDER, CATEGORY_SHORT, useRegisterChange } from '@/lib/quality-system';

const CATEGORY_HINT: Record<ChangeCategory, string> = {
  MAN: '작업자가 바뀌었다',
  MACHINE: '설비·지그·공구를 바꾸거나 고쳤다',
  MATERIAL: '자재·LOT·협력사가 바뀌었다',
  METHOD: '조건·표준·검사 방법이 바뀌었다',
};

/**
 * 4M 변경점 신고 양식. 작업자 태블릿(size lg: 큰 터치 버튼)과 변경점 화면(md)이 같이 쓴다.
 * station을 주면 그 설비로 고정한다 (태블릿은 설비 한 대 앞에 붙어 있다)
 */
export function ChangeReportForm({ station: fixed, size = 'md', onDone }: { station?: string; size?: 'lg' | 'md'; onDone?: (v: ChangePointView) => void }) {
  const lg = size === 'lg';
  // 보기 전용 → 로그인 → 권한 순으로 판단한다 (서버 @Perm('change.register')와 같은 기준)
  const gate = useGate('change.register');
  const reg = useRegisterChange();
  const [station, setStation] = useState(fixed ?? '');
  const [category, setCategory] = useState<ChangeCategory | null>(null);
  const [kind, setKind] = useState<ChangeUserKind>('user');
  const [detail, setDetail] = useState('');
  const [fa, setFa] = useState(true);
  const [done, setDone] = useState<ChangePointView | null>(null);
  const def = STATIONS[station];

  // 설비를 바꾸면 초물 필요 기본값을 그 설비 기준으로 (인터록 게이트·측정 설비 = 초물 대상)
  useEffect(() => {
    if (fixed) setStation(fixed);
  }, [fixed]);
  useEffect(() => {
    if (def) setFa(faRequired(def));
  }, [def]);

  const blocked = gate.ok ? undefined : (gate.title ?? '변경점 신고 권한이 없습니다');
  const ready = !!def && !!category && detail.trim().length > 0;
  const submit = () => {
    if (!ready || blocked || !category) return;
    reg.mutate(
      { station, category, detail: detail.trim(), fa, kind: category === 'METHOD' ? kind : 'user' },
      {
        onSuccess: (v) => {
          setDone(v);
          setDetail('');
          setCategory(null);
          setKind('user');
          onDone?.(v);
        },
      },
    );
  };

  const label = cx(lg ? 'text-sm' : 'text-xs', 'text-sub');
  return (
    <div className={cx('flex flex-col', lg ? 'gap-3' : 'gap-2.5')}>
      {!fixed && (
        <label className="flex flex-col gap-1">
          <span className={label}>설비</span>
          <select
            value={station}
            onChange={(e) => setStation(e.target.value)}
            className="h-9 rounded-md border border-line bg-[var(--color-panel-solid)] px-2 text-sm outline-none focus:border-info/60"
          >
            <option value="">설비를 고르세요</option>
            {LINES.map((l) => (
              <optgroup key={l.code} label={l.name}>
                {l.stations.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      <div>
        <div className={label}>무엇이 바뀌었나요 (4M)</div>
        <div className={cx('mt-1 grid gap-2', lg ? 'grid-cols-2' : 'grid-cols-2 @lg:grid-cols-4')} role="radiogroup" aria-label="4M 분류">
          {CATEGORY_ORDER.map((c) => {
            const on = category === c;
            return (
              <button
                key={c}
                role="radio"
                aria-checked={on}
                onClick={() => setCategory(c)}
                className={cx(
                  'flex flex-col items-start justify-center rounded-xl border px-3 text-left',
                  lg ? 'min-h-16' : 'min-h-11 rounded-md py-1',
                  on ? 'border-info/60 bg-info/15' : 'border-line bg-white/[0.03] hover:bg-white/[0.07]',
                )}
              >
                <span className={cx('flex items-center gap-2 font-semibold', lg ? 'text-lg' : 'text-sm')}>
                  <span className="size-2.5 rounded-full" style={{ background: CATEGORY_COLOR[c] }} />
                  {CATEGORY_SHORT[c]}
                </span>
                <span className={cx('text-sub', lg ? 'text-xs' : 'text-[11px]')}>{CATEGORY_HINT[c]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {category && (
        <div>
          <div className={label}>자주 쓰는 내용</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {CHANGE_PRESETS[category].map((p) => (
              <button
                key={p}
                onClick={() => setDetail(p)}
                className={cx('rounded-lg border border-line bg-white/[0.03] px-3 hover:bg-white/[0.08]', lg ? 'min-h-12 text-base' : 'min-h-8 text-xs')}
              >
                {p}
              </button>
            ))}
          </div>
          {category === 'METHOD' && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className={label}>종류</span>
              {(['user', 'condition'] as const).map((k) => (
                <button
                  key={k}
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={cx('rounded-lg border px-3', lg ? 'min-h-12 text-base' : 'min-h-8 text-xs', kind === k ? 'border-info/60 bg-info/15 text-info' : 'border-line text-sub')}
                >
                  {CHANGE_KIND_NAMES[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className={label}>
          변경 내용 <span className="text-dim">({detail.length}/{CHANGE_DETAIL_MAX})</span>
        </span>
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value.slice(0, CHANGE_DETAIL_MAX))}
          rows={lg ? 2 : 2}
          placeholder="예: 도포 노즐 교체 (마모), 신규 작업자 김○○ 투입"
          className={cx('resize-none rounded-xl border border-line bg-white/[0.04] px-3 py-2 outline-none placeholder:text-dim focus:border-info/60', lg ? 'text-base' : 'rounded-md text-sm')}
        />
      </label>

      <label className={cx('flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3', lg ? 'min-h-14 text-base' : 'min-h-10 rounded-md text-sm')}>
        <input type="checkbox" checked={fa} onChange={(e) => setFa(e.target.checked)} className={cx('accent-[#f5b544]', lg ? 'size-6' : 'size-4')} />
        <span>
          초물 검사 필요
          <span className={cx('block text-sub', lg ? 'text-xs' : 'text-[11px]')}>
            {def?.gate
              ? '다음 개체가 초물이 됩니다. 초물이 합격할 때까지 이 설비의 다음 투입은 대기합니다 (인터록)'
              : '다음 개체를 초물로 검사해 기록합니다'}
            {def && !faRequired(def) && ' · 이 설비는 평소 초물 대상이 아닙니다'}
          </span>
        </span>
      </label>

      <button
        disabled={!ready || !!blocked || reg.isPending}
        title={blocked ?? (!ready ? '설비·분류·내용을 채우세요' : undefined)}
        onClick={submit}
        className={cx('rounded-xl border border-warn/50 bg-warn/20 font-semibold text-warn disabled:opacity-40', lg ? 'h-16 text-xl' : 'h-10 rounded-md text-sm')}
      >
        {reg.isPending ? '신고하는 중…' : blocked && !gate.readOnly ? '변경점 신고 (권한 없음)' : '변경점 신고'}
      </button>
      {reg.error && <div className="text-sm text-down">{(reg.error as Error).message}</div>}
      {done && (
        <div className={cx('rounded-lg bg-run/15 px-3 py-2 text-run', lg ? 'text-base' : 'text-xs')}>
          {kst(done.at)}에 <span className="num">{done.simId}</span>로 등록했습니다
          {done.faStatus === 'PENDING' ? ' · 초물 검사 대기' : ' · 초물 대상 아님'}
        </div>
      )}
    </div>
  );
}
