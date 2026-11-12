'use client';

import { useMutation } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AccessBadge } from '@/components/hud/AccessBadge';
import { NavTabs } from '@/components/nav/NavTabs';
import { FACTORY, LINES, SIM_SPEEDS, type SimCommand } from '@lumitwin/shared';
import { READ_ONLY_TITLE, useAccess } from '@/lib/access';
import { simCommand } from '@/lib/api';
import { cx, duration, kst } from '@/lib/format';
import { useAssistant } from '@/lib/assistant';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';

function useSim() {
  return useMutation({ mutationFn: (cmd: SimCommand) => simCommand(cmd) });
}

function Dot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-sub" title={label}>
      <span className={cx('size-2 rounded-full', on ? 'bg-run' : 'bg-down blink')} />
      {/* 2xl 미만에서는 점만 보이고 글자는 화면 읽기 프로그램용으로 남긴다 */}
      <span className="sr-only 2xl:not-sr-only">{label}</span>
    </span>
  );
}

/** 시나리오(이상 주입) 메뉴: 라인별로 묶고, 켜진 것은 진행 정도를 보여 준다 */
function ScenarioMenu() {
  const [open, setOpen] = useState(false);
  const sim = useLive((s) => s.sim);
  const send = useSim();
  const { readOnly } = useAccess();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const active = new Map((sim?.scenarios ?? []).map((s) => [s.id, s]));
  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cx('h-8 rounded-md border px-1.5 text-sm xl:px-3', active.size ? 'border-warn/60 bg-warn/15 text-warn' : 'border-line bg-white/5 hover:bg-white/10')}
      >
        <span className="hidden 2xl:inline">이상 </span>시나리오{active.size ? ` · ${active.size}개` : ''}
      </button>
      {open && (
        <div className="panel scroll-thin absolute right-0 top-10 z-50 max-h-[70vh] w-[440px] overflow-y-auto p-3">
          <p className="mb-2 text-xs leading-relaxed text-sub">
            설비 상태를 서서히 바꿔 불량이 생기게 합니다. 증상(알람·불량·SPC)을 보고 원인 설비를 찾아가는 시연용입니다.
            {readOnly && <span className="text-warn"> 공개 링크에서는 켜고 끌 수 없습니다.</span>}
          </p>
          {LINES.map((l) => (
            <div key={l.code} className="mb-2">
              <div className="mb-1 text-xs font-semibold" style={{ color: l.color }}>
                {l.name}
              </div>
              {FACTORY.scenarios
                .filter((s) => s.line === l.code)
                .map((s) => {
                  const a = active.get(s.id);
                  return (
                    <div key={s.id} className={cx('mb-1 rounded-md border p-2', a ? 'border-warn/50 bg-warn/10' : 'border-line bg-white/[0.03]')}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium">{s.name}</div>
                        <button
                          disabled={send.isPending || readOnly}
                          title={readOnly ? READ_ONLY_TITLE : undefined}
                          onClick={() => send.mutate({ action: 'scenario', id: s.id, on: !a })}
                          className={cx('shrink-0 rounded px-2 py-0.5 text-xs disabled:opacity-40', a ? 'bg-warn text-black' : 'bg-white/10 hover:bg-white/20')}
                        >
                          {a ? '끄기' : '켜기'}
                        </button>
                      </div>
                      <div className="mt-0.5 text-xs text-sub">{s.summary}</div>
                      {a && (
                        <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
                          <div className="h-full bg-warn" style={{ width: `${Math.round(a.level * 100)}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
          {send.error && <div className="text-xs text-down">{(send.error as Error).message}</div>}
        </div>
      )}
    </div>
  );
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString('ko-KR');

/** 데이터 경로: 설비 신호가 MES까지 오는 길과, OPC UA 경로일 때 엣지 게이트웨이 상태 */
function LinkStatus() {
  const [open, setOpen] = useState(false);
  const sim = useLive((s) => s.sim);
  const simConnected = useLive((s) => s.simConnected);
  const edge = useLive((s) => s.edge);
  const edgeConnected = useLive((s) => s.edgeConnected);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const opcua = sim?.link === 'opcua';
  const gateway = opcua && edgeConnected && edge ? edge : null;
  const on = simConnected && (!opcua || (gateway?.opcua === 'connected' && gateway.mqtt));
  const steps = opcua ? ['가상 PLC', 'OPC UA', '엣지 게이트웨이', 'MQTT', 'MES'] : ['시뮬레이터', 'MQTT', 'MES'];
  const rows: [string, ReactNode][] = gateway
    ? [
        ['OPC UA', gateway.opcua === 'connected' ? <span className="text-run">연결됨</span> : <span className="text-warn">연결 중</span>],
        ['MQTT', gateway.mqtt ? <span className="text-run">연결됨</span> : <span className="text-down">끊김 · 기록은 버퍼에 쌓는 중</span>],
        ['탐색한 주소 공간', `설비 ${n(gateway.stations)} · 태그 ${n(gateway.tags)}`],
        ['받은 이벤트', `상태 변경 ${n(gateway.received.state)} · 생산 실적 ${n(gateway.received.unit)}`],
        ['태그 값 알림', `${n(gateway.received.value)} (값이 바뀔 때만)`],
        ['버퍼 (MQTT 끊긴 동안)', `${n(gateway.buffered)}건${gateway.dropped ? ` · 넘쳐서 버림 ${n(gateway.dropped)}` : ''}`],
        ['빠진 실적 (순번 건너뜀)', gateway.gaps ? <span className="text-down">{n(gateway.gaps)}건</span> : '없음'],
        ['재연결', `${n(gateway.reconnects)}회`],
      ]
    : [];
  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="데이터 경로"
        className="flex items-center gap-1.5 rounded px-1 text-xs text-sub hover:bg-white/10"
      >
        <span className={cx('size-2 rounded-full', on ? 'bg-run' : 'bg-down blink')} />
        <span className="sr-only 2xl:not-sr-only">{opcua ? 'OPC UA' : '엣지'}</span>
      </button>
      {open && (
        // 머리줄의 whitespace-nowrap이 물려 내려오므로 여기서 줄바꿈을 되살린다
        <div className="panel absolute right-0 top-9 z-50 w-[380px] whitespace-normal p-3 text-xs">
          <div className="mb-2 text-sm font-semibold">데이터 경로</div>
          <div className="mb-3 flex flex-wrap items-center gap-1">
            {steps.map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                {i > 0 && <span className="text-dim">→</span>}
                <span className={cx('rounded border px-1.5 py-0.5', s === 'OPC UA' || s === '엣지 게이트웨이' ? 'border-info/50 bg-info/10 text-info' : 'border-line bg-white/5')}>{s}</span>
              </span>
            ))}
          </div>
          {!simConnected && <p className="mb-2 text-down">시뮬레이터 상태가 오지 않습니다.</p>}
          {opcua ? (
            gateway ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {rows.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-dim">{k}</dt>
                      <dd className="num">{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 leading-relaxed text-dim">
                  태그는 OPC UA 구독으로, 상태 변경·생산 실적은 OPC UA 이벤트로 받아 MQTT로 옮깁니다. AMR·시뮬레이터 상태는 MQTT로 바로 옵니다.
                </p>
              </>
            ) : (
              <p className="text-down">엣지 게이트웨이가 응답하지 않습니다. 설비 신호가 MES로 오지 않습니다 (npm run edge).</p>
            )
          ) : (
            <p className="leading-relaxed text-sub">
              시뮬레이터가 설비 신호를 MQTT 브로커로 바로 보냅니다. <span className="num">npm run dev:opcua</span>로 띄우면 가상 PLC(OPC UA 서버)와 엣지 게이트웨이를 거쳐 들어옵니다.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** AI 현장 비서 열기·닫기 (Ctrl+/) */
function AssistantButton() {
  const open = useUi((s) => s.assistantOpen);
  const setOpen = useUi((s) => s.setAssistantOpen);
  const busy = useAssistant((s) => s.busy);
  return (
    <button
      onClick={() => setOpen(!open)}
      title="AI 현장 비서 (Ctrl+/)"
      className={cx('flex h-8 items-center gap-1.5 rounded-md border px-1.5 text-sm xl:px-3', open ? 'border-info/60 bg-info/20 text-info' : 'border-line bg-white/5 hover:bg-white/10')}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 5h16v11H9l-5 4V5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M9 10.5h.01M12 10.5h.01M15 10.5h.01" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span>
        <span className="hidden 2xl:inline">AI </span>비서
      </span>
      {busy && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
    </button>
  );
}

export function TopBar() {
  const sim = useLive((s) => s.sim);
  const socket = useLive((s) => s.socket);
  const simConnected = useLive((s) => s.simConnected);
  const goHome = useLive((s) => s.goHome);
  const send = useSim();
  const { readOnly } = useAccess();
  const lock = readOnly ? READ_ONLY_TITLE : undefined;
  const path = usePathname();
  const router = useRouter();
  const elapsed = sim ? (Date.parse(sim.t) - Date.parse(sim.startedAt)) / 1000 : 0;
  const home = () => {
    goHome();
    if (path !== '/') router.push('/');
  };

  return (
    // .panel의 backdrop-filter가 쌓임 맥락을 만들므로, 드롭다운이 아래 패널 위로 오도록 헤더 자체를 올린다
    // 1024px 폭에서도 한 줄에 들어가도록 xl 미만에서는 간격·버튼 폭·글자를 줄이고,
    // 버튼 앞 글자·연결 점 글자·넓은 배속 버튼은 2xl(1536px), 경과 시간은 1680px부터 보인다 (1280~1536px에서 넘치던 것)
    <header className="panel pointer-events-auto relative z-30 flex h-12 shrink-0 items-center gap-2 px-3 xl:gap-4 xl:px-4">
      <button onClick={home} className="flex shrink-0 items-center gap-2" title={`${FACTORY.site} · 가상 램프·전장 공장 — 공장 전체 보기`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M4 14c0-4.4 3.6-8 8-8h6v4h-6a4 4 0 0 0-4 4v0" stroke="#f5b544" strokeWidth="2" strokeLinecap="round" />
          <path d="M14 14h6M14 18h6M14 10h6" stroke="#4fb3ff" strokeWidth="2" strokeLinecap="round" />
          <circle cx="7" cy="17" r="3" stroke="#7ee0a1" strokeWidth="2" />
        </svg>
        <span className="hidden font-semibold tracking-tight xl:inline">LumiTwin</span>
      </button>

      <NavTabs />

      <div className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
        <span className="num text-lg font-semibold">{kst(sim?.t)}</span>
        <span className="hidden text-xs text-dim min-[1680px]:inline">가상 시각 · 경과 {duration(elapsed)}</span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
        <div className="flex overflow-hidden rounded-md border border-line">
          {SIM_SPEEDS.map((v) => (
            <button
              key={v}
              disabled={!simConnected || send.isPending || readOnly}
              title={lock}
              onClick={() => send.mutate({ action: 'speed', speed: v })}
              className={cx('num h-8 w-8 text-sm 2xl:w-11', sim?.speed === v ? 'bg-info/25 text-info' : 'hover:bg-white/10', (!simConnected || readOnly) && 'opacity-40')}
            >
              {v}×
            </button>
          ))}
        </div>
        <button
          disabled={!simConnected || readOnly}
          title={lock}
          onClick={() => send.mutate({ action: sim?.running ? 'pause' : 'resume' })}
          className="h-8 w-16 rounded-md border border-line bg-white/5 text-sm hover:bg-white/10 disabled:opacity-40"
        >
          {sim?.running === false ? '재개' : '일시정지'}
        </button>
        <button
          disabled={!simConnected || readOnly}
          title={lock}
          onClick={() => confirm('시뮬레이션을 처음부터 다시 시작할까요? 진행 중인 시나리오와 집계가 초기화됩니다.') && send.mutate({ action: 'reset' })}
          className="h-8 rounded-md border border-line bg-white/5 px-2 text-sm hover:bg-white/10 disabled:opacity-40 xl:px-3"
        >
          초기화
        </button>
        <ScenarioMenu />
        <AccessBadge />
        <AssistantButton />
        <div className="ml-1 flex items-center gap-2 border-l border-line pl-2 xl:ml-2 xl:gap-3 xl:pl-3">
          <Dot on={socket} label="MES" />
          <LinkStatus />
        </div>
      </div>
    </header>
  );
}
