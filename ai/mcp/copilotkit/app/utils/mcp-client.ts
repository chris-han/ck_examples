import { MCPTool, MCPClient as MCPClientInterface } from "@copilotkit/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type JsonSchema = Record<string, unknown>;

interface ToolSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ToolSchema>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: ToolSchema;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isToolDefinition = (value: unknown): value is ToolDefinition => {
  if (!isPlainObject(value)) {
    return false;
  }

  return typeof value.name === "string";
};

export interface McpClientOptions {
  serverUrl: string;
  headers?: Record<string, string>;
  onMessage?: (message: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * McpClient - A Model Context Protocol client implementation
 *
 * This class implements the Model Context Protocol (MCP) client, which allows for
 * standardized communication with MCP servers. It's designed to be compatible with
 * CopilotKit's runtime by exposing the required interface.
 *
 * The main methods required by CopilotKit are:
 * - tools(): Returns a map of tool names to MCPTool objects
 * - close(): Closes the connection to the MCP server
 */
export class MCPClient implements MCPClientInterface {
  private client: Client;
  private transport: SSEClientTransport;
  private serverUrl: URL;
  private onMessage: (message: Record<string, unknown>) => void;
  private onError: (error: Error) => void;
  private onOpen: () => void;
  private onClose: () => void;
  private isConnected = false;
  private headers?: Record<string, string>;

  // Cache for tools to avoid repeated fetches
  private toolsCache: Record<string, MCPTool> | null = null;

  constructor(options: McpClientOptions) {
    this.serverUrl = new URL(options.serverUrl);
    this.headers = options.headers;
    this.onMessage =
      options.onMessage ||
      ((message) => console.log("Message received:", message));
    this.onError =
      options.onError || ((error) => console.error("Error:", error));
    this.onOpen = options.onOpen || (() => console.log("Connection opened"));
    this.onClose = options.onClose || (() => console.log("Connection closed"));

    // Initialize the SSE transport with headers
    this.transport = new SSEClientTransport(this.serverUrl, this.headers);

    // Initialize the client
    this.client = new Client({
      name: "cpk-mcp-client",
      version: "0.0.1",
    });

    // Set up event handlers
    this.transport.onmessage = this.handleMessage.bind(this);
    this.transport.onerror = this.handleError.bind(this);
    this.transport.onclose = this.handleClose.bind(this);
  }

  private handleMessage(message: JSONRPCMessage): void {
    try {
      this.onMessage(message as Record<string, unknown>);
    } catch (error) {
      this.onError(
        error instanceof Error
          ? error
          : new Error(`Failed to handle message: ${error}`)
      );
    }
  }

  private handleError(error: Error): void {
    this.onError(error);
    if (this.isConnected) {
      this.isConnected = false;
      // Could implement reconnection logic here
    }
  }

  private handleClose(): void {
    this.isConnected = false;
    this.onClose();
  }

  /**
   * Connects to the MCP server using SSE
   */
  public async connect(): Promise<void> {
    try {
      console.log("Connecting to MCP server:", this.serverUrl.href);

      // Connect the client (which connects the transport)
      await this.client.connect(this.transport);

      this.isConnected = true;
      console.log("Connected to MCP server");
      this.onOpen();
    } catch (error) {
      console.error("Failed to connect to MCP server:", error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Returns a map of tool names to MCPTool objects
   * This method matches the expected CopilotKit interface
   */
  public async tools(): Promise<Record<string, MCPTool>> {
    try {
      // Return from cache if available
      if (this.toolsCache) {
        return this.toolsCache;
      }

      // Fetch raw tools data
      const rawToolsResult = await this.client.listTools();

      // Transform to the expected format
      const toolsMap: Record<string, MCPTool> = {};
      const toolsArray = this.extractTools(rawToolsResult);

      toolsArray.forEach((tool) => {
        const requiredParams = Array.isArray(tool.inputSchema?.required)
          ? tool.inputSchema?.required ?? []
          : [];

        let enhancedDescription = tool.description ?? "";
        if (requiredParams.length > 0) {
          enhancedDescription += `\nRequired parameters: ${requiredParams.join(", ")}`;
        }

        const exampleInput = this.deriveExampleInput(tool.inputSchema, tool.name);
        if (exampleInput) {
          enhancedDescription += `\nExample usage: ${exampleInput}`;
        }

        toolsMap[tool.name] = {
          description: enhancedDescription,
          schema: (tool.inputSchema as JsonSchema) ?? {},
          execute: async (args: Record<string, unknown>) => {
            return this.callTool(tool.name, args);
          },
        };
      });

      // Cache the result
      this.toolsCache = toolsMap;

      return toolsMap;
    } catch (error) {
      console.error("Error fetching tools:", error);
      // Return empty map on error rather than throwing
      return {};
    }
  }

  /**
   * Close the connection to the MCP server
   * This method matches the expected CopilotKit interface
   */
  public async close(): Promise<void> {
    return this.disconnect();
  }

  /**
   * Disconnects from the MCP server
   * (Legacy method, prefer using close() for compatibility with CopilotKit)
   */
  public async disconnect(): Promise<void> {
    try {
      // Clear the tools cache
      this.toolsCache = null;

      // Close the transport connection
      await this.transport.close();
      this.isConnected = false;
      console.log("Disconnected from MCP server");
    } catch (error) {
      console.error("Error disconnecting from MCP server:", error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Call a tool with the given name and arguments
   * @param name Tool name
   * @param args Tool arguments
   * @returns Tool execution result
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    try {
      console.log(
        `Calling tool: ${name} with args:`,
        JSON.stringify(args, null, 2)
      );

      // Generic handler for double-nested params structure
      const fixedArgs = this.normalizeToolArgs(args);

      // Process string-encoded JSON objects
      const processedArgs = this.processStringifiedJsonArgs(fixedArgs);
      const paramsCandidate = processedArgs.params;

      if (isPlainObject(paramsCandidate)) {
        const cleanedParams = Object.keys(paramsCandidate).length > 0 ? paramsCandidate : {};

        console.log(
          `Processed args for ${name}:`,
          JSON.stringify(cleanedParams, null, 2)
        );

        return this.client.callTool({
          name,
          arguments: cleanedParams,
        });
      }

      const argumentsToSend = Object.keys(processedArgs).length === 0 ? {} : processedArgs;

      console.log(
        `Processed args for ${name}:`,
        JSON.stringify(argumentsToSend, null, 2)
      );

      return this.client.callTool({
        name,
        arguments: argumentsToSend,
      });
    } catch (error) {
      console.error(`Error calling tool ${name}:`, error);
      throw error;
    }
  }

  /**
   * Normalize tool arguments - detects and fixes common patterns in LLM tool calls
   * like double-nested params objects
   */
  private normalizeToolArgs(
    args: Record<string, unknown>
  ): Record<string, unknown> {
    // Handle double-nested params: { params: { params: { actual data } } }
    const paramsCandidate = args.params;
    if (isPlainObject(paramsCandidate) && "params" in paramsCandidate) {
      const nestedParams = (paramsCandidate as Record<string, unknown>).params;
      if (isPlainObject(nestedParams)) {
        console.log("Detected double-nested params, fixing structure");
        return paramsCandidate;
      }
    }

    return args;
  }

  /**
   * Process arguments to handle cases where JSON strings might be passed instead of objects
   */
  private processStringifiedJsonArgs(
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      result[key] = this.normalizeValue(value);
    }

    return result;
  }

  /**
   * Derives an example input structure from a tool's inputSchema
   * This helps the LLM understand how to format requests properly
   */
  private deriveExampleInput(
    inputSchema: ToolSchema | undefined,
    toolName: string
  ): string | null {
    if (!inputSchema) return null;

    try {
      // Handle special cases for better guidance
      if (toolName.toLowerCase().includes("asana_create")) {
        return '{ "params": { "data": { "name": "Task name", "notes": "Task description" } } }';
      }

      if (inputSchema.type === "object" && inputSchema.properties) {
        // Build a minimal example object
        const example: Record<string, unknown> = {};
        const props = inputSchema.properties ?? {};

        // Add required properties first
        if (Array.isArray(inputSchema.required)) {
          inputSchema.required.forEach((key: string) => {
            const propertySchema = props?.[key];
            if (!propertySchema) return;

            if (propertySchema.type === "object" && propertySchema.properties) {
              example[key] = this.createExampleObject(propertySchema);
            } else if (propertySchema.type === "string") {
              example[key] = `Example ${key}`;
            } else if (propertySchema.type === "number") {
              example[key] = 123;
            } else if (propertySchema.type === "boolean") {
              example[key] = true;
            } else {
              example[key] = null;
            }
          });
        }

        return JSON.stringify(example, null, 2);
      }

      return null;
    } catch (error) {
      console.error("Error creating example input:", error);
      return null;
    }
  }

  /**
   * Creates an example object from an object schema
   */
  private createExampleObject(schema: ToolSchema): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (schema.type !== "object" || !schema.properties) {
      return result;
    }

    const props = schema.properties ?? {};

    // Add required properties
    if (Array.isArray(schema.required)) {
      schema.required.forEach((key: string) => {
        const propertySchema = props?.[key];
        if (!propertySchema) return;

        if (propertySchema.type === "object" && propertySchema.properties) {
          result[key] = this.createExampleObject(propertySchema);
        } else if (propertySchema.type === "string") {
          result[key] = `Example ${key}`;
        } else if (propertySchema.type === "number") {
          result[key] = 123;
        } else if (propertySchema.type === "boolean") {
          result[key] = true;
        } else {
          result[key] = null;
        }
      });
    }

    return result;
  }

  private extractTools(result: unknown): ToolDefinition[] {
    if (Array.isArray(result)) {
      return result.filter(isToolDefinition);
    }

    if (isPlainObject(result) && Array.isArray((result as { tools?: unknown }).tools)) {
      return ((result as { tools?: unknown }).tools as unknown[]).filter(isToolDefinition);
    }

    return [];
  }

  private normalizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizeValue(entry));
    }

    if (isPlainObject(value)) {
      return this.processStringifiedJsonArgs(value);
    }

    return value;
  }
}
