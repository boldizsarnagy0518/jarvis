import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import * as vscode from 'vscode';
import { load as loadYaml, YAMLException } from 'js-yaml';
import { discoverAgentModes } from '../../engine/sessions/agentDiscovery';
import { collectObservation, compareRuntimeValue, copilotSessionId, normalizedDirectory, parseTaskUsagePeriod, readSessionTelemetryLine, readUsageInteractions, resolveSdkSessions, selectTaskUsage, summarizeSessionTaskUsage, tokenFields, usageActors, type ObservedRuntime, type RuntimeObservation, type TaskUsage, type UsageActor, type UsagePeriod, type UsageRow } from '../../engine/sessions/taskUsage';
import type { WorkflowTask } from '../../engine/sessions/workflowTasks';

const labels = ['Input', 'Output', 'Cache read', 'Cache write', 'Reasoning'];
const dayMs = 24 * 60 * 60 * 1000;
const statusLabels = { active: 'Active', paused: 'Paused', completed: 'Completed' };
const telemetryEvent = /"type"\s*:\s*"(?:session\.usage_record|assistant\.message)"/;
type DateChoice = vscode.QuickPickItem & { days?: number; custom?: true };
const dateChoices: DateChoice[] = [
    { label: 'All time' },
    { label: 'Last day', description: '24 hours', days: 1 },
    { label: 'Last week', description: '7 days', days: 7 },
    { label: 'Last month', description: '30 days', days: 30 },
    { label: 'Custom date...', custom: true },
];
type Node = { label: string; report: TaskUsage; efforts: ReadonlyMap<UsageActor, string> }
    | { label: string; usage: UsageRow; share?: number; taskCount?: number; configured?: RuntimeObservation };

function copilotUsage(row: UsageRow): string {
    if (row.nanoAiu === undefined) { return 'Copilot n/a'; }
    const credits = (row.nanoAiu / 1e9).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `Copilot ${credits} AIU${row.billedCalls !== row.calls ? ' (partial)' : ''}`;
}

async function loadLegacyInteractions(root: string, workspace: string, excluded: ReadonlySet<string>) {
    const dirs = await fs.promises.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return []; }
        throw error;
    });
    const interactions = [];
    const currentDirectory = normalizedDirectory(workspace);
    for (const dir of dirs) {
        if (!dir.isDirectory() || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(dir.name)) { continue; }
        if (excluded.has(dir.name.toLowerCase())) { continue; }
        const events = path.join(root, dir.name, 'events.jsonl');
        try {
            const metadata = await fs.promises.readFile(path.join(root, dir.name, 'workspace.yaml'), 'utf8');
            const session = loadYaml(metadata) as { cwd?: unknown } | undefined;
            if (typeof session?.cwd !== 'string' || normalizedDirectory(session.cwd) !== currentDirectory) { continue; }
            const relevant: string[] = [];
            const lines = createInterface({ input: fs.createReadStream(events), crlfDelay: Infinity });
            for await (const line of lines) {
                if (telemetryEvent.test(line) || /"type"\s*:\s*"(?:user\.message|assistant\.turn_(?:start|end))"/.test(line)
                    || (/jarvis_taskUsage|jarvis_receiveMessage/.test(line) && /"type"\s*:\s*"external_tool\.requested"/.test(line))
                    || ((line.includes('JARVIS_TASK_USAGE ') || /\b(?:TEST|CODE|REVIEW|FIX)\s*\|/.test(line)) && /"type"\s*:\s*"tool\.execution_complete"/.test(line))) { relevant.push(line); }
            }
            interactions.push(...readUsageInteractions(relevant, workspace));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof YAMLException)) { throw error; }
        }
    }
    return interactions;
}

