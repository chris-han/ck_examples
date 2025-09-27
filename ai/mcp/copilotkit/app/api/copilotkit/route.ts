import {
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
} from '@copilotkit/runtime';
import OpenAI from 'openai';
import { NextRequest } from 'next/server';
import { MCPClient } from '@/app/utils/mcp-client';
import { AzureOpenAIAdapter } from '@/lib/azure-openai-adapter';

// Optional self-hosted agent endpoint exposed via CopilotKitRemoteEndpoint
const remoteEndpoint = process.env.COPILOTKIT_REMOTE_ENDPOINT;

const apiKey = process.env["AZURE_OPENAI_API_KEY"];
const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
const deployment = process.env["AZURE_OPENAI_DEPLOYMENT"];
const apiVersion = process.env["AZURE_OPENAI_API_VERSION"] || "2025-01-01-preview";

if (!apiKey) {
  throw new Error("The AZURE_OPENAI_API_KEY environment variable is missing or empty.");
}

if (!endpoint) {
  throw new Error("The AZURE_OPENAI_ENDPOINT environment variable is missing or empty.");
}

if (!deployment) {
  throw new Error("The AZURE_OPENAI_DEPLOYMENT environment variable is missing or empty.");
}

const normalizedEndpoint = endpoint.replace(/\/$/, "");
const openai = new OpenAI({
  apiKey,
  baseURL: `${normalizedEndpoint}/openai/deployments/${deployment}`,
  defaultQuery: { "api-version": apiVersion },
  defaultHeaders: { "api-key": apiKey },
});
const serviceAdapter = new AzureOpenAIAdapter({
  openai,
  maxAttempts: 2,
});
const runtime = new CopilotRuntime({
  remoteEndpoints: remoteEndpoint ? [{ url: remoteEndpoint }] : undefined,
  async createMCPClient(config) {
    const client = new MCPClient({
      serverUrl: config.endpoint,
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : undefined,
    });

    await client.connect();
    return client;
  },
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: '/api/copilotkit',
  });

  return handleRequest(req);
};
