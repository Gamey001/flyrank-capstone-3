import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The versioned widget bundle.
 *
 * The script is read once at boot and its content hash becomes the version in
 * the URL (`/embed/v<hash>/widget.js`). Same content, same URL — so browsers
 * and any CDN in front of us can cache it forever; new content, new URL — so a
 * release is picked up immediately with no purge and no stale-code window.
 */

const here = dirname(fileURLToPath(import.meta.url));

// Resolved for both `tsx src/...` (source tree) and `node dist/...` (build
// output, where `npm run copy:assets` places the same file).
const candidates = [
  join(here, '../widget/widget.js'),
  join(here, '../../src/widget/widget.js'),
];

const load = (): string => {
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error(`widget.js not found. Looked in:\n${candidates.join('\n')}`);
};

const source = load();
const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);

export const widgetAsset = {
  source,
  /** e.g. "v3f1c9ab2e4d0" — changes if and only if widget.js changes. */
  version: `v${hash}`,
  etag: `"${hash}"`,
  byteLength: Buffer.byteLength(source, 'utf8'),
  /** Path of the immutable, long-cached bundle. */
  get versionedPath(): string {
    return `/embed/${this.version}/widget.js`;
  },
};
