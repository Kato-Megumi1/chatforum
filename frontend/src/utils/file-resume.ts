export interface FileResumePointer { draftId: string; revision: number; hash: string }
export type FileFailureReason = 'OUTPUT_LIMIT' | 'UNCLOSED_FILE' | 'HTML_SYNTAX' | 'INVALID_FILE' | 'SAVE_FAILED' | 'SERVICE_ERROR';
export interface RecoverableFileGeneration { fileIncomplete: true; truncated: true; canContinue: true;
  resumeFile: FileResumePointer; fileFailureReason?: FileFailureReason }

/** Only a versioned server reference may enter a resume request, never source or instructions. */
export function readFileResume(value: unknown): FileResumePointer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const pointer = value as Record<string, unknown>;
  if (typeof pointer.draftId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pointer.draftId) ||
    typeof pointer.revision !== 'number' || !Number.isSafeInteger(pointer.revision) || pointer.revision <= 0 ||
    typeof pointer.hash !== 'string' || !/^[0-9a-f]{64}$/.test(pointer.hash)) return;
  return { draftId: pointer.draftId, revision: pointer.revision, hash: pointer.hash };
}

/** Failed-run metadata may contain only this public recovery projection in the UI. */
export function readRecoverableFileGeneration(value: unknown): RecoverableFileGeneration | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const generation = value as Record<string, unknown>, resumeFile = readFileResume(generation.resumeFile);
  if (!resumeFile || generation.fileIncomplete !== true || generation.truncated !== true || generation.canContinue !== true) return;
  const reasons: FileFailureReason[] = ['OUTPUT_LIMIT', 'UNCLOSED_FILE', 'HTML_SYNTAX', 'INVALID_FILE', 'SAVE_FAILED', 'SERVICE_ERROR'];
  return { fileIncomplete: true, truncated: true, canContinue: true, resumeFile,
    ...(reasons.includes(generation.fileFailureReason as FileFailureReason) ? { fileFailureReason: generation.fileFailureReason as FileFailureReason } : {}) };
}
