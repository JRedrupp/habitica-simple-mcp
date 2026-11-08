# TODO

In priority order.

1. **Create missing tags automatically.** `create_task` and `tag_task` fail if the tag doesn't exist yet. Add an `autoCreate` flag so Claude doesn't have to call `create_tag` first. The suggestions covered several areas (Kiln flat, Scran, Bison, fitness), so tags will come up often.
2. **Finish off `update_task`.** It can't change a habit's +/- buttons, a reward's cost or a task's tags. Add those so every field you can set at creation can also be edited.
3. **Reminders.** Habitica supports reminders on dailies and on to-dos with a due date. Being able to say "remind me at 6pm" when creating a task would help with things like the fire door's 24 Nov deadline.
4. **Clear completed to-dos and archive.** Lower priority. Use it to tidy up after a batch of to-dos is done.
