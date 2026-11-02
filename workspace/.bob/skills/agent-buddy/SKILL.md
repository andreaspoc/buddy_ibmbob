---
name: agent-buddy
description: Query, delegate tasks to, or interact with external A2A (Agent-to-Agent)
  agents on the network. Use this skill whenever the user mentions a remote agent,
  an external agent, delegating work to another agent, or querying an A2A service.
user-invocable: true
---

# Agent-to-Agent (A2A) Interaction Skill

You have access to the `a2a` command-line tool, which communicates over standard A2A JSON-RPC protocols with registered external AI agents on the network.

## 1. Discover Registered Agents

To see what remote agents are available, their capabilities, and their slug identifiers:
```bash
a2a list
```
Review the list and select the agent whose name or description matches the user's task (e.g., database agent, research agent, analytics agent).

If `a2a list` reports that no agents are registered, explain to the user that they can register external agents using the **"＋"** button next to **A2A AGENTS** in the sidebar.

## 2. Querying or Delegating to an Agent

Send a question, instructions, or delegation prompt to the agent:
```bash
a2a ask <agent_slug> "<prompt>"
```

### Examples:
- Asking for data or analysis:
  ```bash
  a2a ask analytics-agent "Summarize active users and conversion metrics for September"
  ```
- Asking for code or schema:
  ```bash
  a2a ask db-agent "What are the table definitions for the orders and customers tables?"
  ```
- Delegating a complex subtask:
  ```bash
  a2a ask research-agent "Provide 5 key competitive advantages of our new product tier"
  ```

## 3. Working with Responses

1. **Synthesize & Execute**: Combine the external agent's output with your own tools (e.g. writing files, generating presentations, answering user questions).
2. **Attribution**: Always explicitly indicate in your response which external agent provided the data or findings (e.g., *"According to data retrieved from `analytics-agent`..."*).
3. **Error Handling**: If the remote agent is unreachable, errors, or times out, inform the user with the exact error and suggest verifying the agent's endpoint.
