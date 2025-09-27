This is an example of how to build an agentic application using data stored in ClickHouse. It uses the [ClickHouse MCP Server](https://github.com/ClickHouse/mcp-clickhouse) to query data from ClickHouse and generate charts based on the data. 

[CopilotKit](https://github.com/CopilotKit/CopilotKit) is used to build the UI and provide a chat interface to the user.

# Prerequisites

- Node.js >= 20.14.0
- uv >= 0.1.0

# Project structure

```
ai/mcp/copilotkit
├── agent/                # FastAPI service hosting the Pydantic AI agent and MCP SSE bridge
├── app/                  # Next.js App Router routes (API endpoints backing CopilotKit)
├── components/           # React components used across the dashboard UI
├── external/mcp-clickhouse/ # Vendored ClickHouse MCP server implementation
├── lib/                  # Shared frontend utilities (e.g., chart helpers)
├── public/               # Static assets served by Next.js
├── scripts/              # Utility scripts (setup_venv.sh for bootstrapping uv environments)
└── env.example           # Sample environment configuration copied to .env
```

# Install dependencies

Clone the project locally: `git clone https://github.com/ClickHouse/examples` and navigate to the `ai/mcp/copilotkit` directory.

Skip this section and run the script `./install.sh` to install dependencies. If you want to install dependencies manually, follow the instructions below.

## Install dependencies manually

1. Install dependencies: 

Run `npm install` to install node dependencies.

2. Install mcp-clickhouse:

Create a new folder `external` and clone the mcp-clickhouse repository into it.

```
mkdir -p external
git clone https://github.com/ClickHouse/mcp-clickhouse external/mcp-clickhouse
```

Install Python dependencies and add fastmcp cli tool.

```
cd external/mcp-clickhouse
uv sync
uv add fastmcp

### Using uv for this project

This project uses `uv` as the default Python package & project manager. We've included a helper script and VS Code task to bootstrap the project's `.venv` and sync dependencies.


From the repository root:

```bash
./scripts/setup_venv.sh
```

Or use the VS Code Task: open the Command Palette -> "Tasks: Run Task" -> "Setup agent/.venv with uv".

After the `agent/.venv` is created you can activate it with:

```bash
source agent/.venv/bin/activate
```

If you prefer to use `pip` directly, the README still contains notes above. `uv` provides a `uv pip` command compatible with `pip` workflows (`uv pip sync`, `uv pip install -r requirements.txt`, etc.).

### pyenv / direnv notes

If you use `pyenv` and have previously run `pyenv shell 3.12.11` (or similar), it may set `PYENV_VERSION` in your shell and override local virtualenvs. To ensure the project's `agent/.venv` takes precedence:

- Install `direnv` and run `direnv allow` inside the `agent/` directory after cloning. The provided `agent/.envrc` unsets `PYENV_VERSION` and puts `agent/.venv/bin` first in PATH so the local venv is used.
- Or, unset any shell-level pyenv setting before working in the project:

```bash
pyenv shell --unset
# or in bash/zsh
unset PYENV_VERSION
```

The repo also includes `agent/.python-version` set to `system` so a `pyenv local` won't force a different version inside the `agent/` folder.
```

# Configure the application

Copy the `env.example` file to `.env` and populate the Azure OpenAI connection
settings:

- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (optional, defaults to `2025-01-01-preview`)

These variables are shared by both the Next.js runtime and the FastAPI backend so
the same Azure deployment is used throughout the stack.

The `.env` file also defines `NEXT_PUBLIC_MCP_ENDPOINT`, which defaults to
`http://localhost:7000/mcp/sse`. This points to the ClickHouse MCP server that is
exposed from the backend FastAPI process under the `/mcp` prefix.

## Bring your own LLM

The sample is wired to Azure OpenAI by default. If you'd prefer a different
provider, adjust the [Copilotkit runtime](./app/api/copilotkit/route.ts) and the
Pydantic AI configuration in [agent/main.py](./agent/main.py). The
[CopilotKit bring-your-own-LLM guide](https://docs.copilotkit.ai/direct-to-llm/guides/bring-your-own-llm)
lists the supported adapters.

## Use your own ClickHouse cluster

By default, the example is configured to connect to the [ClickHouse demo cluster](https://sql.clickhouse.com/). You can also use your own ClickHouse cluster by setting the following environment variables:

- `CLICKHOUSE_HOST`
- `CLICKHOUSE_PORT`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`
- `CLICKHOUSE_SECURE`

# Run the application

Run `npm run dev` to start the development server.

You can test the Agent using prompt like: "Show me the price evolution in Manchester for the last 10 years.", please note that this is only a demo and a lot of edge cases have not been tested.

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Self-host the Copilot agent

CopilotKit supports delegating requests to a self-hosted remote agent. Follow the [CopilotKit remote endpoint guide](https://docs.copilotkit.ai/direct-to-llm/guides/backend-actions/remote-backend-endpoint) to stand up a FastAPI (or equivalent) service that exposes `/copilotkit_remote`. A minimal FastAPI example from the docs looks like:

```py
from fastapi import FastAPI
from copilotkit import CopilotKitRemoteEndpoint, LangGraphAgent
from copilotkit.integrations.fastapi import add_fastapi_endpoint

app = FastAPI()

sdk = CopilotKitRemoteEndpoint(
    agents=[
        LangGraphAgent(
            name="sample_agent",
            description="Agent backed by your LangGraph workflow",
            graph=graph,
        )
    ],
)

add_fastapi_endpoint(app, sdk, "/copilotkit_remote")
```

Update `.env` with your remote URL (`COPILOTKIT_REMOTE_ENDPOINT`) and the public license key used by the frontend (`NEXT_PUBLIC_COPILOTKIT_LICENSE_KEY`). The example environment defaults to `http://localhost:7000/copilotkit_remote`; adjust the host/port if your agent runs elsewhere. When present, the Next.js runtime will automatically route requests through the remote agent while still supporting Model Context Protocol connections configured in `components/Analytics.tsx`.

This repository also includes a fully working sample under `agent/main.py` that
uses the PydanticAI agent framework and exposes the ClickHouse MCP server.
To try it out:

```bash
cd agent
pip install -r requirements.txt  # or uv pip install -r requirements.txt
uvicorn agent.main:app --host 127.0.0.1 --port 7000 --reload
```

The sample expects the Azure OpenAI variables listed above in the environment so
the PydanticAI agent can call your deployment. Keep the server running and start
the Next.js app (`npm run dev`) in a separate terminal. The MCP SSE endpoint is
served from the same FastAPI process at `http://127.0.0.1:7000/mcp/sse`.
