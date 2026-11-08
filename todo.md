# TODO

In priority order.

1. **One-call overview (`get_today`).** Return dailies due today, overdue to-dos, to-dos due soon, and HP and damage status together. Right now "what's on my plate?" takes three or four calls. This would also be the basis for a morning check-in.
2. **Create missing tags automatically.** `create_task` and `tag_task` fail if the tag doesn't exist yet. Add an `autoCreate` flag so Claude doesn't have to call `create_tag` first. The suggestions covered several areas (Kiln flat, Scran, Bison, fitness), so tags will come up often.
3. **Finish off `update_task`.** It can't change a habit's +/- buttons, a reward's cost or a task's tags. Add those so every field you can set at creation can also be edited.
4. **Reminders.** Habitica supports reminders on dailies and on to-dos with a due date. Being able to say "remind me at 6pm" when creating a task would help with things like the fire door's 24 Nov deadline.
5. **Clear completed to-dos and archive.** Lower priority. Use it to tidy up after a batch of to-dos is done.
