import type { NextConfig } from 'next';

/**
 * 화면 서버(Next)가 API·실시간 연결을 넘겨줄 MES 서버 주소. 브라우저는 늘 화면과 같은 주소의 /api/v1로 부른다
 * (다른 PC에서 http://<IP>:5180으로 들어와도 그 PC의 localhost가 아니라 이 서버로 간다). 판타스틸 ERP와 같은 방식.
 */
// localhost 대신 127.0.0.1: 배포 서버에서 MES가 127.0.0.1에서만 받을 때 localhost가 IPv6(::1)로 풀려 연결이 거부되지 않게
const apiBaseUrl = new URL((process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8790/api/v1').replace(/\/$/, ''));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // next dev가 AI 에이전트를 감지하면 client/에 AGENTS.md·CLAUDE.md를 자동으로 만든다. 저장소 규칙 파일이 늘지 않게 끈다
  agentRules: false,
  devIndicators: false,
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*'],
  // socket.io 주소(/socket.io/?EIO=…)가 끝의 '/'를 떼는 리다이렉트를 당하면 실시간 연결이 붙지 않는다
  skipTrailingSlashRedirect: true,
  transpilePackages: ['three'],
  experimental: {
    // Next는 /api/v1로 넘겨주는(rewrites) 요청 본문을 기본 10MB에서 자른다. 잘리면 MES가 나머지를 기다리다 30초 뒤 500이 난다.
    // TBM 녹음은 25MB까지 올리므로(받아쓰기 서버 한도) multipart 머리까지 넉넉히 26MB로 둔다. 그보다 크면 MES가 413으로 거절한다
    proxyClientMaxBodySize: 26 * 1024 * 1024,
  },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${apiBaseUrl.href}/:path*` },
      { source: '/socket.io', destination: `${apiBaseUrl.origin}/socket.io/` },
      { source: '/socket.io/:path+', destination: `${apiBaseUrl.origin}/socket.io/:path+` },
    ];
  },
};

export default nextConfig;
