import * as path from 'path';

/**
 * Удаляет дублирующиеся сегменты пути, которые агенты/LLM иногда добавляют
 * из-за непонимания контекста проекта.
 * Например: "apps/api/apps/web/src/views/..." → "apps/web/src/views/..."
 * или "client/apps/web/..." → "apps/web/..." (когда корень = /Users/.../client)
 */
export function stripMirroredProjectPrefixes(projectPath: string, relPath: string): string {
  let current = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!current) return '';
  const projectSegments = path.resolve(projectPath).replace(/\\/g, '/').split('/').filter(Boolean);
  const suffixPrefixes: string[] = [];
  const base = projectSegments[projectSegments.length - 1];
  const parent = projectSegments[projectSegments.length - 2];
  const grandParent = projectSegments[projectSegments.length - 3];
  const commonWorkspaceDirs = new Set(['apps', 'packages', 'services', 'libs']);

  if (base) suffixPrefixes.push(`${base}/`);
  if (parent && base && commonWorkspaceDirs.has(parent)) {
    suffixPrefixes.push(`${parent}/${base}/`);
  }
  if (grandParent && parent && base && commonWorkspaceDirs.has(grandParent)) {
    suffixPrefixes.push(`${grandParent}/${parent}/${base}/`);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of suffixPrefixes) {
      if (current.startsWith(prefix)) {
        current = current.slice(prefix.length);
        changed = true;
      }
    }
  }
  return current;
}

/**
 * Убирает зеркальный префикс типа "apps/api/apps/..." → "..."
 * и проверяет существование файла на диске для выбора правильного варианта.
 */
export function normalizePathByProjectSuffix(
  projectPath: string,
  relPath: string,
  fsExistsSync: (p: string) => boolean = () => false,
): string {
  const normalized = stripMirroredProjectPrefixes(
    projectPath,
    String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim(),
  );
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  const hasMirroredRepoPrefix =
    segments.length >= 2 &&
    segments[0] === 'apps' &&
    segments[1] === 'api' &&
    segments.length >= 4 &&
    segments[2] === 'apps';

  // Если зеркального префикса нет — возвращаем как есть
  if (!hasMirroredRepoPrefix) {
    return normalized;
  }

  // Пробуем отрезать "apps/api/" и проверить существование
  const directFile = path.join(projectPath, normalized);
  const directDir = path.join(projectPath, path.dirname(normalized));
  if (fsExistsSync(directFile) || fsExistsSync(directDir)) {
    return normalized;
  }

  // Ищем настоящий путь: "apps/api/apps/web/.../file" → ищем "apps/web/.../file"
  for (let i = 2; i < segments.length; i++) {
    const suffix = segments.slice(i).join('/');
    const fileCandidate = path.join(projectPath, suffix);
    const dirCandidate = path.join(projectPath, path.dirname(suffix));
    if (fsExistsSync(fileCandidate) || fsExistsSync(dirCandidate)) {
      return suffix;
    }
  }

  // Если ничего не нашли — возвращаем без зеркального префикса
  return segments.slice(2).join('/');
}

/**
 * Приводит путь к относительному виду внутри проекта.
 * Обрабатывает абсолютные пути, контейнерные префиксы (host-projects/...),
 * и зеркальные дублирования сегментов.
 */
export function relPathWithinProject(
  projectPath: string,
  relOrAbs: string,
  fsExistsSync: (p: string) => boolean = () => false,
): string {
  let p = String(relOrAbs || '').trim();
  if (!p) return '';
  const normProject = path.resolve(projectPath).replace(/\/+$/, '');
  const projBase = path.basename(normProject);
  // Windows-слеши на всякий случай.
  p = p.replace(/\\/g, '/').trim();
  // Если путь абсолютный и лежит внутри проекта — берём относительную часть.
  try {
    const abs = path.resolve(p);
    if (abs === normProject) return '';
    if (abs.startsWith(normProject + '/')) {
      return path.relative(normProject, abs);
    }
  } catch { /* ignore */ }
  // Обрезаем ведущие слеши (модель пишет /src/... вместо src/...).
  p = p.replace(/^\/+/, '');
  // Срезаем возможный префикс "host-projects/<projBase>/" если модель
  // писала контейнерный путь без ведущего слеша.
  if (projBase) {
    const hostPrefix = `host-projects/${projBase}/`;
    if (p.startsWith(hostPrefix)) p = p.slice(hostPrefix.length);
    else if (p === `host-projects/${projBase}`) p = '';
    else if (p.startsWith(`${projBase}/`)) p = p.slice(`${projBase}/`.length);
    else if (p === projBase) p = '';
  }
  p = stripMirroredProjectPrefixes(normProject, p);
  // Защита от выхода за пределы проекта (../).
  p = p.replace(/^(\.\.\/)+/, '');
  return normalizePathByProjectSuffix(normProject, p, fsExistsSync);
}

/**
 * Находит все пути в тексте (строчке) и нормализует их через relPathWithinProject.
 * Используется для пост-обработки executionTask после оркестратора,
 * чтобы исправить дублированные пути типа "apps/api/apps/web/...".
 */
export function cleanupPathsInTask(
  projectPath: string,
  taskText: string,
  fsExistsSync: (p: string) => boolean = () => false,
): string {
  if (!taskText || !projectPath) return taskText || '';

  // Ищем подозрительные пути с дублированным префиксом: "apps/api/apps/web/..."
  // (модель пишет путь от корня монорепы, повторяя структуру проекта)
  const duplicatePrefixRegex = /\b((?:apps|packages|services|libs)\/[a-zA-Z0-9_-]+\/(?:apps|packages|services|libs)\/[^\s,;:]+)/g;

  let result = taskText;
  const replaced = new Set<string>();

  for (const match of taskText.matchAll(duplicatePrefixRegex)) {
    const original = match[0];
    if (replaced.has(original)) continue;

    const cleaned = relPathWithinProject(projectPath, original, fsExistsSync);
    if (cleaned && cleaned !== original) {
      result = result.split(original).join(cleaned);
      replaced.add(original);
    }
  }

  // Второй проход: ищем любые пути с минимум 2 сегментами, не попавшие в первый regex
  const genericPathRegex = /(?<!["'`])((?:[a-zA-Z0-9_.-]+\/){2,}[a-zA-Z0-9_.-]+(?:\.[a-z]+))/gi;

  for (const match of result.matchAll(genericPathRegex)) {
    const original = match[0];
    if (/^https?:\/\//i.test(original)) continue;
    if (replaced.has(original)) continue;

    const cleaned = relPathWithinProject(projectPath, original, fsExistsSync);
    if (cleaned && cleaned !== original) {
      result = result.split(original).join(cleaned);
      replaced.add(original);
    }
  }

  return result;
}
