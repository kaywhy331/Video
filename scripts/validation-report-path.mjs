import { relative, resolve } from 'node:path';

/** Normalizes local and foreign-OS test-report paths to repository-relative bindings. */
export function normalizeValidationReportFile(path, root = process.cwd()) {
  const normalizedPath = String(path).replaceAll('\\', '/');
  const normalizedRoot = resolve(root).replaceAll('\\', '/').replace(/\/$/u, '');
  if (normalizedPath === normalizedRoot) return '.';
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  const testMarker = '/tests/';
  const foreignTestIndex = normalizedPath.lastIndexOf(testMarker);
  if (foreignTestIndex >= 0) return normalizedPath.slice(foreignTestIndex + 1);
  return relative(resolve(root), resolve(path)).replaceAll('\\', '/');
}
