import type { ExecuteRequest } from "./protocol.js";
import { pageLeases, type PageLeaseManager } from "./sessions.js";

/** Handler boundary for arbitrary QuickJS scripts, whose page target cannot be proven. */
export function authorizeExecuteRequest(
  request: Pick<ExecuteRequest, "browser" | "session">,
  leases: PageLeaseManager = pageLeases
): void {
  leases.assertBrowserMutationAllowed(request.browser, request.session);
}
