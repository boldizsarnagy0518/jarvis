import { resolve } from 'path';
import { existsSync } from 'fs';
import type { AhpToolSpec } from '../ahp/messagePath';
import type { WorkflowTask } from './workflowTasks';

export const usageActors = ['lead', 'tester', 'coder', 'verify'] as const;
export type UsageActor = typeof usageActors[number];
export const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
type Tokens = Partial<Record<typeof tokenFields[number], number>>;
type Phase = 'start' | 'work' | 'close';

export interface UsageMarker { workspace: string; taskId: string; actor: UsageActor; phase: Phase }
export interface RuntimeObservation { model?: string; effort?: string }
export interface ObservedRuntime { models: Set<string>; efforts: Set<string> }
export interface UsageRow { calls: number; tokens: Tokens; nanoAiu?: number; billedCalls?: number; observed?: ObservedRuntime }
interface Usage { tokens: Tokens; nanoAiu?: number }
export interface TaskUsage {
    taskId: string;
    closedAt?: string;
    lastActivityAt?: string;
    title?: string;
    status?: WorkflowTask['status'];
    rows: Record<UsageActor, UsageRow>;
    total: UsageRow;
}
export interface UsagePeriod { from: number; until: number }
interface SdkEvent { id?: string; type?: string; timestamp?: string; data?: Record<string, unknown> }
interface Interaction { marker: UsageMarker; phases: Set<Phase>; usages: Map<string, Usage>; observed?: ObservedRuntime; timestamp: string; ended: boolean }
interface UsageRecord { id: string; usage: Usage; timestamp?: string }

export function copilotSessionId(session: string): string | undefined {
    return /^copilotcli:\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.exec(session)?.[1].toLowerCase();
}

interface HostDatabase {
    prepare(sql: string): { get(resource: string): { provider_data?: string } | undefined };
    close(): void;
}

export function resolveSdkSessions(databasePath: string, resources: ReadonlySet<string>): Map<string, string> {
    const sessions = new Map<string, string>();
    if (!resources.size || !existsSync(databasePath)) { return sessions; }
    const sqlite = process.getBuiltinModule?.('node:sqlite') as {
        DatabaseSync: new (file: string, options: { readOnly: true }) => HostDatabase;
    } | undefined;
    if (!sqlite) { return sessions; }
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
        const query = database.prepare(`SELECT chat.provider_data FROM session_chat_catalogs AS catalog
            JOIN chats_v2 AS chat ON chat.chat_uri = catalog.default_chat_uri WHERE catalog.session_uri = ?`);
        for (const resource of resources) {
            const data = query.get(resource)?.provider_data;
            if (!data) { continue; }
            let sdkId: unknown;
            try { sdkId = JSON.parse(data)?.sdkSessionId; } catch { continue; }
            const id = typeof sdkId === 'string' ? copilotSessionId(`copilotcli:/${sdkId}`) : undefined;
            if (id) { sessions.set(resource, id); }
        }
    } catch (error) {
        if (!(error instanceof Error) || !/no such (?:table|column)/.test(error.message)) { throw error; }
    } finally { database.close(); }
    return sessions;
}

function usageRecord(event: SdkEvent): UsageRecord | undefined {
    if (event.type !== 'session.usage_record' || typeof event.id !== 'string' || !event.data?.usage) { return; }
    const logged = event.data.usage as Record<string, unknown>;
    const tokens: Tokens = {};
    for (const field of tokenFields) {
        const count = logged[field];
        if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) { tokens[field] = count; }
    }
    const amount = (logged.copilotUsage as { totalNanoAiu?: unknown } | undefined)?.totalNanoAiu;
    const nanoAiu = typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
    if (!Object.keys(tokens).length && nanoAiu === undefined) { return; }
    const accounting = logged.accounting as { usageId?: unknown; sourceSessionId?: unknown } | undefined;
    const id = typeof accounting?.usageId === 'string' && accounting.usageId && typeof accounting.sourceSessionId === 'string'
        ? `accounting:${JSON.stringify([accounting.sourceSessionId, accounting.usageId])}` : event.id;
    const timestamp = Date.parse(event.timestamp ?? '');
    return { id, usage: { tokens, nanoAiu }, timestamp: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined };
}

