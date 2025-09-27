"use client"
import GenericChart, { ChartProps, DataPoint } from "./GenericChart";
import { useState } from "react";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";

type UnknownRecord = Record<string, unknown>;

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

    if (!("name" in entries)) {
        const [firstKey] = Object.keys(entries);
        entries.name = firstKey ? String(entries[firstKey]) : `Item ${index + 1}`;
    } else {
        entries.name = String(entries.name);
    }

    return entries as DataPoint;
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

    if (!Array.isArray(source)) {
        if (isRecord(source)) {
            return Object.entries(source).map(([key, value], index) =>
                normaliseDataPoint({ name: key, value }, index)
            ).filter((value): value is DataPoint => value !== null);
        }

        const coerced = normaliseDataPoint(source, 0);
        return coerced ? [coerced] : [];
    }

    return source
        .map((item, index) => normaliseDataPoint(item, index))
        .filter((item): item is DataPoint => item !== null);
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

export default function ChartsGrid() {
    const [charts, setCharts] = useState<ChartProps[]>([]);

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

        handler: async ({ data, chartType, title, xAxis }) => {
            const parsedData = normaliseData(data);

            if (parsedData.length === 0) {
                console.warn("generateChart called without usable data", data);
                return;
            }

            const resolvedChartType = typeof chartType === "string" && chartType.trim().length > 0
                ? chartType
                : "bar";

            const resolvedTitle = typeof title === "string" && title.trim().length > 0
                ? title.trim().slice(0, 30)
                : "Custom chart";

            const newChart: ChartProps = {
                data: parsedData,
                chartType: resolvedChartType,
                title: resolvedTitle,
                xAxis
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
