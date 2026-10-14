import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Read-only projection boundary: no UI, scheduling, model, or write capabilities. */
export type SessionReader = {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getBranch" | "getEntries">;
};
