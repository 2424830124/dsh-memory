/**
 * Whether one agent is a delegated child.
 *
 * The answer matters in two places that must not disagree: writes are refused
 * for subagents, and a new subagent must not inherit the session's preset — it
 * is sent off to do one job, and giving it the user's persona would change how
 * it behaves too.
 *
 * @module dsh-memory/subagent
 */

/**
 * @param {object} agent - the live agent.
 * @returns {boolean} whether it is a subagent.
 */
export function isSubagentAgent(agent) {
  const header = agent?.session?.header
  if (header?.origin === 'subagent') return true
  if ((header?.delegationDepth ?? 0) > 0) return true
  return (agent?.options?.subagentDepth ?? 0) > 0
}
