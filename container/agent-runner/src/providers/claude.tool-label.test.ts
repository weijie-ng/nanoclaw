import { describe, it, expect, mock } from 'bun:test';

// The host's progress message shows the agent's recent tool calls. A bare tool
// name ("Bash · Read · Grep") says almost nothing on a long turn, so the
// PreToolUse hook reduces each call's input to the one field that identifies
// it. These pin the two properties the host depends on: every label fits one
// chat line, and a tool with nothing worth showing degrades to its bare name
// rather than an empty "Bash()".

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (async function* () {})(),
}));

const { summarizeToolInput, toolLabel, displayToolName, blockedSkillName } = await import('./claude.js');

/** Mirrors TOOL_DETAIL_MAX in claude.ts. */
const DETAIL_MAX = 44;

describe('summarizeToolInput', () => {
  it('picks the identifying field per tool', () => {
    expect(summarizeToolInput('Bash', { command: 'pnpm test -- progress', timeout: 600_000 })).toBe(
      'pnpm test -- progress',
    );
    expect(summarizeToolInput('WebSearch', { query: 'telegram edit rate limits' })).toBe(
      'telegram edit rate limits',
    );
    expect(summarizeToolInput('Task', { description: 'audit the router', prompt: 'a very long prompt…' })).toBe(
      'audit the router',
    );
  });

  it('keeps two path segments — a bare basename is ambiguous', () => {
    expect(summarizeToolInput('Read', { file_path: '/workspace/src/modules/progress/index.ts' })).toBe(
      'progress/index.ts',
    );
    expect(summarizeToolInput('Edit', { file_path: 'notes.md' })).toBe('notes.md');
  });

  it('pairs a Grep pattern with where it is searching', () => {
    expect(summarizeToolInput('Grep', { pattern: 'recent_tools', path: 'src/modules' })).toBe(
      'recent_tools · src/modules',
    );
    expect(summarizeToolInput('Grep', { pattern: 'recent_tools' })).toBe('recent_tools');
  });

  it('reduces a fetched url to its host', () => {
    expect(summarizeToolInput('WebFetch', { url: 'https://core.telegram.org/bots/api#editmessagetext' })).toBe(
      'core.telegram.org',
    );
    // Not a url at all — still better shown than dropped.
    expect(summarizeToolInput('WebFetch', { url: 'core.telegram.org/bots' })).toBe('core.telegram.org/bots');
  });

  it('falls back to the first string field for MCP tools', () => {
    expect(summarizeToolInput('mcp__nanoclaw__send_message', { destination: 'ops', text: 'done' })).toBe('ops');
    expect(summarizeToolInput('mcp__nanoclaw__list_destinations', {})).toBe('');
  });

  it('flattens and clamps so one call can never own the message', () => {
    const detail = summarizeToolInput('Bash', {
      command: 'for f in $(git ls-files);\n  do echo "$f";\ndone | sort -u | head -50',
    });
    expect(detail.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect(detail).not.toContain('\n');
    expect(detail.endsWith('…')).toBe(true);
  });

  it('returns nothing when the field it wants is absent or not a string', () => {
    expect(summarizeToolInput('Bash', { timeout: 5 })).toBe('');
    expect(summarizeToolInput('Read', undefined)).toBe('');
    expect(summarizeToolInput('Grep', { pattern: '   ' })).toBe('');
  });
});

describe('displayToolName', () => {
  it('strips the mcp__server__ prefix that would eat a whole line', () => {
    expect(displayToolName('mcp__nanoclaw__send_message')).toBe('send_message');
    expect(displayToolName('Bash')).toBe('Bash');
  });
});

describe('blockedSkillName', () => {
  // claude-api's SKILL.md is ~800KB and loads in one shot, so a single call
  // overflows the context window — an agent asked "what model are you?" answers
  // "Prompt is too long" instead. It ships inside the image, so the group's
  // `skills` config cannot exclude it; PreToolUse is the only gate.
  it('names the skill on a Skill call that would blow the context window', () => {
    expect(blockedSkillName('Skill', { skill: 'claude-api' })).toBe('claude-api');
  });

  it('lets every other skill through', () => {
    expect(blockedSkillName('Skill', { skill: 'onecli-gateway' })).toBe('');
    expect(blockedSkillName('Skill', {})).toBe('');
  });

  it('ignores non-Skill tools, including one carrying a same-named argument', () => {
    expect(blockedSkillName('Bash', { skill: 'claude-api' })).toBe('');
    expect(blockedSkillName('Read', undefined)).toBe('');
  });
});

describe('toolLabel', () => {
  it('renders name(detail), or the bare name when there is no detail', () => {
    expect(toolLabel('Bash', { command: 'pnpm build' })).toBe('Bash(pnpm build)');
    expect(toolLabel('TodoWrite', {})).toBe('TodoWrite');
    expect(toolLabel('mcp__nanoclaw__send_message', { destination: 'ops' })).toBe('send_message(ops)');
  });
});
