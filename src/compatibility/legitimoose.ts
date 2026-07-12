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
  serverVersion: "69.0.0",
  productCommit: "ebeb3c82ac91ac3e453356093435047ed911a179",
  quality: "stable",
  vscodeVersion: "1.85.2",
  vscodeCommit: "8b3775030ed1a69b13e4f4c628c612102e30a681",
};

export function remoteAgentPath(): string {
  return `/${LEGITIMOOSE_COMPATIBILITY.quality}-${LEGITIMOOSE_COMPATIBILITY.productCommit}`;
}
