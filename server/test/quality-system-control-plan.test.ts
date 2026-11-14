import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LINES, SPECIAL_RULES, buildControlPlan, defectOrigin, faRequired, specText, specialOf } from '@lumitwin/shared';

describe('관리계획서', () => {
  const cp = buildControlPlan();

  it('라인마다 공정 순서대로 행을 만들고, 행 번호·ID가 겹치지 않는다', () => {
    assert.deepEqual(cp.lines.map((l) => l.line), LINES.map((l) => l.code));
    for (const l of cp.lines) {
      assert.ok(l.rows.length > 0);
      assert.equal(new Set(l.rows.map((r) => r.id)).size, l.rows.length, `${l.line} ID 중복`);
      assert.equal(new Set(l.rows.map((r) => r.no)).size, l.rows.length, `${l.line} 번호 중복`);
      const ops = l.rows.map((r) => r.opNo);
      assert.deepEqual(ops, [...ops].sort((a, b) => a - b), `${l.line} 공정 순서`);
      assert.equal(l.counts.product + l.counts.process, l.rows.length);
    }
  });

  it('규격 있는 태그는 모두 공정 특성, 측정값은 모두 제품 특성(전수 자동 검사 + SPC)으로 들어간다', () => {
    const rows = cp.lines.flatMap((l) => l.rows);
    for (const line of LINES) {
      for (const st of line.stations) {
        for (const t of st.tags.filter((x) => x.lsl != null || x.usl != null)) {
          const r = rows.find((x) => x.station === st.code && x.key === t.key && x.source.startsWith('tag'));
          assert.ok(r, `${st.code}.${t.key}`);
          assert.equal(r.charKind, 'process');
          assert.equal(r.evalCode, t.mode === 'continuous' ? 'sensor' : 'cycle');
        }
        for (const m of st.measures ?? []) {
          const r = rows.find((x) => x.station === st.code && x.key === m.key && x.source === 'measure');
          assert.ok(r, `${st.code}.${m.key}`);
          assert.equal(r.charKind, 'product');
          assert.equal(r.evalCode, 'auto100');
          assert.ok(r.controls.some((c) => c.includes('X̄-R')));
        }
        assert.equal(rows.some((x) => x.station === st.code && x.source === 'fa'), faRequired(st), `${st.code} 초·중·종물`);
        assert.equal(rows.some((x) => x.station === st.code && x.source === 'gate'), !!st.gate, `${st.code} 인터록`);
      }
    }
    assert.ok(!rows.some((r) => r.source === 'tag-cycle' && r.key === 'label_ok'), '규격 없는 태그는 넣지 않는다');
  });

  it('특별 특성: 배광은 법규(◆), 기밀·체결 토크는 핵심 기능(▲). 근거와 등급을 함께 단다', () => {
    const hl = cp.lines.find((l) => l.line === 'HL')!;
    const row = (station: string, key: string) => hl.rows.find((r) => r.station === station && r.key === key)!;
    assert.equal(row('HL-PH-01', 'aim_v').special?.symbol, '◆');
    assert.equal(row('HL-LT-01', 'leak_drop').special?.symbol, '▲');
    assert.equal(row('HL-AS-01', 'screw_torque').special?.type, 'SC');
    assert.equal(row('HL-IM-L1', 'melt_temp').special, null);
    for (const r of cp.lines.flatMap((l) => l.rows).filter((x) => x.special)) {
      assert.ok(r.special!.reason.length > 10, `${r.id} 근거`);
      assert.ok(['confirmed', 'weak', 'assumed'].includes(r.special!.grade));
    }
    // ◆는 이탈 시 정지·출하 보류, ▲(공정값)은 공정능력 관리가 붙는다
    assert.match(row('HL-PH-01', 'aim_v').reactions[0], /정지/);
    assert.ok(row('HL-LT-01', 'leak_drop').controls.some((c) => c.includes('Cpk')));
    // 라인을 좁힌 규칙이 이긴다: 코팅 두께는 헤드램프·BMS에서 근거가 다르다
    assert.notEqual(specialOf('HL', 'HL-HC-01', 'tag-cycle', 'coat_thick')?.reason, specialOf('EM', 'EM-CC-B', 'tag-cycle', 'coat_thick')?.reason);
    assert.ok(SPECIAL_RULES.every((r) => r.reason && r.grade));
  });

  it('검출 불량은 입력을 거슬러 발생 공정을 찾는다 (다른 라인에서 이송된 LED 모듈 포함)', () => {
    assert.equal(defectOrigin('HL', 'EOL', 'COLD')?.code, 'EM-RF-L', '헤드램프 EOL 냉납 ← 전장 LED 리플로우');
    assert.equal(defectOrigin('EM', 'BMS_AOI', 'COLD')?.code, 'EM-RF-B', 'BMS AOI 냉납 ← BMS 리플로우');
    assert.equal(defectOrigin('HL', 'EOL', 'CONN')?.code, 'HL-AS-01');
    assert.equal(defectOrigin('HL', 'EOL', 'NOPE'), null);
    const eol = cp.lines.find((l) => l.line === 'HL')!.rows.find((r) => r.station === 'HL-EOL-01' && r.key === 'COLD')!;
    assert.equal(eol.name, '냉납 없음');
    assert.ok(eol.reactions.some((x) => x.includes('EM-RF-L')));
  });

  it('불량 처리: 제품 경로 밖은 폐기, 검사 공정은 수리 뒤 재검사', () => {
    const rows = cp.lines.flatMap((l) => l.rows);
    assert.match(rows.find((r) => r.station === 'HL-IM-L1' && r.key === 'WELD')!.reactions[0], /폐기/);
    assert.match(rows.find((r) => r.station === 'HL-LT-01' && r.key === 'leak_drop')!.reactions.join(' '), /수리 .*재검사/);
  });

  it('규격 글', () => {
    assert.equal(specText(4.5, 12, 'µm', 8), '4.5 ~ 12 µm · 기준 8');
    assert.equal(specText(undefined, 1000, 'Pa'), '≤ 1000 Pa');
    assert.equal(specText(32, undefined, 'kcd'), '≥ 32 kcd');
  });
});
