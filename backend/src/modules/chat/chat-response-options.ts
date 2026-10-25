import { ChatRunDto } from './chat-run.dto';
// The dedicated permission switch is authoritative, even for old clients that still
// submit web_search in enabledSkills. No undefined list may implicitly enable it.
export function responseSkills(input: Pick<ChatRunDto, 'mode' | 'enabledSkills' | 'webSearch'>, agentDefaults: string[] = []) {
  const selected = input.enabledSkills ?? agentDefaults;
  const allowed = selected.filter(name => name !== 'web_search' && (input.mode === 'agent' || name === 'code_workspace'));
  if (input.webSearch === true) allowed.push('web_search');
  return [...new Set(allowed)];
}
