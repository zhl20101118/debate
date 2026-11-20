import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const REPORT_DIR = path.join(DATA_DIR, 'reports');
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SECRET_FILE = path.join(DATA_DIR, 'secrets.json');

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSION_DIR, REPORT_DIR, MEMORY_DIR, EXPORT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
