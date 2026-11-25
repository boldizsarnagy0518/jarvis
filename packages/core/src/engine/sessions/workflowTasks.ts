import { randomUUID } from 'crypto';
import type { ActorChatRequest } from '../ahp';

export const TASK_ACTORS = ['lead', 'tester', 'coder', 'verify'] as const;
export type TaskActor = typeof TASK_ACTORS[number];
export function isTaskActor(name: string): name is TaskActor {
    return TASK_ACTORS.some(actor => actor === name);
}

export interface WorkflowTask {
    id: string;
    title: string;
    status: 'active' | 'paused' | 'completed';
    sessions: Partial<Record<TaskActor, string>>;
    retired: string[];
    retiredActors?: Partial<Record<TaskActor, string[]>>;
    contract: string | null;
}

export interface WorkflowState {
    tasks: WorkflowTask[];
    previousContract: string | null;
    pendingContract?: { before: string | null; after: string | null };
}

interface WorkflowTaskDeps {
    save(state: WorkflowState): PromiseLike<void>;
    readContract(): string | null;
    writeContract(contents: string | null): void;
    checkIdle(task: WorkflowTask): Promise<void>;
    changed(): void;
}

export class WorkflowTasks {
    private tail: Promise<unknown> = Promise.resolve();
    private switching = false;
    private inFlight = 0;

    constructor(private state: WorkflowState, private readonly deps: WorkflowTaskDeps) {}

    get tasks(): readonly WorkflowTask[] { return this.state.tasks; }
    get active(): WorkflowTask | undefined { return this.tasks.find(task => task.status === 'active'); }
    get ownsContract(): boolean { return this.switching || !!this.active || !!this.state.pendingContract; }

    isActive(id: string): boolean { return !this.switching && !this.state.pendingContract && this.active?.id === id; }

    taskForSession(session: string): { id: string; actor: string; retired?: boolean } | undefined {
        for (const task of this.tasks) {
            for (const actor of TASK_ACTORS) {
                if (task.sessions[actor] === session) { return { id: task.id, actor }; }
            }
            if (task.retired.includes(session)) { return { id: task.id, actor: '', retired: true }; }
        }
        return undefined;
    }

    binding(id: string, actor: TaskActor): NonNullable<ActorChatRequest['task']> {
        return {
            id,
            session: () => this.tasks.find(task => task.id === id)?.sessions[actor],
            bind: session => this.serialize(async () => {
                const task = this.requireActive(id);
                if (task.sessions[actor] || this.taskForSession(session)) { throw new Error('This task chat is already bound.'); }
                await this.updateTask({ ...task, sessions: { ...task.sessions, [actor]: session } });
            }),
        };
    }

    async run<T>(id: string, work: () => Promise<T>): Promise<T> {
        this.requireActive(id);
        return this.hold(work);
    }

    async runLegacy<T>(work: () => Promise<T>): Promise<T> {
        if (this.ownsContract) { throw new Error('Use the chat under the active Jarvis task.'); }
        return this.hold(work);
    }

    recover(): Promise<void> {
        return this.serialize(() => this.restoreInterruptedSwap());
    }

    private async hold<T>(work: () => Promise<T>): Promise<T> {
        this.inFlight++;
        try { return await work(); }
        finally { this.inFlight--; }
    }

    start(title: string): Promise<WorkflowTask> {
        const name = title.trim();
        if (!name) { return Promise.reject(new Error('Enter a task name.')); }
        return this.activate({ id: randomUUID(), title: name, status: 'paused', sessions: {}, retired: [], contract: null });
    }

    resume(id: string): Promise<WorkflowTask> {
        return this.activate(id);
    }

    stop(id: string, status: 'paused' | 'completed'): Promise<void> {
        return this.serialize(async () => {
            await this.restoreInterruptedSwap();
            const task = this.requireActive(id);
            if (this.inFlight) { throw new Error('Wait for Jarvis to finish delivering or opening chats.'); }
            this.switching = true;
            try {
                await this.deps.checkIdle(task);
                const contract = this.deps.readContract();
                await this.swapContract(contract, this.state.previousContract,
                    { ...task, contract, status }, null);
            } finally { this.switching = false; }
        });
    }

    retire(id: string, actor: TaskActor, session: string): Promise<void> {
        return this.serialize(async () => {
            const task = this.requireActive(id);
            if (this.inFlight || task.sessions[actor] !== session) { throw new Error('The task chat changed. Try again.'); }
            const sessions = { ...task.sessions };
            delete sessions[actor];
            const retiredActors = { ...task.retiredActors, [actor]: [...(task.retiredActors?.[actor] ?? []), session] };
            await this.updateTask({ ...task, sessions, retired: [...task.retired, session], retiredActors });
        });
    }

    private activate(target: string | WorkflowTask): Promise<WorkflowTask> {
        return this.serialize(async () => {
            await this.restoreInterruptedSwap();
            if (this.active) { throw new Error('Pause or complete the active task first.'); }
            if (this.inFlight) { throw new Error('Wait for Jarvis to finish delivering or opening chats.'); }
            const task = typeof target === 'string' ? this.tasks.find(candidate => candidate.id === target) : target;
            if (!task) { throw new Error('Task not found.'); }
            this.switching = true;
            try {
                await this.deps.checkIdle(task);
                const current = this.deps.readContract();
                const active: WorkflowTask = { ...task, status: 'active' };
                await this.swapContract(current, task.contract, active, current);
                return active;
            } finally { this.switching = false; }
        });
    }

    private async swapContract(current: string | null, next: string | null, task: WorkflowTask, previousContract: string | null): Promise<void> {
        if (current === next) { await this.updateTask(task, previousContract); return; }
        await this.persist({ ...this.state, pendingContract: { before: current, after: next } });
        let changedFile = false;
        try {
            if (this.deps.readContract() !== current) { throw new Error('The task contract changed while switching. Try again.'); }
            this.deps.writeContract(next);
            changedFile = true;
            await this.updateTask(task, previousContract);
        }
        catch (error) {
            if (changedFile) { await this.restoreInterruptedSwap(); }
            else { await this.persist({ tasks: this.state.tasks, previousContract: this.state.previousContract }); }
            throw error;
        }
    }

    private async restoreInterruptedSwap(): Promise<void> {
        const pending = this.state.pendingContract;
        if (!pending) { return; }
        const current = this.deps.readContract();
        if (current === pending.after) { this.deps.writeContract(pending.before); }
        else if (current !== pending.before) { throw new Error('The task contract changed after an interrupted switch. Jarvis left the file and its saved backup unchanged.'); }
        await this.persist({ tasks: this.state.tasks, previousContract: this.state.previousContract });
    }

    private async updateTask(task: WorkflowTask, previousContract = this.state.previousContract): Promise<void> {
        await this.persist({ tasks: [task, ...this.tasks.filter(candidate => candidate.id !== task.id)], previousContract });
        this.deps.changed();
    }

    private async persist(state: WorkflowState): Promise<void> {
        await this.deps.save(state);
        this.state = state;
    }

    private requireActive(id: string): WorkflowTask {
        const task = this.active;
        if (!task || !this.isActive(id)) { throw new Error('This Jarvis task is not active. Resume it first.'); }
        return task;
    }

    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const next = this.tail.catch(() => undefined).then(work);
        this.tail = next;
        return next;
    }
}