import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(root, 'dist'), { recursive: true, force: true });
console.log('cleaned dist/');
