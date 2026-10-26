import type {PresenceEvent, State} from '../protocol.js';

export const dimagentHookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop'] as const;

const states: Record<string, State> = {SessionStart: 'idle', UserPromptSubmit: 'working',
  PreToolUse: 'working', PostToolUse: 'working', PermissionRequest: 'waiting',
  PreCompact: 'working', PostCompact: 'working', Stop: 'idle'};

/** Translate DimAgent's command hooks into the existing presence protocol. */
export function dimagentHookEvent(payload: Record<string, unknown>, now = Date.now()): PresenceEvent | undefined {
  const name = payload.hook_event_name;
  if (!dimagentHookEvents.includes(name as typeof dimagentHookEvents[number]) ||
      typeof payload.session_id !== 'string' || !payload.session_id) return;
  // Child events carry the parent's session_id; agent_id identifies the child.
  if (name === 'SubagentStart' || name === 'SubagentStop') {
    if (typeof payload.agent_id !== 'string' || !payload.agent_id || payload.agent_id === payload.session_id) return;
    return {version: 1, agent: 'dimagent', sessionId: payload.agent_id,
      state: name === 'SubagentStop' ? 'closed' : 'working', updatedAt: now};
  }
  // Stop has no completed reply; do not infer one from prompts or tool output.
  return {version: 1, agent: 'dimagent', sessionId: payload.session_id,
    state: name === 'SessionStart' && payload.source === 'compact' ? 'working' : states[name as string], updatedAt: now,
    ...(typeof payload.model === 'string' ? {model: payload.model} : {})};
}
