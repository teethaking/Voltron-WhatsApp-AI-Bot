const updates = require('../lib/updates');

module.exports = {
  commands: [
    {
      name: 'update',
      aliases: ['upgrade'],
      owner: true,
      cat: 'Owner',
      desc: 'Install the newest version from GitHub and restart. ".update check" only looks, ".update force" reinstalls',
      async run(ctx) {
        const { updateRepo, updateBranch } = ctx.config;
        const mode = (ctx.args[0] || '').toLowerCase();
        const { head, upToDate } = await updates.pending();
        const sha = head.sha.slice(0, 7);
        const title = String(head.commit.message).split(/\r?\n/)[0];

        if (mode === 'check') {
          return ctx.reply(upToDate
            ? `✅ You are on the latest version (${sha}).`
            : `🔔 A newer version is out: ${sha} "${title}".
Send ${ctx.config.prefix}update to install it.`);
        }
        if (upToDate && mode !== 'force') return ctx.reply(`✅ Already on the latest version (${sha}).
https://github.com/${updateRepo}/tree/${updateBranch}`);

        await ctx.reply(`⬇️ Updating to ${sha} "${title}"...`);
        try {
          await updates.apply(head);
        } catch (e) {
          return ctx.reply(`❌ Update failed: ${e.message}
Nothing was restarted.`);
        }
        await ctx.reply('✅ Update installed. Restarting now, I will be back in a few seconds. If the panel leaves the bot stopped, press Start.');
        updates.restart();
      },
    },
  ],
};
