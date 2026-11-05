// better-auth endpoints under /api/auth/* with Carnet's sign-up, sign-in and error rules
// (src/lib/auth.ts). The runtime is built on the first request, not at build time.
import { createAuthHandlers, getAuthRuntime } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const { GET, POST } = createAuthHandlers(getAuthRuntime);
