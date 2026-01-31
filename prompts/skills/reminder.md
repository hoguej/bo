# Reminder skill

Use when the user wants to set, list, update, or cancel reminders (one-off or recurring) for themselves or others.

## Actions

- **create**: Set a reminder. Requires `text` (what to do at fire time). For one-off: provide `fire_at_iso` (UTC ISO time, e.g. 2025-01-30T16:30:00.000Z). For recurring: provide `fire_at_iso` for first run and `recurrence` (e.g. "daily 08:30"). Use `for_contact` to set a reminder for someone else (first name).
- **list**: Show reminders. Optional `filter`: "for_me" (reminders for the user), "by_me" (reminders the user created for others), or omit for both.
- **update**: Change a reminder. Requires `reminder_id`. Optional: `new_text`, `new_fire_at_iso`, `new_recurrence`.
- **delete**: Cancel a reminder. Requires `reminder_id`.

## Output

The skill returns a short confirmation (e.g. "Reminder #3 set for you at 1/30/2025, 8:30 AM: …") or the list of reminders. Use that in create_response.
