export type ArtifactReviewStatus = 'passed' | 'issues' | 'unavailable' | 'not_reviewed';
export interface ArtifactReviewSummary { status: ArtifactReviewStatus; reviewId?: string; sourceHash?: string; issues?: string[] }
export interface ArtifactReviewView { width: number; height: number; index: number }
export interface ArtifactReviewReport extends ArtifactReviewSummary {
  reviewId: string; sourceHash: string; issues: string[]; views: ArtifactReviewView[];
}
const statuses: readonly string[] = ['passed', 'issues', 'unavailable', 'not_reviewed'];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const issues = (value: unknown): string[] => Array.isArray(value)
  ? value.slice(0, 8).filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0, 240)).filter(Boolean) : [];
export const isHtmlArtifact = (path: unknown): boolean => typeof path === 'string' && /\.html?$/i.test(path);
export function artifactReviewSummary(input: unknown): ArtifactReviewSummary {
  const source = record(input);
  const status = statuses.includes(String(source?.status)) ? source!.status as ArtifactReviewStatus : 'not_reviewed';
  return { status: status === 'passed' && !uuid(source?.reviewId) ? 'not_reviewed' : status,
    ...(uuid(source?.reviewId) ? { reviewId: source.reviewId } : {}),
    ...(hash(source?.sourceHash) ? { sourceHash: source.sourceHash.toLowerCase() } : {}), issues: issues(source?.issues) };
}
export function artifactReviewLabel(status: ArtifactReviewStatus): string {
  return status === 'passed' ? '已做页面验收' : status === 'issues' ? '验收发现问题' : '未完成视觉验收';
}
export function artifactReviewReport(input: unknown, reviewId: string, sourceHash?: string): ArtifactReviewReport {
  const source = record(input);
  if (!source || source.reviewId !== reviewId || !uuid(source.reviewId) || !hash(source.sourceHash) ||
      !statuses.includes(String(source.status)) || sourceHash && source.sourceHash.toLowerCase() !== sourceHash.toLowerCase() || !Array.isArray(source.views) || source.views.length > 2)
    throw Error('验收记录已过期或格式无效');
  const views: ArtifactReviewView[] = [], seen = new Set<number>();
  for (const item of source.views) {
    const view = record(item);
    if (!view || seen.has(view.index as number) || !(
      view.index === 0 && view.width === 390 && view.height === 844 ||
      view.index === 1 && view.width === 1280 && view.height === 900)) throw Error('验收截图信息无效');
    seen.add(view.index as number);
    views.push({ width: view.width as number, height: view.height as number, index: view.index as number });
  }
  if (source.status === 'passed' && views.length !== 2) throw Error('验收记录缺少完整截图');
  return { status: source.status as ArtifactReviewStatus, reviewId, sourceHash: source.sourceHash.toLowerCase(), issues: issues(source.issues), views };
}

export async function isReviewPng(value: unknown): Promise<boolean> {
  if (!(value instanceof Blob) || value.type.toLowerCase() !== 'image/png' || !value.size || value.size > 20 * 1024 * 1024) return false;
  const bytes = new Uint8Array(await value.slice(0, 8).arrayBuffer());
  return bytes.length === 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}