function runtimeObservation(event: SdkEvent): RuntimeObservation | undefined {
    const model = event.type === 'assistant.message' ? event.data?.model : undefined;
    const effort = event.type === 'session.usage_record'
        ? (event.data?.usage as { reasoningEffort?: unknown } | undefined)?.reasoningEffort : undefined;
    if (typeof model === 'string' && model.trim()) { return { model: model.trim() }; }
    if (typeof effort === 'string' && effort.trim()) { return { effort: effort.trim() }; }
}

export function readSessionTelemetryLine(line: string): { record?: UsageRecord; observation?: RuntimeObservation } {
    try {
        const event = JSON.parse(line) as SdkEvent;
        return { record: usageRecord(event), observation: runtimeObservation(event) };
    } catch { return {}; }
}

export function readSessionUsageLine(line: string): UsageRecord | undefined {
    return readSessionTelemetryLine(line).record;
}

export function collectObservation(observed: ObservedRuntime | undefined, { model, effort }: RuntimeObservation): ObservedRuntime {
    const result = observed ?? { models: new Set<string>(), efforts: new Set<string>() };
    if (model) { result.models.add(model); }
    if (effort) { result.efforts.add(effort); }
    return result;
}

function addObservations(row: UsageRow, observed?: ObservedRuntime): void {
    if (!observed) { return; }
    row.observed ??= { models: new Set<string>(), efforts: new Set<string>() };
    for (const model of observed.models) { row.observed.models.add(model); }
    for (const effort of observed.efforts) { row.observed.efforts.add(effort); }
}

export function compareRuntimeValue(observed?: ReadonlySet<string>, configured?: string) {
    const values = [...(observed ?? [])].sort();
    const current = typeof configured === 'string' ? configured.trim() || undefined : undefined;
    return { observed: values.join(', ') || 'unknown', current, differs: !!current && values.some(value => value !== current) };
}

export function validTaskId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(value);
}

