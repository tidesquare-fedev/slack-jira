import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: "system-ui", padding: 24 }}>{children}</body>
    </html>
  );
}
