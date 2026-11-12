# Cloudflare Tunnel로 공개 링크 만들기 (무료)

이 PC에서 LumiTwin을 운영 모드로 띄우고, Cloudflare Tunnel로 `https://…` 주소를 하나 받아 밖에서 열게 한다.
서버를 빌리지 않으므로 돈이 들지 않는다. 대신 **이 PC가 켜져 있고 잠자기 상태가 아닐 때만** 링크가 열린다.

```
방문자 브라우저 ──HTTPS──▶ Cloudflare ◀──(PC가 먼저 맺은 바깥 방향 연결)── cloudflared ──▶ 화면 서버 :5180 ──▶ MES :8790
                                                                                         (Next가 /api/v1·/socket.io를 넘긴다)
```

- cloudflared가 바깥으로 연결을 맺기 때문에 공유기 포트를 열지 않는다.
- 주소가 HTTPS라서 휴대폰·태블릿에서도 마이크(음성 질문)가 된다.
- 실시간 연결(socket.io 웹소켓)도 터널을 그대로 지난다.

## 왜 Vercel·Cloudflare Pages가 아닌가

두 서비스의 무료 요금제는 정적 파일과, 요청이 올 때만 잠깐 도는 함수만 돌린다(Workers 무료: 요청당 CPU 10ms, 하루 10만 요청).
LumiTwin에는 늘 켜져 있어야 하는 프로세스가 넷 있다: SimPy 시뮬레이터, MQTT 브로커, Socket.io를 쓰는 NestJS 서버, PostgreSQL.
이 구조를 함수로 바꾸려면 시뮬레이터와 DB를 거의 새로 짜야 해서 터널을 골랐다. 상시 서버로 옮길 때는 [deploy/aws](../aws/README.md)의 스크립트를 쓴다.

## 처음 한 번

1. cloudflared 실행 파일을 받아 `tools/cloudflared/cloudflared.exe`로 둔다 (git에는 올라가지 않는다).
   - 받는 곳: <https://github.com/cloudflare/cloudflared/releases> 의 `cloudflared-windows-amd64.exe`
   - 같은 페이지 본문의 SHA256 값과 맞는지 확인한다: `certutil -hashfile tools\cloudflared\cloudflared.exe SHA256`
   - PATH에 깔린 cloudflared가 있으면 그것을 쓴다. 다른 위치는 `CLOUDFLARED` 환경 변수로 알려 준다.
2. 운영 빌드를 만든다.

```bash
npm run build
```

## 켜기

```bash
npm run share
```

DB·MES·화면·시뮬레이터를 운영 모드로 띄우고, 화면이 뜨면 터널을 연다. 로그에 이런 상자가 나오면 그 주소가 공개 링크다.

```
[tunnel] ┌──────────────────────────────────────────────┐
[tunnel] │  https://임의-이름-네-개.trycloudflare.com  │
[tunnel] └──────────────────────────────────────────────┘
```

- 작업자 태블릿 화면은 `<주소>/operator` 이다.
- 끄려면 그 창에서 Ctrl+C. 앱만 띄우려면 `npm run start`, 이미 띄운 앱에 터널만 붙이려면 `npm run tunnel`.
- 터널이 실패하거나 끊기면 1분부터 10분까지 간격을 늘려 가며 저절로 다시 연다. 빠른 터널은 다시 열 때마다 주소가 바뀐다.

## 공개 링크는 보기 전용

링크를 아는 사람은 누구나 들어올 수 있으므로, Cloudflare를 거쳐 온 방문자는 **보기 전용**이다.

| | 이 PC·같은 망에서 연 화면 | 공개 링크로 들어온 방문자 |
|---|---|---|
| 3D·MES 화면, 실시간 값 | 됨 | 됨 |
| AI 비서 질문·음성 질문 | 됨 | 됨 (공장 상태를 바꾸지 않는다) |
| 배속·일시정지·초기화·시나리오 | 됨 | 막힘 |
| 설비 정지·셋업·고장·재가동, 작업 전 점검 기록, 알람 확인 | 됨 | 막힘 |

