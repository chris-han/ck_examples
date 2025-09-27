"use client"
import GenericChart, { ChartProps, DataPoint } from "./GenericChart";
import { useMemo, useState } from "react";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";

type UnknownRecord = Record<string, unknown>;

type ToolCallSnapshot = {
    name?: string;
    args?: unknown;
    result?: unknown;
} | null;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const coerceValue = (value: unknown): string | number => {
    if (typeof value === "number") {
        return value;
    }

    if (typeof value === "string") {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : value;
    }

    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    return String(value ?? "");
};

const labelPreferenceOrder = [
    "name",
    "label",
    "title",
    "resource_name",
    "resource",
    "vm",
    "server",
    "category",
];

const unwrapActionArgs = (input: unknown): UnknownRecord => {
    if (!isRecord(input)) {
        return {};
    }

    if ("params" in input) {
        const nested = (input as { params?: unknown }).params;
        if (isRecord(nested)) {
            return unwrapActionArgs(nested);
        }
    }

    if ("arguments" in input) {
        const nested = (input as { arguments?: unknown }).arguments;
        if (isRecord(nested)) {
            return unwrapActionArgs(nested);
        }
    }

    return input;
};

const normaliseDataPoint = (raw: unknown, index: number): DataPoint | null => {
    if (typeof raw === "string" || typeof raw === "number") {
        return { name: String(raw), value: typeof raw === "number" ? raw : 1 };
    }

    if (!isRecord(raw)) {
        return null;
    }

    const entries: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(raw)) {
        entries[key] = coerceValue(value);
    }

    const keys = Object.keys(entries);
    const preferredKey = keys.find((key) =>
        labelPreferenceOrder.includes(key.toLowerCase())
    );
    const labelKey = preferredKey ?? keys.find((key) => typeof entries[key] === "string") ?? keys[0];
    const labelValue = labelKey ? entries[labelKey] : undefined;

    const numericEntries: Record<string, number> = {};
    Object.entries(entries).forEach(([key, value]) => {
        if (key === labelKey) {
            return;
        }

        if (typeof value === "number") {
            numericEntries[key] = value;
        }
    });

    if (Object.keys(numericEntries).length === 0) {
        numericEntries.value = 1;
    }

    const result: DataPoint = {
        name: labelValue !== undefined ? String(labelValue) : `Item ${index + 1}`,
        ...numericEntries,
    };

    if (labelKey && labelValue !== undefined) {
        result[labelKey] = String(labelValue);
    }

    return result;
};

const normaliseData = (input: unknown): DataPoint[] => {
    let source = input;

    if (typeof source === "string") {
        try {
            source = JSON.parse(source);
        } catch {
            // Treat as comma separated list if possible, otherwise single string entry
            const parts = source
                .split(/,|\n|\r/)
                .map((part) => part.trim())
                .filter(Boolean);

            if (parts.length > 1) {
                return parts.map((value, index) => normaliseDataPoint(value, index)).filter((value): value is DataPoint => value !== null);
            }

            return [
                {
                    name: source,
                    value: 1,
                },
            ];
        }
    }

    if (isRecord(source)) {
        if (Array.isArray(source.data)) {
            return normaliseData(source.data);
        }

        if (Array.isArray(source.rows)) {
            const columns = Array.isArray(source.columns)
                ? source.columns.map((column) => String(column))
                : undefined;

            return (source.rows as unknown[])
                .map((row, index) => {
                    if (Array.isArray(row)) {
                        const rowObject: Record<string, unknown> = {};
                        row.forEach((value, columnIndex) => {
                            const columnName = columns?.[columnIndex] ?? `value_${columnIndex + 1}`;
                            rowObject[columnName] = value;
                        });
                        return normaliseDataPoint(rowObject, index);
                    }

                    if (isRecord(row)) {
                        return normaliseDataPoint(row, index);
                    }

                    return normaliseDataPoint({ value: row }, index);
                })
                .filter((value): value is DataPoint => value !== null);
        }
    }

    if (!Array.isArray(source)) {
        if (isRecord(source)) {
            return Object.entries(source).map(([key, value], index) =>
                normaliseDataPoint({ name: key, value }, index)
            ).filter((value): value is DataPoint => value !== null);
        }

        const coerced = normaliseDataPoint(source, 0);
        return coerced ? [coerced] : [];
    }

    if (source.length > 0 && Array.isArray(source[0])) {
        return source
            .map((row, index) => {
                if (!Array.isArray(row)) {
                    return normaliseDataPoint(row, index);
                }

                const rowObject: Record<string, unknown> = {};
                (row as unknown[]).forEach((value, columnIndex) => {
                    rowObject[`value_${columnIndex + 1}`] = value;
                });
                return normaliseDataPoint(rowObject, index);
            })
            .filter((item): item is DataPoint => item !== null);
    }

    return source
        .map((item, index) => normaliseDataPoint(item, index))
        .filter((item): item is DataPoint => item !== null);
};

