import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('const plannerPending = new Map();');
const end = source.indexOf('async function plannerModel(', start);
assert.ok(start >= 0 && end > start, 'planner core should be present in server.js');
const sandbox = {
  crypto,
  Date,
  structuredClone,
  userKey: email => 'users/' + crypto.createHash('sha256').update(email.toLowerCase()).digest('hex') + '.json'
};
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.plannerTestApi = { plannerKey, emptyPlanner, plannerDate, applyPlannerAction, plannerSafeState };', sandbox);
const { plannerKey, emptyPlanner, plannerDate, applyPlannerAction, plannerSafeState } = sandbox.plannerTestApi;

test('planner storage key is hashed and scoped to each account', () => {
  const alice = plannerKey('Alice@example.com');
  const bob = plannerKey('bob@example.com');
  assert.match(alice, /^planner\/[a-f0-9]{64}\.json$/);
  assert.notEqual(alice, bob);
  assert.equal(alice, plannerKey('alice@example.com'));
});

test('projects, folders, task lists, tasks, subtasks, and assignments persist in user state', () => {
  const state = emptyPlanner();
  const project = applyPlannerAction(state, 'alice@example.com', { type: 'create_project', name: 'Science Fair', folder: 'School' });
  const list = applyPlannerAction(state, 'alice@example.com', { type: 'create_list', projectId: project.projectId, name: 'Research' });
  const task = applyPlannerAction(state, 'alice@example.com', { type: 'create_task', projectId: project.projectId, listId: list.listId, title: 'Find sources', assignee: 'Alex', priority: 'high', dueDate: '2026-11-10' });
  const subtask = applyPlannerAction(state, 'alice@example.com', { type: 'create_task', projectId: project.projectId, listId: list.listId, parentId: task.taskId, title: 'Search library' });
  assert.equal(state.projects[0].folder, 'School');
  assert.equal(state.projects[0].lists[1].name, 'Research');
  assert.equal(state.tasks[0].assignee, 'Alex');
  assert.equal(state.tasks[0].dueDate, '2026-11-10');
  assert.equal(state.tasks[1].parentId, task.taskId);
  assert.equal(subtask.taskId, state.tasks[1].id);
});

test('task updates, checklist, comments, and cross-list moves validate identifiers', () => {
  const state = emptyPlanner();
  const project = applyPlannerAction(state, 'alice', { type: 'create_project', name: 'Exam prep' });
  const list = applyPlannerAction(state, 'alice', { type: 'create_list', projectId: project.projectId, name: 'This week' });
  const task = applyPlannerAction(state, 'alice', { type: 'create_task', projectId: project.projectId, title: 'Review algebra' });
  applyPlannerAction(state, 'alice', { type: 'update_task', taskId: task.taskId, status: 'in_progress', priority: 'urgent', description: '**Practice** problems' });
  const check = applyPlannerAction(state, 'alice', { type: 'add_checklist_item', taskId: task.taskId, text: 'Complete worksheet' });
  applyPlannerAction(state, 'alice', { type: 'toggle_checklist_item', taskId: task.taskId, itemId: check.itemId, done: true });
  applyPlannerAction(state, 'alice', { type: 'add_comment', taskId: task.taskId, text: 'Ask for help on question 4' });
  applyPlannerAction(state, 'alice', { type: 'move_task', taskId: task.taskId, projectId: project.projectId, listId: list.listId });
  assert.equal(state.tasks[0].status, 'in_progress');
  assert.equal(state.tasks[0].priority, 'urgent');
  assert.equal(state.tasks[0].checklist[0].done, true);
  assert.equal(state.tasks[0].comments[0].text, 'Ask for help on question 4');
  assert.equal(state.tasks[0].listId, list.listId);
  assert.throws(() => applyPlannerAction(state, 'alice', { type: 'update_task', taskId: 'foreign-task', status: 'completed' }));
});

test('deletion requires confirmation and removes subtasks only after confirmation', () => {
  const state = emptyPlanner();
  const project = applyPlannerAction(state, 'alice', { type: 'create_project', name: 'Plan' });
  const parent = applyPlannerAction(state, 'alice', { type: 'create_task', projectId: project.projectId, title: 'Parent' });
  applyPlannerAction(state, 'alice', { type: 'create_task', projectId: project.projectId, parentId: parent.taskId, title: 'Child' });
  assert.throws(() => applyPlannerAction(state, 'alice', { type: 'delete_task', taskId: parent.taskId }), /confirmation/i);
  assert.equal(state.tasks.length, 2);
  applyPlannerAction(state, 'alice', { type: 'delete_task', taskId: parent.taskId }, { confirmed: true });
  assert.equal(state.tasks.length, 0);
});

test('dates and statuses reject malformed values, safe state is bounded', () => {
  assert.equal(plannerDate('2026-11-04'), '2026-11-04');
  assert.throws(() => plannerDate('2026-02-31'));
  const state = emptyPlanner();
  const project = applyPlannerAction(state, 'alice', { type: 'create_project', name: 'Plan' });
  const task = applyPlannerAction(state, 'alice', { type: 'create_task', projectId: project.projectId, title: 'Task' });
  assert.throws(() => applyPlannerAction(state, 'alice', { type: 'update_task', taskId: task.taskId, status: 'admin' }));
  assert.deepEqual(Object.keys(plannerSafeState(state)).sort(), ['activity','projects','tasks','version']);
});
