"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * M4-05: whether this page is a replay session. Client components use it to drop live-freshness
 * wording ("Live · checked 3 s ago", "not checked yet") that would contradict the recording banner.
 * The server decides (AppShell reads the session); a client cannot turn replay off with it.
 */
const RecordingContext = createContext(false);

export function RecordingProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording(): boolean {
  return useContext(RecordingContext);
}
