import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css']) await copyFile(file, `dist/${file}`);
