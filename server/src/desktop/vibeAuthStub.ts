// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// Stand-in for @kisaesdevlab/vibe-auth in the desktop bundle (owner decision
// Q12). Desktop has no single sign-on, so desktop builds don't install the
// private package; scripts/desktop/build.mjs resolves the package name to
// this file instead. It provides exactly the runtime API src/lib/vibeAuth.ts
// uses, fixed in local mode: no SSO, local login allowed, nothing revoked,
// and no /auth/* routes (handle() answers null, so requests fall through).
// Type-only imports of the package are erased by the bundler.

interface StubStatus {
  mode: 'local';
  product: string;
  oidc: { enabled: false; idpName: string; reachable: false; startPath: string; issuer?: string };
  localLoginVisible: true;
  breakglassPath: string;
}

interface StubOptions {
  product?: { slug?: string };
  breakglassLoginPath?: string;
}

class DesktopVibeAuth {
  constructor(private readonly options: StubOptions) {}

  async start(): Promise<void> {
    // nothing to discover: no identity provider
  }

  status(): StubStatus {
    return {
      mode: 'local',
      product: this.options.product?.slug ?? 'vibe-tb',
      oidc: { enabled: false, idpName: '', reachable: false, startPath: '' },
      localLoginVisible: true,
      breakglassPath: this.options.breakglassLoginPath ?? '',
    };
  }

  localLoginAllowed(_identifier: string): { allowed: boolean; reason?: string } {
    return { allowed: true };
  }

  async afterLocalLogin(_i: { userId: string; username?: string; email?: string; ip?: string }): Promise<void> {
    // no SSO identity to link
  }

  async isRevoked(_key: { userId?: string; sid?: string }, _issuedAtMs: number): Promise<boolean> {
    return false; // revocations come only from an identity provider's back-channel logout
  }

  async handle(_req: unknown): Promise<null> {
    return null;
  }
}

export function createVibeAuth(options: StubOptions): DesktopVibeAuth {
  return new DesktopVibeAuth(options);
}

export function createPgStores(_options: unknown): { identities: null; settings: null; revocations: null } {
  return { identities: null, settings: null, revocations: null };
}

export function toHttpRequest(req: unknown, _res?: unknown): unknown {
  return req;
}

export function sendHttpResponse(_res: unknown, _r: unknown): never {
  // handle() never answers, so nothing is ever sent through here.
  throw new Error('vibe-auth is not available in the desktop engine');
}
