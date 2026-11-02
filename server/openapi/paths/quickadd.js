import { op, jsonBody } from '../helpers.js';

export function quickAddPaths() {
  return {
    '/api/v1/quick-add/parse': {
      post: op({
        summary: 'Turn one dictated sentence into a task, an event or shopping items (AI)',
        tag: 'AI',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { text, kind? } with `text` of 1 to 500 characters after trimming (else 400) and `kind` one of '
          + '`task`, `event`, `shopping` (else 400). Without `kind`, one Haiku call decides the kind (AI feature `task_dictation`, '
          + 'the same switch as `POST /api/v1/tasks/parse`); with it, the answer is always that kind. Saves nothing: the client '
          + 'opens the matching sheet filled in and the person checks it. Returns `{ data: { source: \'ai\', kind, fields } }`: '
          + 'for `task` the fields of `POST /api/v1/tasks/parse`; for `event` { title, date, start_time, end_time, all_day, '
          + 'location, assigned_to, reminder_minutes } (a day without an hour is all day, an hour without a day is today when '
          + 'still ahead, else tomorrow, no end said is null, `reminder_minutes` whole minutes before the start or null); for '
          + '`shopping` { items: [{ name, quantity }] } (at most 20, `quantity` as said or null). An event with neither a day '
          + 'nor an hour and a shopping answer without items come back as a task with the sentence as title. When the AI cannot '
          + 'answer (switched off, no key, monthly limit, network) the status is 200 with `{ data: { source: null, unavailable: '
          + 'code } }`. Write access is checked per kind: a member who may write none of tasks, calendar and shopping, or not '
          + 'the given `kind`, is refused with 403 before any AI call; a routed kind the member may not write comes back as a '
          + 'task when they may write tasks, else 403. A paired wall display and a scoped API token are always refused with 403.',
      }),
    },
  };
}