export function normalizedDirectory(directory: string): string {
    const resolved = resolve(directory);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseMarker(value: unknown, workspace: string): UsageMarker | undefined {
    if (typeof value !== 'string') { return; }
    const prefix = 'JARVIS_TASK_USAGE ';
    if (!value.startsWith(prefix)) { return; }
    try {
        const marker = JSON.parse(value.slice(prefix.length)) as UsageMarker;
        if (typeof marker?.workspace === 'string' && normalizedDirectory(marker.workspace) === normalizedDirectory(workspace)
            && validTaskId(marker.taskId) && usageActors.includes(marker.actor)
            && (marker.phase === 'work' || (marker.actor === 'lead' && ['start', 'close'].includes(marker.phase)))) { return marker; }
    } catch { return; }
}

function parseHandoff(value: unknown, workspace: string): UsageMarker | undefined {
    if (typeof value !== 'string') { return; }
    try {
        const message = (JSON.parse(value) as { message?: { sender?: unknown; text?: unknown } })?.message;
        if (typeof message?.text !== 'string') { return; }
        const [command, taskId, round, ...rest] = message.text.split(/\r?\n/, 1)[0].split('|').map(part => part.trim());
        if (!validTaskId(taskId) || rest.length) { return; }
        let actor: UsageActor | undefined;
        if (message.sender === 'lead' && round === undefined) {
            if (command === 'TEST') { actor = 'tester'; }
            if (command === 'CODE') { actor = 'coder'; }
        }
        if (command === 'FIX' && message.sender === 'verify' && /^[12]$/.test(round ?? '')) { actor = 'coder'; }
        if (command === 'REVIEW' && ((message.sender === 'lead' && round === '0')
            || (message.sender === 'coder' && /^[12]$/.test(round ?? '')))) { actor = 'verify'; }
        if (actor) { return { workspace, taskId, actor, phase: 'work' }; }
    } catch { return; }
}

export function readUsageInteractions(lines: Iterable<string>, workspace: string): Interaction[] {
    const interactions: Interaction[] = [];
    let active = false;
    let ended = false;
    let timestamp = '';
    let unclear = false;
    let marker: UsageMarker | undefined;
    let phases = new Set<Phase>();
    let usages = new Map<string, Usage>();
    let observed: ObservedRuntime | undefined;
    let toolIds = new Map<string, string>();
    const flush = (): void => {
        if (marker && !unclear && timestamp) { interactions.push({ marker, phases, usages, observed, timestamp, ended }); }
    };

    for (const line of lines) {
        let event: SdkEvent;
        try { event = JSON.parse(line) as SdkEvent; } catch { continue; }
        const data = event?.data;
        if (!data) { continue; }
        const observation = active ? runtimeObservation(event) : undefined;
        if (observation) { observed = collectObservation(observed, observation); }
        if (event.type === 'user.message') {
            flush();
            active = true;
            ended = false;
            unclear = false;
            timestamp = event.timestamp ?? '';
            marker = undefined;
            phases = new Set();
            usages = new Map();
            observed = undefined;
            toolIds = new Map();
        } else if (active && event.type === 'external_tool.requested' && (data.toolName === 'jarvis_taskUsage' || data.toolName === 'jarvis_receiveMessage') && typeof data.toolCallId === 'string') {
            toolIds.set(data.toolCallId, data.toolName);
        } else if (active && event.type === 'tool.execution_complete' && data.success === true && typeof data.toolCallId === 'string' && toolIds.has(data.toolCallId)) {
            const content = (data.result as { content?: unknown } | undefined)?.content;
            const received = toolIds.get(data.toolCallId) === 'jarvis_taskUsage' ? parseMarker(content, workspace) : parseHandoff(content, workspace);
            if (received) {
                if (marker && (marker.actor !== received.actor || marker.taskId !== received.taskId)) { unclear = true; }
                marker ??= received;
                phases.add(received.phase);
            }
        } else if (active && event.type === 'session.usage_record') {
            const record = usageRecord(event);
            if (record) { usages.set(record.id, record.usage); }
        } else if (active && event.type === 'assistant.turn_start') {
            ended = false;
        } else if (active && event.type === 'assistant.turn_end') {
            ended = true;
        }
    }
    flush();
    return interactions;
}

function add(target: UsageRow, { tokens, nanoAiu }: Usage): void {
    target.calls++;
    if (nanoAiu !== undefined) {
        target.nanoAiu = (target.nanoAiu ?? 0) + nanoAiu;
        target.billedCalls = (target.billedCalls ?? 0) + 1;
    }
    for (const field of tokenFields) {
        const value = tokens[field];
        if (value !== undefined) { target.tokens[field] = (target.tokens[field] ?? 0) + value; }
    }
}

function emptyReport(taskId: string): TaskUsage {
    return {
        taskId,
        total: { calls: 0, tokens: {} },
        rows: Object.fromEntries(usageActors.map(actor => [actor, { calls: 0, tokens: {} }])) as TaskUsage['rows'],
    };
}

export function summarizeTaskUsage(interactions: readonly Interaction[], seen = new Set<string>()): TaskUsage[] {
    const groups = new Map<string, Interaction[]>();
    for (const interaction of interactions) {
        const group = groups.get(interaction.marker.taskId) ?? [];
        group.push(interaction);
        groups.set(interaction.marker.taskId, group);
    }
    const reports: TaskUsage[] = [];
    for (const [taskId, group] of groups) {
        const starts = group.filter(item => item.phases.has('start'));
        const closes = group.filter(item => item.phases.has('close') && item.ended);
        if (starts.length !== 1 || closes.length !== 1 || starts[0].timestamp > closes[0].timestamp) { continue; }
        const closedAt = closes[0].timestamp;
        const { rows, total } = emptyReport(taskId);
        for (const item of group) {
            if (item.timestamp < starts[0].timestamp || item.timestamp > closedAt || !item.ended) { continue; }
            addObservations(rows[item.marker.actor], item.observed);
            for (const [id, tokens] of item.usages) {
                if (seen.has(id)) { continue; }
                seen.add(id);
                add(rows[item.marker.actor], tokens);
                add(total, tokens);
            }
        }
        reports.push({ taskId, closedAt, rows, total });
    }
    return reports.sort((left, right) => reportDate(right).localeCompare(reportDate(left)));
}

export function summarizeSessionTaskUsage(
    tasks: readonly WorkflowTask[], records: ReadonlyMap<string, readonly UsageRecord[]>, legacy: readonly Interaction[],
    sdkSessions: ReadonlyMap<string, string> = new Map(),
    observations: ReadonlyMap<string, ObservedRuntime> = new Map(),
): TaskUsage[] {
    const seen = new Set<string>();
    const reports = tasks.map(task => {
        const report = { ...emptyReport(task.id), title: task.title, status: task.status };
        for (const actor of usageActors) {
            for (const resource of [...(task.retiredActors?.[actor] ?? []), task.sessions[actor] ?? '']) {
                const session = sdkSessions.get(resource) ?? copilotSessionId(resource);
                if (!session) { continue; }
                addObservations(report.rows[actor], observations.get(session));
                for (const record of records.get(session) ?? []) {
                    if (record.timestamp && record.timestamp > (report.lastActivityAt ?? '')) { report.lastActivityAt = record.timestamp; }
                    if (seen.has(record.id)) { continue; }
                    seen.add(record.id);
                    add(report.rows[actor], record.usage);
                    add(report.total, record.usage);
                }
            }
        }
        return report;
    });
    return [...reports, ...summarizeTaskUsage(legacy, seen)].sort((left, right) => reportDate(right).localeCompare(reportDate(left)));
}

function reportDate(report: TaskUsage): string { return report.closedAt ?? report.lastActivityAt ?? ''; }

export function parseTaskUsagePeriod(value: string): UsagePeriod | undefined {
    const match = /^(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?$/.exec(value.trim());
    if (!match) { return; }
    const localDate = (input: string): Date | undefined => {
        const [year, month, day] = input.split('-').map(Number);
        const date = new Date(0);
        date.setFullYear(year, month - 1, day);
        date.setHours(0, 0, 0, 0);
        if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) { return date; }
    };
    const first = localDate(match[1]);
    const last = localDate(match[2] ?? match[1]);
    if (!first || !last || first > last) { return; }
    last.setDate(last.getDate() + 1);
    last.setHours(0, 0, 0, 0);
    return { from: first.getTime(), until: last.getTime() };
}

export function selectTaskUsage(reports: readonly TaskUsage[], period?: UsagePeriod): { tasks: TaskUsage[]; total: UsageRow } {
    const tasks: TaskUsage[] = [];
    const total: UsageRow = { calls: 0, tokens: {} };
    for (const report of reports) {
        const date = Date.parse(reportDate(report));
        if (period && !(date >= period.from && date < period.until)) { continue; }
        tasks.push(report);
        total.calls += report.total.calls;
        if (report.total.nanoAiu !== undefined) {
            total.nanoAiu = (total.nanoAiu ?? 0) + report.total.nanoAiu;
            total.billedCalls = (total.billedCalls ?? 0) + (report.total.billedCalls ?? 0);
        }
        for (const field of tokenFields) {
            const value = report.total.tokens[field];
            if (value !== undefined) { total.tokens[field] = (total.tokens[field] ?? 0) + value; }
        }
    }
    return { tasks, total };
}

export function createTaskUsageTool(workspace: string): AhpToolSpec {
    return {
        name: 'jarvis_taskUsage',
        title: 'Mark Jarvis Task Usage',
        description: 'Marks the current Copilot interaction for one task. Lead uses start, work or close; other workflow Actors use work.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['taskId', 'phase'],
            properties: { taskId: { type: 'string' }, phase: { enum: ['start', 'work', 'close'] } },
        },
        handler: async (ctx, { taskId, phase }) => {
            const actor = usageActors.find(name => name === ctx.title);
            if (!actor || !validTaskId(taskId) || (phase !== 'work' && !(actor === 'lead' && (phase === 'start' || phase === 'close')))) {
                return { text: 'Invalid task ID, phase, or workflow Actor.', isError: true };
            }
            const marker: UsageMarker = { workspace, taskId, actor, phase };
            return { text: `JARVIS_TASK_USAGE ${JSON.stringify(marker)}` };
        },
    };
}