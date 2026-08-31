import { cp, mkdir } from 'node:fs/promises';

/**
 * `tsc` only emits .ts files. Two things the running app needs are not
 * TypeScript: the widget bundle (deliberately plain JavaScript — it is shipped
 * to browsers, not run by Node) and the .sql migrations. Copying the widget
 * verbatim also keeps its content hash — and therefore its bundle version —
 * identical between the source tree and the image.
 */
await mkdir('dist/widget', { recursive: true });
await cp('src/widget/widget.js', 'dist/widget/widget.js');
console.log('copied src/widget/widget.js -> dist/widget/widget.js');

// Migrations are .sql, which tsc also ignores. Without them the built image
// would boot against an empty database.
await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('copied src/db/migrations -> dist/db/migrations');
