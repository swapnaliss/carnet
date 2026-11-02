export function healthPayload(now: Date = new Date()): { status: "ok"; time: string } {
  return { status: "ok", time: now.toISOString() };
}
