export interface LegitimooseCompatibility {
  readonly serverVersion: string;
  readonly productCommit: string;
  readonly quality: "stable";
  readonly vscodeVersion: string;
  readonly vscodeCommit: string;
}

// This is intentionally the only supported target. Updating Legitimoose means
// updating and revalidating this identity rather than selecting a runtime variant.
export const LEGITIMOOSE_COMPATIBILITY: LegitimooseCompatibility = {
  serverVersion: "1.131.68",
  productCommit: "761351d742548739627db207af20f039d6b4f786",
  quality: "stable",
  vscodeVersion: "1.125.0",
  vscodeCommit: "93cfdd489c3b228840d0f86ec77c3636277c93ea",
};

export function remoteAgentPath(): string {
  return `/${LEGITIMOOSE_COMPATIBILITY.quality}-${LEGITIMOOSE_COMPATIBILITY.productCommit}`;
}
