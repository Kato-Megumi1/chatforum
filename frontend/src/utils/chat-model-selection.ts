interface ModelOption { id: string; available: boolean }
// Old persisted selections can refer to a disabled model. UI and admission must agree.
export function selectedChatModel(models: ModelOption[], defaultId: string, ...preferences: Array<string | undefined>): string {
  return preferences.find(id => !!id && models.some(model => model.id === id && model.available)) || defaultId;
}