const extractDataCandidate = (args: UnknownRecord): unknown => {
    const preferredKeys = ["data", "dataset", "records", "values", "items", "points"] as const;

    for (const key of preferredKeys) {
        if (key in args) {
            const candidate = args[key];
            if (candidate !== undefined) {
                return candidate;
            }
        }
    }

    if ("result" in args && args.result !== undefined) {
        const candidate = args.result;
        if (isRecord(candidate)) {
            const nested = extractDataCandidate(candidate);
            if (nested !== undefined) {
                return nested;
            }
        }
        return candidate;
    }

    if ("rows" in args && Array.isArray(args.rows)) {
        return {
            columns: Array.isArray(args.columns) ? args.columns : undefined,
            rows: args.rows,
        };
    }

    if ("table" in args && isRecord(args.table)) {
        return extractDataCandidate(args.table);
    }

    return undefined;
};

const resolveDataFromSource = (source: unknown): DataPoint[] => {
    if (source === undefined || source === null) {
        return [];
    }

    if (isRecord(source)) {
        const extracted = extractDataCandidate(source);
        if (extracted !== undefined) {
            const normalised = normaliseData(extracted);
            if (normalised.length > 0) {
                return normalised;
            }
        }

        const keys = Object.keys(source).map((key) => key.toLowerCase());
        const metaKeys = new Set(["name", "args", "result", "status"]);
        if (keys.length > 0 && keys.every((key) => metaKeys.has(key))) {
            return [];
        }
    }

    return normaliseData(source);
};

function DynamicGrid({ charts }: { charts: ChartProps[] }) {
    return (
        charts.map((chart, index) => (
            <div className="flex flex-col gap-4" key={index}>
                <p className="text-white whitespace-nowrap overflow-hidden text-overflow-ellipsis text-(length:--typography-font-sizes-1,20px) leading-[150%] font-bold font-inter">{chart.title}</p>
                <GenericChart {...chart} />
            </div>))
    )
}

export default function ChartsGrid({ latestToolCall }: { latestToolCall: ToolCallSnapshot }) {
    const [charts, setCharts] = useState<ChartProps[]>([]);

    const fallbackDataSources = useMemo(() => {
        if (!latestToolCall) {
            return [] as unknown[];
        }

        const sources: unknown[] = [];

        if (latestToolCall.result !== undefined) {
            sources.push(latestToolCall.result);
        }

        if (latestToolCall.args !== undefined) {
            sources.push(latestToolCall.args);
        }

        sources.push(latestToolCall);

        return sources;
    }, [latestToolCall]);

    useCopilotReadable({
        description: "These are all the charts props",
        value: charts,
    });

    useCopilotAction({
        name: "generateChart",
        description: "Generate a chart based on the provided data. Make sure to provide the data in the correct format and specify what field should be used a x-axis.",
        parameters: [
            {
                name: "data",
                type: "object[]",
                description: "Data to be used for the chart. The data should be an array of objects, where each object represents a data point.",
            },
            {
                name: "chartType",
                type: "string",
                description: "Type of chart to be generated. Let's use bar, line, area, or pie.",
            },
            {
                name: "title",
                type: "string",
                description: "Title of the chart. Can't be more than 30 characters.",
            },
            { name: "xAxis", type: "string", description: "x-axis label" }
        ],

        handler: async (rawArgs: unknown) => {
            const args = unwrapActionArgs(rawArgs);
            const dataCandidate = extractDataCandidate(args);
            let parsedData = normaliseData(dataCandidate);

            if (parsedData.length === 0 && fallbackDataSources.length > 0) {
                for (const source of fallbackDataSources) {
                    const fallback = resolveDataFromSource(source);
                    if (fallback.length > 0) {
                        parsedData = fallback;
                        break;
                    }
                }
            }

            if (parsedData.length === 0) {
                console.warn("generateChart called without usable data", rawArgs);
                return;
            }

            const rawChartType = typeof args.chartType === "string" ? args.chartType : undefined;
            const rawTitle = typeof args.title === "string" ? args.title : undefined;
            const rawXAxis = typeof args.xAxis === "string" ? args.xAxis : undefined;

            const resolvedChartType = rawChartType && rawChartType.trim().length > 0
                ? rawChartType.trim()
                : "bar";

            const resolvedTitle = rawTitle && rawTitle.trim().length > 0
                ? rawTitle.trim().slice(0, 30)
                : "Custom chart";

            const newChart: ChartProps = {
                data: parsedData,
                chartType: resolvedChartType,
                title: resolvedTitle,
                xAxis: rawXAxis && rawXAxis.trim().length > 0 ? rawXAxis.trim() : undefined,
            };

            setCharts((charts) => [...charts, newChart]);
        },
        render: "Adding chart...",
    });

    return (
        <div className="grid grid-cols-2 lg:grid-cols-2 gap-8">
            {charts.length > 0 ? <DynamicGrid charts={charts} /> :
                <div className="mt-10 flex items-center justify-center w-full h-[400px] border border-[#414141] bg-[#282828] font-inter font-medium leading-[150%] text-base text-[#B3B6BD] rounded-lg">Your chart will appear here</div>}
        </div>
    )
}
