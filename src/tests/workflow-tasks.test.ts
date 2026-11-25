import { describe, expect, it, vi } from 'vitest';
import { createAnnouncer, type InboxMessage } from '../../packages/core/src/engine/sessions/actorAnnouncements';
import { createActorMessageTools } from '../../packages/core/src/engine/sessions/actorMessageTools';
import { WorkflowTasks, type WorkflowState } from '../../packages/core/src/engine/sessions/workflowTasks';

function fixture() {
    let contract: string | null = 'legacy plan';
    let state: WorkflowState = { tasks: [], previousContract: null };
    const deps = {
        save: vi.fn(async (value: WorkflowState) => { state = structuredClone(value); }),
        readContract: () => contract,
        writeContract: (value: string | null) => { contract = value; },
        checkIdle: vi.fn(async () => {}),
        changed: vi.fn(),
    };
    return { reload: () => new WorkflowTasks(state, deps), deps };
}

describe('workflow task lifecycle', () => {
    it('saves each contract and restores independent Actor bindings after reload', async () => {
        const { reload, deps } = fixture();
        let tasks = reload();
        const alpha = await tasks.start('Alpha');
        expect(deps.readContract()).toBeNull();
        expect(alpha.sessions).toEqual({});
        deps.writeContract('alpha plan');
        await tasks.binding(alpha.id, 'lead').bind('alpha-lead');
        await tasks.binding(alpha.id, 'coder').bind('alpha-coder');
        await expect(tasks.start('Blocked')).rejects.toThrow('active task');
        await tasks.stop(alpha.id, 'paused');
        expect(deps.readContract()).toBe('legacy plan');
        const beta = await tasks.start('Beta');
        await tasks.binding(beta.id, 'lead').bind('beta-lead');
        expect(tasks.binding(beta.id, 'coder').session()).toBeUndefined();
        deps.writeContract('beta plan');
        tasks = reload();
        expect(tasks.active?.id).toBe(beta.id);
        await tasks.stop(beta.id, 'completed');
        await tasks.resume(alpha.id);
        expect(deps.readContract()).toBe('alpha plan');
        expect(tasks.binding(alpha.id, 'lead').session()).toBe('alpha-lead');
        expect(tasks.taskForSession('alpha-coder')).toEqual({ id: alpha.id, actor: 'coder' });
        await tasks.retire(alpha.id, 'coder', 'alpha-coder');
        expect(tasks.taskForSession('alpha-coder')).toMatchObject({ retired: true });
        expect(reload().active?.retiredActors).toEqual({ coder: ['alpha-coder'] });
        expect(tasks.binding(alpha.id, 'coder').session()).toBeUndefined();
        await tasks.stop(alpha.id, 'paused');
        await tasks.resume(beta.id);
        expect(deps.readContract()).toBe('beta plan');
    });

    it('does not switch a busy task or lose a contract if saving fails', async () => {
        const { reload, deps } = fixture();
        const tasks = reload();
        const alpha = await tasks.start('Alpha');
        deps.writeContract('alpha plan');
        deps.checkIdle.mockRejectedValueOnce(new Error('Host is busy'));
        await expect(tasks.stop(alpha.id, 'paused')).rejects.toThrow('busy');
        const work = Promise.withResolvers<void>();
        const sending = tasks.run(alpha.id, () => work.promise);
        await expect(tasks.stop(alpha.id, 'paused')).rejects.toThrow('delivering');
        work.resolve();
        await sending;
        deps.save.mockImplementationOnce(deps.save.getMockImplementation()!).mockRejectedValueOnce(new Error('Storage unavailable'));
        await expect(tasks.stop(alpha.id, 'paused')).rejects.toThrow('Storage unavailable');
        expect(deps.readContract()).toBe('alpha plan');
        expect(tasks.isActive(alpha.id)).toBe(true);
    });

    it('rolls back an interrupted swap on reload without overwriting subsequent edits', async () => {
        const { reload, deps } = fixture();
        await deps.save({ tasks: [], previousContract: null, pendingContract: { before: 'legacy plan', after: null } });
        deps.writeContract('unsaved in the registry');
        await expect(reload().recover()).rejects.toThrow('changed after an interrupted switch');
        expect(deps.readContract()).toBe('unsaved in the registry');
        deps.writeContract(null);
        const tasks = reload();
        await tasks.recover();
        expect(deps.readContract()).toBe('legacy plan');
        expect(tasks.ownsContract).toBe(false);
    });
});

describe('workflow task inbox', () => {
    it('uses the sender session, isolates late messages, and only announces the active task', async () => {
        const queue: InboxMessage[] = [];
        let active = 'second';
        const tools = createActorMessageTools({
            actors: () => [],
            lookup: name => ({ status: 'found', name }),
            taskForSession: session => ({ id: session.startsWith('first') ? 'first' : 'second', actor: session.endsWith('lead') ? 'lead' : 'coder' }),
            isActiveTask: id => active === id,
            appendMessage: (destination, sender, text, taskId) => { queue.push({ destination, sender, text, taskId, timestamp: 'same' }); },
            popMessage: (name, taskId) => {
                const index = queue.findIndex(message => message.destination === name && message.taskId === taskId);
                return { message: index < 0 ? null : queue.splice(index, 1)[0], remaining: 0 };
            },
            ensureChat: async () => 'unused', changed: () => undefined, log: () => undefined,
        });
        const send = tools.find(tool => tool.name === 'jarvis_sendMessage')!;
        const receive = tools.find(tool => tool.name === 'jarvis_receiveMessage')!;
        const context = (session: string) => ({ session, title: 'renamed', chat: 'unused' });
        const announce = vi.fn(async () => {});
        const announcer = createAnnouncer({
            readQueue: () => queue, writeQueue: () => undefined, autoDelivery: () => ['coder'],
            canDeliverTask: id => active === id, announce, changed: () => undefined, log: () => undefined,
        });
        const input = { session: 'coder', text: 'same body', taskId: 'second' };
        await send.handler(context('first-lead'), input);
        await send.handler(context('second-lead'), input);
        await announcer.runAuto();
        expect(announce.mock.calls).toEqual([['coder', 1, 'second']]);
        expect(queue.map(message => [message.taskId, message.notified])).toEqual([['first', undefined], ['second', true]]);
        expect((await receive.handler(context('first-coder'), {})).isError).toBe(true);
        expect(JSON.parse((await receive.handler(context('second-coder'), {})).text).message.sender).toBe('lead');
        expect(queue.map(message => message.taskId)).toEqual(['first']);
        active = 'first';
        await announcer.runAuto();
        expect(announce.mock.calls.at(-1)).toEqual(['coder', 1, 'first']);
    });
});