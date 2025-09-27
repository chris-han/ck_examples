
"use client";
import React, { useCallback, useEffect, useState } from "react";
import ChartsGrid from "./ChartsGrid";
import { useCopilotChat, useCopilotAction, CatchAllActionRenderProps } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { DefaultToolRender } from "./DefaultToolRenderer";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotKitCSSProperties } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import "./copilotkit.css";
import SSEStatusIndicator from "./SSEStatusIndicator";
import type { ComponentsMap } from "@copilotkit/react-ui";

const markdownOverrides: ComponentsMap = {
    p: ({ children, ...props }) => {
        const childArray = React.Children.toArray(children);
        const containsBlock = childArray.some((child) => {
            if (!React.isValidElement(child)) {
                return false;
            }

            const type = child.type;
            if (typeof type === "string") {
                return ["div", "pre", "table", "ol", "ul"].includes(type);
            }

            const displayName = (type as { displayName?: string; name?: string }).displayName || (type as { name?: string }).name || "";
            return /codeblock/i.test(displayName);
        });

        const Wrapper = containsBlock ? "div" : "p";

        return (
            <Wrapper className="copilotKitMarkdownElement" {...props}>
                {children}
            </Wrapper>
        );
    },
};

const runtimeUrl = process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL || "/api/copilotkit";
const publicLicenseKey = process.env.NEXT_PUBLIC_COPILOTKIT_LICENSE_KEY;
const publicApiKey = process.env.NEXT_PUBLIC_COPILOT_API_KEY;

const identityProps: Record<string, string> = {};
if (publicLicenseKey) {
    identityProps.publicLicenseKey = publicLicenseKey;
} else if (publicApiKey) {
    identityProps.publicApiKey = publicApiKey;
}

export default function Analytics() {
    return (
        <CopilotKit
            runtimeUrl={runtimeUrl}
            {...identityProps}
        >
            <main className="p-8" style={
                    {
                    "--copilot-kit-background-color": "#282828",
                    } as CopilotKitCSSProperties
                }>
                <CopilotSidebar
                    Header={SideBarHeader}
                    clickOutsideToClose={true}
                    defaultOpen={true}
                    instructions="You are a FinOps expert who uses the MCP ClickHouse tool to analyze cloud spending data and provide optimization suggestions across both rate and workload dimensions. Focus on actionable insights backed by the available data."
                    labels={{
                        title: "Popup Assistant",
                        initial: "👋 Hi there! I'm your FinOps copilot."
                    }}
                    markdownTagRenderers={markdownOverrides}
                ><MainContent/></CopilotSidebar>
            </main>
        </CopilotKit>
    )
}

function SideBarHeader() {
    const { reset } = useCopilotChat();
    return (
        <div className="flex items-center justify-between p-4">
            <p className="text-white content-center font-inter font-bold text-lg">Explorer assistant</p>
            <div className="flex items-center gap-4">
                <SSEStatusIndicator />
                <button
                    className="px-6 py-3 hover:cursor-pointer text-[#FAFF69]"
                    onClick={() => reset()}
                >
                    Clear
                </button>
            </div>
        </div>
    );
}

type ToolCallSnapshot = {
    name?: string;
    args?: unknown;
    result?: unknown;
};

function ToolRenderRecorder({ onComplete, ...props }: CatchAllActionRenderProps<[]> & { onComplete: (payload: ToolCallSnapshot) => void }) {
    const { status, name, args, result } = props;

    useEffect(() => {
        if (status === "complete") {
            onComplete({ name, args, result });
        }
    }, [status, name, args, result, onComplete]);

    return <DefaultToolRender {...props} />;
}

function MainContent() {
    const { setMcpServers, reset } = useCopilotChat();
    const [latestToolCall, setLatestToolCall] = useState<ToolCallSnapshot | null>(null);

    useEffect(() => {
        setMcpServers([
            {
                endpoint: process.env.NEXT_PUBLIC_MCP_ENDPOINT || "http://localhost:7000/sse",
            },
        ]);
    }, [setMcpServers]);

    const handleToolComplete = useCallback((snapshot: ToolCallSnapshot) => {
        setLatestToolCall(snapshot);
    }, []);

    // 🪁 Catch-all Action for rendering MCP tool calls: https://docs.copilotkit.ai/guides/generative-ui?gen-ui-type=Catch+all+renders
    useCopilotAction({
        name: "*",
        render: (renderProps: CatchAllActionRenderProps<[]>) => (
            <ToolRenderRecorder {...renderProps} onComplete={handleToolComplete} />
        ),
    });

    useCopilotAction({
        name: "clearContext",
        description: "Clear the context of the chat.",
        handler: async () => {
            reset();
        }
    });

    

    return (
        <div>
            <p className="text-white font-bold font-inter text-2xl leading-6 pb-6">Custom analytics dashboard</p>
            <ChartsGrid latestToolCall={latestToolCall} />
        </div>

    )

}
