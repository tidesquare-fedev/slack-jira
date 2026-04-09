export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui", maxWidth: 520 }}>
      <h1>Slack → Jira</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        버튼/모달이 안 되고 &quot;대화식 응답으로 처리하도록 구성되지 않았습니다&quot;가 뜨면
        Slack 앱에 아래 URL을 꼭 넣어 주세요.
      </p>
      <ul style={{ lineHeight: 1.6 }}>
        <li>
          <strong>Event Subscriptions</strong> → Request URL:{" "}
          <code>…/api/slack</code>
        </li>
        <li>
          <strong>Interactivity &amp; Shortcuts</strong> → Interactivity 켬 →
          Request URL: <code>…/api/slack/interactive</code>
        </li>
        <li>
          <strong>Slash Commands</strong> → <code>/check</code> 생성 → Request
          URL: <code>…/api/slack/slash</code>
        </li>
      </ul>
      <p style={{ fontSize: 14 }}>
        두 주소 모두 Vercel 배포 도메인 앞에 붙인 전체 HTTPS URL이어야 합니다.
      </p>
    </main>
  );
}
