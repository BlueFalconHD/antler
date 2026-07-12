export interface CompatibilityProfile {
  readonly name: "public-v4.20.1" | "custom-v69";
  readonly codeServerVersion: string;
  readonly productCommit: string;
  readonly quality: string;
  readonly vscodeVersion: string;
  readonly vscodeCommit: string;
  readonly verified: boolean;
  readonly writePreservingOpenOptions?: Readonly<Record<string, unknown>>;
}

export const compatibilityProfiles = {
  "public-v4.20.1": {
    name: "public-v4.20.1",
    codeServerVersion: "4.20.1",
    productCommit: "e76afa4a2bf4667a3c9f71bf56ef34b8ad365fbe",
    quality: "stable",
    vscodeVersion: "1.85.2",
    vscodeCommit: "8b3775030ed1a69b13e4f4c628c612102e30a681",
    verified: true,
  },
  "custom-v69": {
    name: "custom-v69",
    codeServerVersion: "69.0.0",
    productCommit: "ebeb3c82ac91ac3e453356093435047ed911a179",
    quality: "stable",
    vscodeVersion: "1.85.2",
    vscodeCommit: "8b3775030ed1a69b13e4f4c628c612102e30a681",
    verified: true,
  },
} as const satisfies Record<string, CompatibilityProfile>;

export type CompatibilityProfileName = keyof typeof compatibilityProfiles;

export function remoteAgentPath(profile: CompatibilityProfile): string {
  return `/${profile.quality}-${profile.productCommit}`;
}
