"""Minimal FastAPI app exposing a CopilotKit remote endpoint.

Run with:

    uvicorn agent.main:app --host 127.0.0.1 --port 7000 --reload

This provides the /copilotkit_remote routes expected by the frontend.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastmcp.server.http import create_sse_app

from copilotkit import CopilotKitRemoteEndpoint
from copilotkit.agent import Agent as CopilotAgent
from copilotkit.integrations.fastapi import add_fastapi_endpoint
from copilotkit.types import Message, MessageRole
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider


PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Silence FastMCP dependency deprecation warnings emitted by the embedded
# ClickHouse server. The project manages dependencies directly, so the warning is
# not actionable for this integration.
os.environ.setdefault("FASTMCP_DEPRECATION_WARNINGS", "false")

# Load environment variables from the project root (.env) so the backend can reuse
# the same configuration as the Next.js runtime.
load_dotenv(PROJECT_ROOT / ".env")

# Ensure the ClickHouse MCP server package is importable without requiring a
# separate installation step. When the repository is cloned with the external
# submodule, the package lives under external/mcp-clickhouse.
EXTERNAL_MCP_PATH = PROJECT_ROOT / "external" / "mcp-clickhouse"
if EXTERNAL_MCP_PATH.exists():
    sys.path.append(str(EXTERNAL_MCP_PATH))
else:  # pragma: no cover - developer misconfiguration
    raise RuntimeError(
        "The mcp-clickhouse package was not found at external/mcp-clickhouse. "
        "Install the MCP server dependencies before starting the agent."
    )

from mcp_clickhouse.mcp_server import (  # type: ignore  # noqa: E402
    mcp,
    list_databases,
    list_tables,
    run_select_query,
)


class AgentState(BaseModel):
    """Conversation state synced back to the CopilotKit frontend."""

    messages: List[Dict[str, Any]] = Field(default_factory=list)


class ClickHouseQueryResult(BaseModel):
    """Structured response returned from ClickHouse SELECT queries."""

    columns: List[str]
    rows: List[List[Any]]


def build_azure_model() -> OpenAIChatModel:
    """Configure an OpenAI-compatible model pointing at Azure OpenAI."""

    azure_key = os.getenv("AZURE_OPENAI_API_KEY")
    azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    azure_deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT")
    azure_api_version = os.getenv("AZURE_OPENAI_API_VERSION")

    if not all([azure_key, azure_endpoint, azure_deployment]):
        raise RuntimeError(
            "Azure OpenAI environment variables are not fully configured. "
            "Please set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and "
            "AZURE_OPENAI_DEPLOYMENT in the project .env file."
        )

    provider = AzureProvider(
        azure_endpoint=azure_endpoint,
        api_key=azure_key,
        api_version=azure_api_version,
    )

    # For Azure, the "model" parameter corresponds to the deployment name.
    return OpenAIChatModel(model_name=azure_deployment, provider=provider)


model = build_azure_model()
pydantic_agent = Agent(
    model=model,
    name="self_hosted_agent",
    system_prompt=(
        "You are the ClickHouse analytics copilot. Use the registered tools to "
        "inspect schema metadata and answer questions with concise summaries."
        " Always validate SQL before running it and prefer aggregated insights "
        "over raw row dumps."
    ),
)


@pydantic_agent.tool
async def clickhouse_list_databases(ctx: RunContext[AgentState]) -> List[str]:
    """Return the list of available databases in the configured ClickHouse cluster."""

    raw = list_databases()
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:  # pragma: no cover - defensive
            raise ValueError(f"Unexpected ClickHouse response: {raw}") from error
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    if isinstance(raw, list):
        return [str(item) for item in raw]
    raise ValueError(f"Failed to fetch databases: {raw!r}")


@pydantic_agent.tool
async def clickhouse_list_tables(
    ctx: RunContext[AgentState],
    database: str,
    like: Optional[str] = None,
    not_like: Optional[str] = None,
) -> List[dict[str, Any]]:
    """Inspect table metadata for a database, including schemas and row counts."""

    tables = list_tables(database=database, like=like, not_like=not_like)
    if isinstance(tables, list):
        return tables
    raise ValueError(f"Failed to fetch tables: {tables!r}")


@pydantic_agent.tool
async def clickhouse_run_query(
    ctx: RunContext[AgentState],
    sql: str,
) -> ClickHouseQueryResult:
    """Execute a read-only SQL query against ClickHouse and return the result grid."""

    result = run_select_query(sql)
    if isinstance(result, dict) and result.get("status") == "error":
        raise ValueError(result.get("message") or "ClickHouse query failed")

    if isinstance(result, dict) and {"columns", "rows"}.issubset(result):
        return ClickHouseQueryResult(
            columns=[str(column) for column in result["columns"]],
            rows=[list(row) for row in result["rows"]],
        )

    raise ValueError(f"Unexpected ClickHouse response: {result!r}")


class PydanticAIAgent(CopilotAgent):
    """Adapt a Pydantic AI agent to the CopilotKit Agent interface."""

    def __init__(
        self,
        *,
        name: str,
        description: Optional[str] = None,
        agent: Agent,
    ) -> None:
        super().__init__(name=name, description=description)
        self._agent = agent
        self._threads: Dict[str, List[dict]] = {}

    def execute(  # type: ignore[override]
        self,
        *,
        state: dict,
        config: Optional[dict] = None,
        messages: List[Message],
        thread_id: str,
        actions: Optional[List[dict]] = None,
        meta_events: Optional[List[dict]] = None,
        **kwargs,
    ) -> AsyncGenerator[str, None]:
        node_name = kwargs.get("node_name") or "__end__"
        return self._event_stream(
            state=state,
            messages=messages,
            thread_id=thread_id,
            node_name=node_name,
        )

    async def _event_stream(
        self,
        *,
        state: dict,
        messages: List[Message],
        thread_id: str,
        node_name: str,
    ) -> AsyncGenerator[str, None]:
        history, user_prompt = self._build_history(messages)

        if user_prompt is None:
            return

        normalized_messages = [self._normalize_message(msg) for msg in messages]

        try:
            result = await self._agent.run(
                user_prompt,
                message_history=history if history else None,
                deps=AgentState(messages=normalized_messages),
            )
        except Exception as error:  # pragma: no cover - surface meaningful errors to the UI
            error_payload = {
                "event": "on_copilotkit_error",
                "data": {
                    "error": {
                        "type": type(error).__name__,
                        "message": str(error),
                        "agent_name": self.name,
                        "node_name": node_name,
                    },
                    "thread_id": thread_id,
                    "agent_name": self.name,
                    "node_name": node_name,
                },
            }
            yield json.dumps(error_payload) + "\n"
            raise

        assistant_message = str(result.output)
        message_id = str(uuid.uuid4())

        yield self._emit_manual_message(message_id, assistant_message)

        normalized_messages.append(self._build_assistant_message(message_id, assistant_message))

        if thread_id:
            self._threads[thread_id] = normalized_messages

        state_snapshot = dict(state or {})
        state_snapshot["messages"] = normalized_messages
        state_snapshot.setdefault("copilotkit", {}).setdefault("actions", [])

        yield self._emit_state_sync(
            thread_id=thread_id,
            node_name=node_name,
            state=state_snapshot,
        )

    def _build_history(
        self,
        messages: List[Message],
    ) -> tuple[List[ModelMessage], Optional[str]]:
        history: List[ModelMessage] = []
        user_prompt: Optional[str] = None

        for message in messages:
            role = message.get("role")
            content = message.get("content")
            if content is None:
                continue

            if isinstance(role, MessageRole):
                role = role.value

            if role == MessageRole.USER.value:
                history.append(
                    ModelRequest(parts=[UserPromptPart(content)])
                )
                user_prompt = content
            elif role == MessageRole.ASSISTANT.value:
                history.append(
                    ModelResponse(parts=[TextPart(content)])
                )

        if history and isinstance(history[-1], ModelRequest):
            # Extract the latest user prompt and remove it from history so run() treats it as the new input.
            user_prompt = history[-1].parts[0].content  # type: ignore[attr-defined]
            history = history[:-1]

        return history, user_prompt

    def _emit_manual_message(self, message_id: str, content: str) -> str:
        payload = {
            "event": "on_custom_event",
            "name": "copilotkit_manually_emit_message",
            "data": {
                "message_id": message_id,
                "message": content,
            },
        }
        return json.dumps(payload) + "\n"

    def _emit_state_sync(self, *, thread_id: str, node_name: str, state: dict) -> str:
        payload = {
            "event": "on_copilotkit_state_sync",
            "thread_id": thread_id or "",
            "run_id": str(uuid.uuid4()),
            "agent_name": self.name,
            "node_name": node_name,
            "active": False,
            "state": state,
            "running": False,
            "role": "assistant",
        }
        return json.dumps(payload) + "\n"

    def _normalize_message(self, message: Message) -> dict:
        normalized = dict(message)
        role = normalized.get("role")
        if isinstance(role, MessageRole):
            normalized["role"] = role.value

        normalized.setdefault("id", str(uuid.uuid4()))
        created_at = normalized.get("createdAt")
        if isinstance(created_at, datetime):
            normalized["createdAt"] = created_at.isoformat()
        elif not created_at:
            normalized["createdAt"] = datetime.now(timezone.utc).isoformat()

        return normalized

    def _build_assistant_message(self, message_id: str, content: str) -> dict:
        return {
            "id": message_id,
            "role": MessageRole.ASSISTANT.value,
            "content": content,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

    async def get_state(self, *, thread_id: str):  # type: ignore[override]
        if not thread_id or thread_id not in self._threads:
            return {
                "threadId": thread_id or "",
                "threadExists": False,
                "state": {},
                "messages": [],
            }

        messages = self._threads[thread_id]
        return {
            "threadId": thread_id,
            "threadExists": True,
            "state": {"messages": messages, "copilotkit": {"actions": []}},
            "messages": messages,
        }


app = FastAPI()

# Expose the SSE transport from the ClickHouse MCP server under /mcp so the
# Next.js runtime can connect through the same FastAPI process. The FastMCP
# helper `sse_app` is deprecated, so construct the Starlette app directly.
deprecated_settings = mcp._deprecated_settings  # type: ignore[attr-defined]
MCP_SSE_APP = create_sse_app(
    server=mcp,
    message_path=deprecated_settings.message_path,
    sse_path="/sse",
    auth=mcp.auth,
    debug=deprecated_settings.debug,
)
app.mount("/mcp", MCP_SSE_APP)

remote_endpoint = CopilotKitRemoteEndpoint(
    agents=[
        PydanticAIAgent(
            name="self_hosted_agent",
            description="Simple Pydantic AI agent running in FastAPI.",
            agent=pydantic_agent,
        )
    ]
)

add_fastapi_endpoint(app, remote_endpoint, "/copilotkit_remote")
