import * as vscode from 'vscode';
import { TASK_ACTORS, type TaskActor, type WorkflowTask, type WorkflowTasks } from '../../engine/sessions/workflowTasks';

type Node = { task: WorkflowTask; actor?: TaskActor };

interface TaskActions {
    checkLead(): Promise<void>;
    open(taskId: string, actor: TaskActor, createIfMissing?: boolean): Promise<void>;
    resumed(): void;
}

const statusLabels = { active: 'Active', paused: 'Paused', completed: 'Completed' };
const groupIcon = { active: 'circle-filled', paused: 'debug-pause', completed: 'check' };

export function registerWorkflowTasksView(context: vscode.ExtensionContext, tasks: WorkflowTasks, actions: TaskActions): () => void {
    const changed = new vscode.EventEmitter<void>();
    const openCommand = 'jarvis.workflowTask.openChat';
    const view = vscode.window.createTreeView<Node>('jarvisWorkflowTasks', {
        treeDataProvider: {
            onDidChangeTreeData: changed.event,
            getChildren: (node?: Node): Node[] => !node ? tasks.tasks.map(task => ({ task }))
                : node.actor ? [] : TASK_ACTORS.filter(actor => node.task.sessions[actor]).map(actor => ({ task: node.task, actor })),
            getTreeItem: ({ task, actor }: Node): vscode.TreeItem => {
                const item = new vscode.TreeItem(actor ?? task.title, actor || !Object.keys(task.sessions).length
                    ? vscode.TreeItemCollapsibleState.None
                    : task.status === 'active' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
                item.id = JSON.stringify([task.id, actor]);
                item.iconPath = new vscode.ThemeIcon(actor ? 'comment-discussion' : groupIcon[task.status]);
                if (!actor) {
                    item.contextValue = task.status === 'active' ? 'jarvisWorkflowTaskActive' : 'jarvisWorkflowTaskInactive';
                    item.description = statusLabels[task.status];
                    item.tooltip = task.title;
                }
                if (task.status === 'active') {
                    item.command = { command: openCommand, title: 'Open Task Chat', arguments: [task.id, actor ?? 'lead', !actor] };
                }
                return item;
            },
        },
    });
    const refresh = (): void => {
        view.message = tasks.tasks.length ? undefined : 'No tasks yet.';
        changed.fire();
    };
    const command = <Args extends unknown[]>(id: string, handler: (...args: Args) => Promise<void>): vscode.Disposable => (
        vscode.commands.registerCommand(id, async (...args: Args) => {
            try { await handler(...args); }
            catch (error) { void vscode.window.showWarningMessage(`Jarvis: ${error instanceof Error ? error.message : String(error)}`); }
        })
    );
    const stop = async (status: 'paused' | 'completed'): Promise<void> => {
        const task = tasks.active;
        if (!task) { return; }
        const label = status === 'paused' ? 'Pause Task' : 'Complete Task';
        const answer = await vscode.window.showWarningMessage(`${label}: ${task.title}?`, {
            modal: true,
            detail: 'Jarvis saves the task contract and chats. It does not stash, commit, or restore changes to your working tree.',
        }, label);
        if (answer === label) { await tasks.stop(task.id, status); }
    };
    context.subscriptions.push(view, changed,
        command('jarvis.workflowTask.new', async () => {
            if (tasks.active) { throw new Error('Pause or complete the active task first.'); }
            const title = await vscode.window.showInputBox({ title: 'New Jarvis Task', prompt: 'Task name', validateInput: value => value.trim() ? undefined : 'Enter a task name.' });
            if (!title) { return; }
            await actions.checkLead();
            const task = await tasks.start(title);
            await actions.open(task.id, 'lead', true);
        }),
        command('jarvis.workflowTask.resume', async (node?: Node) => {
            if (tasks.active) { throw new Error('Pause or complete the active task first.'); }
            const task = node?.task ?? (await vscode.window.showQuickPick(tasks.tasks.map(candidate => ({
                label: candidate.title, description: statusLabels[candidate.status], task: candidate,
            })), { title: 'Resume Jarvis Task' }))?.task;
            if (!task) { return; }
            await actions.checkLead();
            await tasks.resume(task.id);
            await actions.open(task.id, 'lead', true);
            actions.resumed();
        }),
        command('jarvis.workflowTask.pause', () => stop('paused')),
        command('jarvis.workflowTask.complete', () => stop('completed')),
        command(openCommand, actions.open),
    );
    refresh();
    return refresh;
}