- 서버가 Cloudflare가 붙이는 `CF-Ray` 머리글로 공개 링크 요청을 가려 쓰기 요청을 403으로 막는다. 화면은 같은 판단을 받아 버튼을 잠그고 `보기 전용` 표시를 띄운다.
- **시연자가 공개 링크에서 조작해야 할 때**(면접장 태블릿 등): 화면의 `보기 전용`을 눌러 제어 키를 넣는다.
  키는 `server/.env`의 `CONTROL_KEY`에 있다. 맞으면 `조작 가능`으로 바뀌고, 다시 누르면 키를 지운다. 키는 그 브라우저에만 남는다.
- 설정 (`server/.env`, 바꾸면 서버를 다시 띄운다):

| 변수 | 값 | 뜻 |
|---|---|---|
| `READ_ONLY` | `tunnel` (기본) | 공개 링크로 온 요청만 보기 전용 |
| | `all` | 모든 요청이 보기 전용 (서버를 통째로 공개할 때) |
| | `off` | 끔. 공개 링크 방문자도 조작할 수 있다 |
| `CONTROL_KEY` | 아무 문자열 | 이 키를 넣은 화면은 보기 전용이어도 조작 가능. 비우면 풀 수 없다 |

- AI 비서는 키가 없으면 모의 모드라 돈이 들지 않는다. `ANTHROPIC_API_KEY`를 넣으면 IP별 시간당·하루 전체 질문 한도(`ASSISTANT_MAX_PER_HOUR`·`ASSISTANT_MAX_PER_DAY`) 안에서 사용량만큼 비용이 나간다.
  공개 링크 방문자의 IP는 Cloudflare가 알려 주는 `CF-Connecting-IP`로 센다.

## 빠른 터널과 이름 붙인 터널

| | 빠른 터널 (기본) | 이름 붙인 터널 |
|---|---|---|
| 필요한 것 | 없음 | Cloudflare 무료 계정 + Cloudflare에 연결한 도메인 (1년 1~2만 원대) |
| 주소 | `*.trycloudflare.com`, 켤 때마다 바뀜 | `lumitwin.내도메인` 처럼 고정 |
| 안정성 | 가동 보장 없음, 만들기 요청이 429로 막힐 때가 있다 | 계정에 묶인 터널이라 안정적 |
| 스트리밍 | SSE(`text/event-stream`)는 지원 안 함. AI 비서 답은 NDJSON이라 흐르는 것을 확인함 | 제한 없음 |

**빠른 터널을 특정 사람만 들어오게 막기**: `TUNNEL_ALLOWED_MAIL`에 메일 주소(쉼표로 여러 개, `*@회사.com` 가능)를 주면 방문자가 메일로 받은 일회용 PIN을 넣어야 들어온다.

```powershell
$env:TUNNEL_ALLOWED_MAIL = 'interviewer@example.com'; npm run share
```

**이름 붙인 터널로 고정 주소 쓰기**

1. Cloudflare에 가입하고 도메인을 연결한다 (Cloudflare에서 사거나, 산 곳에서 네임서버를 Cloudflare로 바꾼다).
2. 대시보드의 Zero Trust → Networks → Tunnels에서 터널을 만들고(커넥터는 cloudflared) 토큰을 복사한다.
3. 같은 터널의 공개 호스트 이름(Public hostname)에 `lumitwin` + 내 도메인 → 서비스 `HTTP`, `127.0.0.1:5180`을 넣는다.
4. 토큰을 `tools/cloudflared/tunnel-token.txt`에 저장한다 (git에 올라가지 않는다). 또는 `TUNNEL_TOKEN` 환경 변수로 준다.
5. `npm run share`. 토큰이 있으면 빠른 터널 대신 그 터널로 붙는다.

## 주의

- 공개 링크는 이 PC로 들어오는 문이다. 시연이 끝나면 Ctrl+C로 끈다.
- PC가 잠자기에 들어가면 링크가 끊긴다. 시연 동안은 전원 설정에서 잠자기를 끈다.
  잠자기에서 깨면 시뮬레이터가 밀린 시간을 건너뛰고 다시 맞춘다(`resync_clock`).
- `npm run dev`(개발 모드)를 터널로 열지 않는다. 느리고 코드 변경을 감시하는 연결이 섞인다.
- 개발 서버를 강제로 끄면 embedded-postgres 프로세스 하나가 54332 포트를 잡고 남을 수 있다. `npm run share` 전에 남은 `postgres.exe`를 끝낸다.
