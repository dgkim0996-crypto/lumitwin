// 아주 작은 MQTT 3.1.1 구독 전용 클라이언트 (부하 측정이 브로커에 오가는 메시지를 엿듣는 데만 쓴다, 추가 패키지 없음).
// CONNECT → SUBSCRIBE(QoS 0) → PUBLISH 받기만 한다. 발행·QoS 1·재접속은 하지 않는다.
import { connect as tcpConnect } from 'node:net';

function encodeLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

/**
 * @param {{ host?: string, port?: number, clientId?: string, topics: string[], onMessage: (topic: string, payload: Buffer) => void }} opts
 * @returns {Promise<{ close: () => void }>}
 */
export function subscribe({ host = '127.0.0.1', port = 1884, clientId = `lt-probe-${process.pid}`, topics, onMessage }) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect({ host, port });
    let buf = Buffer.alloc(0);
    let ready = false;
    const ping = setInterval(() => sock.write(Buffer.from([0xc0, 0x00])), 20_000);
    const close = () => {
      clearInterval(ping);
      try {
        sock.write(Buffer.from([0xe0, 0x00]));
      } catch {}
      sock.destroy();
    };
    sock.once('error', (e) => (ready ? undefined : reject(e)));
    sock.on('connect', () => {
      // 프로토콜 이름 MQTT, 레벨 4, clean session, keepalive 60초
      const vh = Buffer.concat([str('MQTT'), Buffer.from([4, 0x02, 0, 60])]);
      sock.write(packet(1, 0, Buffer.concat([vh, str(clientId)])));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        let mul = 1;
        let len = 0;
        let i = 1;
        let b;
        do {
          if (i >= buf.length) return;
          b = buf[i++];
          len += (b & 0x7f) * mul;
          mul *= 128;
        } while (b & 0x80);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4;
        const flags = buf[0] & 0x0f;
        const body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 2) {
          // CONNACK → 구독
          if (body[1] !== 0) return reject(new Error(`MQTT 접속 거절 (코드 ${body[1]})`));
          const subs = Buffer.concat(topics.map((t) => Buffer.concat([str(t), Buffer.from([0])])));
          sock.write(packet(8, 2, Buffer.concat([Buffer.from([0, 1]), subs])));
        } else if (type === 9) {
          ready = true;
          resolve({ close });
        } else if (type === 3) {
          const tlen = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tlen).toString('utf8');
          const qos = (flags >> 1) & 3;
          const payload = body.subarray(2 + tlen + (qos > 0 ? 2 : 0));
          if (qos === 1) sock.write(packet(4, 0, body.subarray(2 + tlen, 4 + tlen))); // PUBACK
          onMessage(topic, payload);
        }
      }
    });
  });
}
