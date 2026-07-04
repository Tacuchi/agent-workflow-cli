import { NodeFileSystem } from "../../src/adapters/node-file-system.js";

export { NodeFileSystem };

/**
 * NodeFileSystem with list() stubbed empty so workspace auto-detect never
 * matches a seeded sandbox (see the self-namespace-pin tests); everything
 * else (readText/writeText/exists/…) stays real.
 */
export class NoScanFs extends NodeFileSystem {
  override async list(): Promise<never[]> {
    return [];
  }
}
