import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Both layouts: `tsx src/…` from the source tree, `node dist/…` from the build.
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

// Hashing the bundle's own bytes is what makes its URL safe to cache forever:
// changed content necessarily lands at a different URL.
const source = load();
const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);

export const widgetAsset = {
  source,
  version: `v${hash}`,
  etag: `"${hash}"`,
  byteLength: Buffer.byteLength(source, 'utf8'),
  get versionedPath(): string {
    return `/embed/${this.version}/widget.js`;
  },
};
