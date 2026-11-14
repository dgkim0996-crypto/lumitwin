'use client';

import { cx, num } from '@/lib/format';
import { outOfSpec, valueSpec } from '@/lib/quality-system';

/** 초·중·종물 검사 값: 검사 측정값을 먼저, 그다음 사이클 태그. 규격을 벗어난 값은 빨갛게 + 글자로 표시 */
export function InspectionValues({ station, values }: { station: string; values: Record<string, number> }) {
  const rows = Object.entries(values)
    .map(([key, v]) => ({ key, v, s: valueSpec(station, key) }))
    .sort((a, b) => Number(b.s.measure) - Number(a.s.measure));
  if (!rows.length) return <div className="text-xs text-dim">기록된 값이 없습니다</div>;
  return (
    <table className="w-full text-xs">
      <thead className="text-dim">
        <tr>
          <th className="px-2 py-1 text-left font-normal">항목</th>
          <th className="px-2 py-1 text-right font-normal">값</th>
          <th className="px-2 py-1 text-right font-normal">규격</th>
          <th className="px-2 py-1 text-left font-normal">판정</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, v, s }) => {
          const out = outOfSpec(v, s);
          const spec = s.lsl != null && s.usl != null ? `${s.lsl} ~ ${s.usl}` : s.usl != null ? `≤ ${s.usl}` : s.lsl != null ? `≥ ${s.lsl}` : '-';
          return (
            <tr key={key} className="border-t border-line/60">
              <td className="px-2 py-1">
                {s.name} <span className="text-dim">{s.measure ? '검사값' : '공정값'}</span>
              </td>
              <td className={cx('num px-2 py-1 text-right', out && 'font-semibold text-down')}>
                {num(v, s.digits)} <span className="text-dim">{s.unit}</span>
              </td>
              <td className="num px-2 py-1 text-right text-sub">{spec}</td>
              <td className={cx('px-2 py-1', out ? 'text-down' : 'text-sub')}>{s.lsl == null && s.usl == null ? '기록' : out ? '규격 밖' : '규격 안'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