async function loadSessionTelemetry(root: string, sessions: ReadonlySet<string>) {
    const records = new Map<string, NonNullable<ReturnType<typeof readSessionTelemetryLine>['record']>[]>();
    const observations = new Map<string, ObservedRuntime>();
    for (const session of sessions) {
        const events = path.join(root, session, 'events.jsonl');
        const usage: NonNullable<ReturnType<typeof readSessionTelemetryLine>['record']>[] = [];
        let observed: ObservedRuntime | undefined;
        try {
            const lines = createInterface({ input: fs.createReadStream(events), crlfDelay: Infinity });
            for await (const line of lines) {
                if (!telemetryEvent.test(line)) { continue; }
                const { record, observation } = readSessionTelemetryLine(line);
                if (record) { usage.push(record); }
                if (observation) { observed = collectObservation(observed, observation); }
            }
            records.set(session, usage);
            if (observed) { observations.set(session, observed); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }
    return { records, observations };
}

async function loadConfiguredEfforts(workspace: string): Promise<Map<UsageActor, string>> {
    const efforts = new Map<UsageActor, string>();
    if (vscode.workspace.workspaceFolders?.length !== 1) { return efforts; }
    const agents = await discoverAgentModes();
    for (const actor of usageActors) {
        const matches = agents.filter(agent => agent.name === actor);
        if (matches.length !== 1) { continue; }
        try {
            const content = await fs.promises.readFile(path.join(workspace, matches[0].filePath), 'utf8');
            const frontmatter = /^---\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(content);
            if (frontmatter?.index !== 0) { continue; }
            const effort = (loadYaml(frontmatter[1]) as { 'reasoning-effort'?: unknown } | undefined)?.['reasoning-effort'];
            if (typeof effort === 'string' && effort.trim()) { efforts.set(actor, effort.trim()); }
        } catch { continue; }
    }
    return efforts;
}

export function registerTaskUsageView(context: vscode.ExtensionContext, workspace: string, getTasks: () => readonly WorkflowTask[], userDataDir?: string): () => void {
    const changes = new vscode.EventEmitter<void>();
    const root = path.join(homedir(), '.copilot', 'session-state');
    let reports: ReturnType<typeof loadReports> | undefined;
    let legacy: ReturnType<typeof loadLegacyInteractions> | undefined;
    let dateChoice = dateChoices[0];
    let customDate = '';
    let customPeriod: UsagePeriod | undefined;
    const loadReports = async () => {
        const tasks = getTasks();
        const resources = new Set(tasks.flatMap(task => [...Object.values(task.sessions), ...task.retired]));
        const sdkSessions = userDataDir ? resolveSdkSessions(path.join(userDataDir, 'User', 'globalStorage', 'agent-host.db'), resources) : new Map<string, string>();
        const sessions = new Set<string>();
        const excluded = new Set<string>();
        for (const task of tasks) {
            for (const resource of [...Object.values(task.sessions), ...Object.values(task.retiredActors ?? {}).flat()]) {
                const session = sdkSessions.get(resource) ?? copilotSessionId(resource);
                if (session) { sessions.add(session); excluded.add(session); }
            }
            for (const resource of task.retired) {
                const session = sdkSessions.get(resource) ?? copilotSessionId(resource);
                if (session) { excluded.add(session); }
            }
        }
        const [{ records, observations }, interactions, efforts] = await Promise.all([
            loadSessionTelemetry(root, sessions), legacy ??= loadLegacyInteractions(root, workspace, excluded), loadConfiguredEfforts(workspace),
        ]);
        return { results: summarizeSessionTaskUsage(tasks, records, interactions, sdkSessions, observations), efforts };
    };
    const view = vscode.window.createTreeView<Node>('jarvisTaskUsage', {
        treeDataProvider: {
            onDidChangeTreeData: changes.event,
            getTreeItem(node) {
                if ('report' in node) {
                    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
                    item.id = `${node.report.status ? 'task' : 'legacy'}:${node.report.taskId}`;
                    const { total, rows } = node.report;
                    const input = total.tokens.inputTokens?.toLocaleString() ?? 'n/a';
                    const output = total.tokens.outputTokens?.toLocaleString() ?? 'n/a';
                    const measured = usageActors.filter(actor => rows[actor].calls > 0).length;
                    const status = node.report.status ? `${statusLabels[node.report.status]} · ` : '';
                    item.description = `${status}${total.calls ? `Total: ${copilotUsage(total)} · ${input} in / ${output} out` : 'Not measured'}`;
                    item.tooltip = `${item.description}\nActors with measurements: ${measured}/${usageActors.length}`;
                    return item;
                }
                const item = new vscode.TreeItem(node.label);
                if (node.taskCount !== undefined) {
                    item.id = 'workspace:total';
                    item.iconPath = new vscode.ThemeIcon('graph');
                }
                const counts = tokenFields.map((field, index) => `${labels[index]}: ${node.usage.tokens[field]?.toLocaleString() ?? 'n/a'}`);
                const blocks = node.share === undefined ? 0 : Math.round(node.share * 8);
                const bar = node.share === undefined ? '' : `${'■'.repeat(blocks)}${'□'.repeat(8 - blocks)} ${Math.round(node.share * 100)}% · `;
                item.description = node.usage.calls ? `${bar}${copilotUsage(node.usage)} · ${counts[0]} · ${counts[1]}` : 'Not measured';
                const runtimeDetails: string[] = [];
                if (node.configured) {
                    const model = compareRuntimeValue(node.usage.observed?.models, node.configured.model);
                    const effort = compareRuntimeValue(node.usage.observed?.efforts, node.configured.effort);
                    if (model.differs || effort.differs) { item.iconPath = new vscode.ThemeIcon('warning'); }
                    if (node.usage.calls || node.usage.observed) {
                        item.description += ` · Model: ${model.observed}${model.differs ? ` (cfg: ${model.current})` : ''}`
                            + ` · Effort: ${effort.observed}${effort.differs ? ` (cfg: ${effort.current})` : ''}`;
                    }
                    runtimeDetails.push(`Observed model: ${model.observed}`, `Current configured model request: ${model.current ?? 'not set'}`,
                        `Observed effort: ${effort.observed}`, `Current Actor effort preference: ${effort.current ?? 'not set or unavailable'}`);
                    if (model.differs || effort.differs) { runtimeDetails.push('An observed value differs from current configuration, not necessarily from the original request.'); }
                }
                item.tooltip = [copilotUsage(node.usage), ...counts, `Measured model calls: ${node.usage.calls}`,
                    ...runtimeDetails,
                    ...(node.taskCount === undefined ? [] : [`Tasks: ${node.taskCount.toLocaleString()}`]),
                    ...(node.share === undefined ? [] : [`Share of measured Copilot AIU: ${Math.round(node.share * 100)}%`])].join('\n');
                return item;
            },
            async getChildren(node) {
                if (node) {
                    if (!('report' in node)) { return []; }
                    const report = node.report;
                    const models = vscode.workspace.getConfiguration('jarvis').get<Record<string, string>>('agentSession.models');
                    return [{ label: 'Total', usage: report.total }, ...usageActors.map(actor => {
                        const usage = report.rows[actor];
                        const share = report.total.nanoAiu && usage.nanoAiu !== undefined ? usage.nanoAiu / report.total.nanoAiu : undefined;
                        return { label: actor, usage, share, configured: { model: models?.[actor], effort: node.efforts.get(actor) } };
                    })];
                }
                try {
                    const { results, efforts } = await (reports ??= loadReports());
                    const now = Date.now();
                    const period = dateChoice.custom ? customPeriod : dateChoice.days === undefined ? undefined
                        : { from: now - dateChoice.days * dayMs, until: now + 1 };
                    const { tasks, total } = selectTaskUsage(results, period);
                    view.description = dateChoice.custom ? customDate : dateChoice.label;
                    view.message = tasks.length ? undefined : 'No tasks in this period.';
                    return [{ label: 'Total', usage: total, taskCount: tasks.length }, ...tasks.map(report => ({ label: report.title ?? report.taskId, report, efforts }))];
                } catch {
                    view.message = 'Could not read the Copilot usage log.';
                    return [];
                }
            },
        },
    });
    const refresh = (): void => { legacy = undefined; reports = undefined; changes.fire(); };
    const timer = setInterval(() => {
        if (view.visible && getTasks().some(task => task.status === 'active')) { reports = undefined; changes.fire(); }
    }, 20_000);
    const chooseDate = async (): Promise<void> => {
        const choice = await vscode.window.showQuickPick(dateChoices.map(option => ({ ...option, picked: option === dateChoice, option })), {
            title: 'Token Usage Date', placeHolder: 'Filter by last task usage, or close date for legacy tasks',
        });
        if (!choice) { return; }
        if (choice.custom) {
            const value = await vscode.window.showInputBox({
                title: 'Custom Token Usage Date', value: customDate,
                prompt: 'Enter a local date or an inclusive date range',
                placeHolder: 'YYYY-MM-DD or YYYY-MM-DD to YYYY-MM-DD',
                validateInput: input => parseTaskUsagePeriod(input) ? undefined : 'Enter a valid date or date range in chronological order.',
            });
            if (value === undefined) { return; }
            const period = parseTaskUsagePeriod(value);
            if (!period) { return; }
            customDate = value.trim();
            customPeriod = period;
        }
        dateChoice = choice.option;
        changes.fire();
    };
    context.subscriptions.push(changes, view, { dispose: () => clearInterval(timer) }, view.onDidChangeVisibility(({ visible }) => { if (visible) { refresh(); } }),
        vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('jarvis.agentSession.models')) { changes.fire(); } }),
        vscode.commands.registerCommand('jarvis.filterTaskUsageDate', chooseDate),
        vscode.commands.registerCommand('jarvis.refreshTaskUsage', refresh));
    return refresh;
}