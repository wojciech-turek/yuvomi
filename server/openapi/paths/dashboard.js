import { op } from '../helpers.js';

export function dashboardPaths() {
  return {
    '/api/v1/dashboard': {
      get: op({
        summary: 'Get dashboard data',
        tag: 'Dashboard',
        description: 'Aggregated data for every overview tile. The same answer for everyone: nothing stored per person changes it. The only query parameter is `audience`. `weekEvents` holds the events touching the household days from yesterday to a week ahead, in a compact shape. `upcomingEvents` counts only appointments that have not ended toward its five-item cap; already ended ones of today (end before now in the household time zone, never all-day ones) come along outside the cap. `familyEvents` feeds the Family card: per household member the appointments of today (ended ones included) and the next coming ones, merged once. `wallTasks` is computed only for a shared surface (`audience=household` or a paired display) and is an empty array in the personal version: per household member the household-visible tasks of today by title (`open`: not done and due today or earlier; `done`: done and due today, or overdue and ticked off today in the household time zone), at most six titles each next to the uncapped `open_count` and `done_count`. Unlike every other task slice it carries only tasks with visibility `all`, whoever the caller is: a wall tablet is not a person. `wastePickups` lists the collections of today and tomorrow (Waste module), `myShiftsToday` the own shifts of the caller of today (Schedule module); both are empty when the module is denied. `splitBalance` (`{ net, positions }`) lists what the caller has open in shared expenses: net per currency and each open position from the settle-up view of the caller\'s active groups (the same balances as `GET /split-expenses/groups/{id}/balances`), household currency first; it is empty without `budget` read access. A module the household has switched off (`disabled_modules` in `/preferences`) is left out the same way as a denied one: its fields stay in the response with their empty values. `birthdays` is a switch of its own here, so the birthday fields follow it rather than the `calendar` switch, and `upcomingEvents`, `weekEvents` and `familyEvents` carry no birthday events while it is off.',
        params: [
          {
            name: 'audience',
            in: 'query',
            required: false,
            description: '`household` asks for the version for a shared surface (wall mode): an allowlist. The response then carries only the keys a wall draws: `users`, `upcomingEvents`, `birthdays`, `todayMeals`, `shoppingOpenCount`, `wallTasks`, `planTasks`, `planEvents`, `tomorrowMeals`, `dinnerPlan`, `shoppingLists`, `wastePickups`, of `pantryExpiring` the fields `todayItems` and `todayCount`, and of `housekeeping` the fields `present`, `presentSince` and `workerName`. Tasks and appointments in them are those the whole household may see - visibility `all`, appointments from ICS subscriptions only from shared ones - whoever the caller is, creator and assignees included. Every other key keeps its place in the same empty form as for a caller without the module - notes, `budget`, `splitBalance`, `quicklinks`, `countdowns`, the counters and week/family slices of tasks and calendar, `housekeeping.unpaidAmount`, and what belongs to the caller alone (`health`, `fasting`, `nutrition`, `myShiftsToday`). A key added to this response later is empty for this audience until it is put on the list. The parameter only narrows the response, so it needs no scope of its own. Anything else means the personal version.',
            schema: { type: 'string', enum: ['household'] },
          },
        ],
      }),
    },
  };
}
