-- Usage rows for sokoban-solver-01-run-20261121.
-- Build subagent agent_id: 51229cf6-dd5a-464b-82e4-c07e50425c90
-- Fix subagent agent_id: e69ff279-0941-4eea-9e89-3b87281ce201
-- Parent (side-chat) agent_id: 0ea8babd-d5df-4633-8b50-be4da177ac79
SELECT u.agent_id AS agent_id, u.message_id AS message_id, u.created_at AS created_at, u.input_tokens AS input_tokens, u.output_tokens AS output_tokens, a.model AS model FROM agent.agent_message_token_usage u JOIN agent.agents a ON a.agent_id = u.agent_id WHERE u.agent_id IN ('51229cf6-dd5a-464b-82e4-c07e50425c90', 'e69ff279-0941-4eea-9e89-3b87281ce201', '0ea8babd-d5df-4633-8b50-be4da177ac79') ORDER BY u.created_at DESC LIMIT 500
