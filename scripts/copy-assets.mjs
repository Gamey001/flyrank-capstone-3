import { cp, mkdir } from 'node:fs/promises';

// tsc emits only .ts, so the widget bundle and the .sql migrations have to be
// copied or the built image boots against an empty database. Copying the widget
// byte-for-byte also keeps its content hash, and so its version, stable.
await mkdir('dist/widget', { recursive: true });
await cp('src/widget/widget.js', 'dist/widget/widget.js');
console.log('copied src/widget/widget.js -> dist/widget/widget.js');

await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('copied src/db/migrations -> dist/db/migrations');
