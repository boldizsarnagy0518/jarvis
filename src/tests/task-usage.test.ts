import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectObservation, compareRuntimeValue, copilotSessionId, createTaskUsageTool, parseTaskUsagePeriod, readSessionTelemetryLine, readSessionUsageLine, readUsageInteractions, resolveSdkSessions, selectTaskUsage, summarizeSessionTaskUsage, summarizeTaskUsage, type ObservedRuntime, type TaskUsage } from '../../packages/core/src/engine/sessions/taskUsage';
import type { WorkflowTask } from '../../packages/core/src/engine/sessions/workflowTasks';

const workspace = '/repo';
const line = (type: string, data: object, id?: string, timestamp?: string) => JSON.stringify({ type, data, id, timestamp });
const usage = (id: string, inputTokens: number) => line('session.usage_record', { usage: { inputTokens, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1 } }, id);
const user = (timestamp: string) => line('user.message', {}, undefined, timestamp);
const marker = (taskId: string, actor: string, phase: string, root = workspace) => [
    line('external_tool.requested', { toolName: 'jarvis_taskUsage', toolCallId: 'call' }),
    line('tool.execution_complete', { success: true, toolCallId: 'call', result: { content: `JARVIS_TASK_USAGE ${JSON.stringify({ workspace: root, taskId, actor, phase })}` } }),
];
const end = line('assistant.turn_end', {});

