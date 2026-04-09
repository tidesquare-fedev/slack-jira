/* eslint-disable @typescript-eslint/no-explicit-any */

function collectBlockText(block: any): string[] {
  if (!block || typeof block !== "object") return [];
  const out: string[] = [];
  if (typeof block.text === "string") out.push(block.text);
  if (block.text?.text) out.push(String(block.text.text));
  if (Array.isArray(block.elements)) {
    for (const el of block.elements) out.push(...collectBlockText(el));
  }
  if (Array.isArray(block.fields)) {
    for (const f of block.fields) out.push(...collectBlockText(f));
  }
  return out;
}

export function messagePlainText(message: {
  text?: string;
  blocks?: unknown[];
}): string {
  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  if (Array.isArray(message.blocks)) {
    for (const b of message.blocks) {
      const t = collectBlockText(b).join(" ").trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n").trim();
}