describe('task usage', () => {
    it('compares mixed observations against current settings but does not classify missing evidence as a mismatch', () => {
        expect(compareRuntimeValue(new Set(['medium', 'high']), ' medium ')).toEqual({ observed: 'high, medium', current: 'medium', differs: true });
        expect(compareRuntimeValue(undefined, 'high')).toEqual({ observed: 'unknown', current: 'high', differs: false });
        expect(compareRuntimeValue(new Set(['model']))).toEqual({ observed: 'model', current: undefined, differs: false });
    });

    it('keeps distinct observations on the mapped Actor without counting them as calls', () => {
        const resource = 'copilotcli:/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const sdkId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const task: WorkflowTask = { id: 'managed', title: 'Test', status: 'active', sessions: { tester: resource }, retired: [], contract: null };
        let observed: ObservedRuntime | undefined;
        for (const event of [line('assistant.message', { model: 'claude-haiku-5.5' }), line('assistant.message', { model: 'claude-sonnet-5.5' }),
            line('assistant.message', { model: 'claude-haiku-5.5' }), line('session.usage_record', { usage: { reasoningEffort: 'medium' } }, 'effort-only'),
            line('session.usage_record', { usage: { reasoningEffort: 4 } }, 'bad-effort'), 'null', 'broken']) {
            const { observation, record } = readSessionTelemetryLine(event);
            expect(record).toBeUndefined();
            if (observation) { observed = collectObservation(observed, observation); }
        }
        const [report] = summarizeSessionTaskUsage([task], new Map(), [], new Map([[resource, sdkId]]), new Map([[sdkId, observed!]]));
        expect(report.rows.tester).toEqual({ calls: 0, tokens: {}, observed: {
            models: new Set(['claude-haiku-5.5', 'claude-sonnet-5.5']), efforts: new Set(['medium']),
        } });
        expect(report.rows.coder.observed).toBeUndefined();
        expect(report.total).toEqual({ calls: 0, tokens: {} });
    });

    it('includes observations only for attributed, completed legacy interactions', () => {
        const assistant = (model: string) => line('assistant.message', { model });
        const lines = [user('01'), ...marker('audit', 'lead', 'start'), end,
            user('02'), assistant('coder-model'), ...marker('audit', 'coder', 'work'),
            line('session.usage_record', { usage: { reasoningEffort: 'high', inputTokens: 10 } }, 'accounted'), end,
            user('03'), assistant('unmarked'), end,
            user('04'), assistant('unfinished'), ...marker('audit', 'coder', 'work'),
            user('05'), ...marker('audit', 'lead', 'close'), end];
        const [report] = summarizeTaskUsage(readUsageInteractions(lines, workspace));
        expect(report.rows.coder.observed).toEqual({ models: new Set(['coder-model']), efforts: new Set(['high']) });
        expect(report.total.calls).toBe(1);
    });

    it.skipIf(!process.getBuiltinModule?.('node:sqlite'))('resolves the deferred SDK ID from the exact default chat', () => {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
        const folder = mkdtempSync(join(tmpdir(), 'jarvis-usage-'));
        const file = join(folder, 'agent-host.db');
        const resource = 'copilotcli:/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const sdkId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        try {
            const db = new DatabaseSync(file);
            db.exec(`CREATE TABLE session_chat_catalogs (session_uri TEXT, default_chat_uri TEXT);
                CREATE TABLE chats_v2 (chat_uri TEXT, provider_data TEXT);`);
            db.prepare('INSERT INTO session_chat_catalogs VALUES (?, ?)').run(resource, 'ahp-chat:/default');
            db.prepare('INSERT INTO chats_v2 VALUES (?, ?)').run('ahp-chat:/default', JSON.stringify({ sdkSessionId: sdkId }));
            db.close();
            const mapping = resolveSdkSessions(file, new Set([resource, 'copilotcli:/unrelated']));
            const task: WorkflowTask = { id: 'test', title: 'Test', status: 'completed', sessions: { lead: resource }, retired: [], contract: null };
            const measured = readSessionUsageLine(usage('actual-sdk-event', 12))!;
            expect([...mapping]).toEqual([[resource, sdkId]]);
            expect(summarizeSessionTaskUsage([task], new Map([[sdkId, [measured]]]), [], mapping)[0].total.calls).toBe(1);
        } finally { rmSync(folder, { recursive: true, force: true }); }
    });

    it('reports an active task with unmarked and unfinished usage and keeps the total on resume', () => {
        const lead = '11111111-1111-1111-1111-111111111111';
        const previousCoder = '22222222-2222-2222-2222-222222222222';
        const currentCoder = '33333333-3333-3333-3333-333333333333';
        const task: WorkflowTask = { id: 'managed', title: 'test', status: 'active', sessions: { lead: `copilotcli:/${lead}` }, retired: [], contract: null };
        const recorded = (id: string, inputTokens: number, day: string) => readSessionUsageLine(line('session.usage_record', {
            usage: { inputTokens, copilotUsage: { totalNanoAiu: 1_000_000_000 } },
        }, id, `${day}T12:00:00Z`))!;
        const records = new Map([[lead, [recorded('lead', 100, '2026-11-18')]]]);
        const [active] = summarizeSessionTaskUsage([task], records, []);
        expect(active).toMatchObject({ title: 'test', status: 'active', total: { calls: 1, nanoAiu: 1_000_000_000 } });
        const [paused] = summarizeSessionTaskUsage([{ ...task, status: 'paused' }], records, []);
        expect(paused.total).toEqual(active.total);

        records.set(previousCoder, [recorded('old-coder', 20, '2026-11-18')]);
        records.set(currentCoder, [recorded('new-coder', 30, '2026-11-19')]);
        const resumed: WorkflowTask = { ...task, sessions: { ...task.sessions, coder: `copilotcli:/${currentCoder}` },
            retired: [`copilotcli:/${previousCoder}`], retiredActors: { coder: [`copilotcli:/${previousCoder}`] } };
        const reports = summarizeSessionTaskUsage([resumed], records, []);
        expect(reports[0].rows.coder).toMatchObject({ calls: 2, tokens: { inputTokens: 50 } });
        expect(reports[0].total).toMatchObject({ calls: 3, nanoAiu: 3_000_000_000 });
        expect(selectTaskUsage(reports, parseTaskUsagePeriod('2026-11-19')).tasks).toEqual(reports);
    });

    it('counts shared SDK accounting records once and keeps unrelated legacy work', () => {
        const session = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const task: WorkflowTask = { id: 'managed', title: 'Test', status: 'completed', sessions: { lead: `copilotcli:/${session.toUpperCase()}` }, retired: [], contract: null };
        const shared = (id: string) => line('session.usage_record', { usage: { inputTokens: 9,
            copilotUsage: { totalNanoAiu: 10 }, accounting: { sourceSessionId: session, usageId: 'shared' } } }, id);
        const legacy = readUsageInteractions([user('01'), ...marker('legacy', 'lead', 'start'), shared('legacy-copy'), usage('legacy-only', 25),
            ...marker('legacy', 'lead', 'close'), end], workspace);
        const reports = summarizeSessionTaskUsage([task], new Map([[session, [readSessionUsageLine(shared('managed-copy'))!, readSessionUsageLine(shared('repeat'))!]]]), legacy);
        expect(reports.find(report => report.taskId === 'legacy')?.total).toMatchObject({ calls: 1, tokens: { inputTokens: 25 } });
        expect(selectTaskUsage(reports).total).toMatchObject({ calls: 2, tokens: { inputTokens: 34 }, nanoAiu: 10, billedCalls: 1 });
        expect(copilotSessionId(`other:/${session}`)).toBeUndefined();
        expect(readSessionUsageLine('{"type":"session.usage_record",')).toBeUndefined();
    });

    it('sums all task totals or only tasks closed within the selected period', () => {
        const reports = [
            { taskId: 'first', closedAt: new Date(2026, 10, 18).toISOString(), total: { calls: 1, tokens: { inputTokens: 10 }, nanoAiu: 0, billedCalls: 1 } },
            { taskId: 'last', closedAt: new Date(2026, 10, 19, 23, 59).toISOString(), total: { calls: 1, tokens: { outputTokens: 4 } } },
            { taskId: 'outside', closedAt: new Date(2026, 10, 20).toISOString(), total: { calls: 1, tokens: { inputTokens: 20 }, nanoAiu: 10, billedCalls: 1 } },
        ].map(report => ({ ...report, rows: {} as TaskUsage['rows'] }));
        const { tasks, total } = selectTaskUsage(reports, parseTaskUsagePeriod('2026-11-18 to 2026-11-19'));
        expect(tasks.map(task => task.taskId)).toEqual(['first', 'last']);
        expect(total).toEqual({ calls: 2, tokens: { inputTokens: 10, outputTokens: 4 }, nanoAiu: 0, billedCalls: 1 });
        expect(selectTaskUsage(reports).total).toEqual({ calls: 3, tokens: { inputTokens: 30, outputTokens: 4 }, nanoAiu: 10, billedCalls: 2 });
        expect(selectTaskUsage(reports, parseTaskUsagePeriod('2026-11-19')).total).toEqual({ calls: 1, tokens: { outputTokens: 4 } });
        expect(selectTaskUsage(reports, parseTaskUsagePeriod('2026-11-21'))).toEqual({ tasks: [], total: { calls: 0, tokens: {} } });
    });

    it('rejects invalid and reversed custom dates', () => {
        expect(parseTaskUsagePeriod('2026-02-29')).toBeUndefined();
        expect(parseTaskUsagePeriod('2026-11-20 to 2026-11-19')).toBeUndefined();
        expect(parseTaskUsagePeriod('2024-02-29')).toEqual({ from: +new Date(2024, 1, 29), until: +new Date(2024, 2, 1) });
    });

    it.skipIf(process.platform !== 'win32')('accepts a marker with a different drive-letter case', () => {
        const lines = [user('01'), ...marker('task', 'lead', 'start', 'c:/repo'),
            ...marker('task', 'lead', 'close', 'c:/repo'), usage('lead', 3), end];
        expect(summarizeTaskUsage(readUsageInteractions(lines, 'C:/repo'))[0]?.total.calls).toBe(1);
    });
    it('recovers completed worker handoffs without counting untrusted routes or duplicate accounting', () => {
        const receipt = (id: string, sender: string, text: string) => [
            line('external_tool.requested', { toolName: 'jarvis_receiveMessage', toolCallId: id }),
            line('tool.execution_complete', { success: true, toolCallId: id, result: { content: JSON.stringify({ message: { sender, text } }) } }),
        ];
        const recorded = (id: string) => line('session.usage_record', { usage: { inputTokens: 9,
            copilotUsage: { totalNanoAiu: 125_000_000 }, accounting: { sourceSessionId: 'session', usageId: 'usage' } } }, id);
        const lines = [user('01'), ...marker('task', 'lead', 'start'), end,
            user('02'), recorded('first'), ...receipt('test', 'lead', 'TEST | task'), ...marker('task', 'tester', 'work'), recorded('duplicate'), end,
            user('03'), ...receipt('code', 'lead', 'CODE | task'), usage('coder', 10), end,
            user('04'), ...receipt('review', 'lead', 'REVIEW | task | 0'), usage('verify', 11), end,
            user('05'), ...receipt('fix', 'verify', 'FIX | task | 1\nfile:line'), usage('fix', 12), end,
            user('06'), ...receipt('invalid', 'tester', 'CODE | task'), usage('unrelated', 99), end,
            user('07'), ...marker('task', 'lead', 'close'), end];
        const [report] = summarizeTaskUsage(readUsageInteractions(lines, workspace));
        expect(report.rows.tester).toMatchObject({ calls: 1, nanoAiu: 125_000_000, billedCalls: 1 });
        expect(report.rows.coder.calls).toBe(2);
        expect(report.rows.verify.calls).toBe(1);
        expect(report.total).toMatchObject({ calls: 4, tokens: { inputTokens: 42 }, nanoAiu: 125_000_000, billedCalls: 1 });
    });

    it('can attribute a task that starts and closes within one interaction', () => {
        const lines = [user('01'), ...marker('task', 'lead', 'start'), ...marker('task', 'lead', 'close'), usage('lead', 3), end];
        expect(summarizeTaskUsage(readUsageInteractions(lines, workspace))[0].rows.lead.tokens.inputTokens).toBe(3);
    });

    it('uses the calling Actor and reserves lifecycle phases for lead', async () => {
        const tool = createTaskUsageTool(workspace);
        const context = { title: 'tester', session: 'session', chat: 'chat' };
        expect(await tool.handler(context, { taskId: 'task', phase: 'work', actor: 'lead' })).toEqual({
            text: `JARVIS_TASK_USAGE ${JSON.stringify({ workspace, taskId: 'task', actor: 'tester', phase: 'work' })}`,
        });
        expect((await tool.handler(context, { taskId: 'task', phase: 'close' })).isError).toBe(true);
        expect((await tool.handler(context, { taskId: '../task', phase: 'work' })).isError).toBe(true);
    });

    it('sums only matching marked interactions, including calls before the marker and deduplicating records', () => {
        const lead = [user('01'), usage('old', 99), end, user('02'), usage('lead', 8), ...marker('task', 'lead', 'start'), end,
            user('05'), ...marker('task', 'lead', 'close'), usage('close', 6), end];
        const tester = [user('03'), usage('test', 12), ...marker('task', 'tester', 'work'), usage('test', 12), end,
            user('04'), ...marker('task', 'tester', 'work', '/elsewhere'), usage('foreign', 500), end];
        const [report] = summarizeTaskUsage([lead, tester].flatMap(lines => readUsageInteractions(lines, workspace)));
        expect(report.rows.tester).toEqual({ calls: 1, tokens: { inputTokens: 12, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1 } });
        expect(report.rows.coder).toEqual({ calls: 0, tokens: {} });
        expect(report.total).toEqual({ calls: 3, tokens: { inputTokens: 26, outputTokens: 6, cacheReadTokens: 12, reasoningTokens: 3 } });
    });

    it('does not publish an open report or count a turn with conflicting task markers', () => {
        const lines = [user('01'), ...marker('task', 'lead', 'start'), end,
            user('02'), ...marker('task', 'coder', 'work'), ...marker('other', 'coder', 'work'), usage('mixed', 50), end,
            user('03'), ...marker('task', 'lead', 'close')];
        expect(summarizeTaskUsage(readUsageInteractions(lines, workspace))).toEqual([]);
        expect(summarizeTaskUsage(readUsageInteractions([...lines, end], workspace))[0].total.calls).toBe(0);
    });
});