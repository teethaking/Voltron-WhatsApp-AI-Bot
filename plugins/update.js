const updates = require('../lib/updates');
const store = require('../lib/store');

module.exports = {
  commands: [
    {
      name: 'update',
      aliases: ['checkupdate'],
      owner: true,
      cat: 'Owner',
      desc: 'Check GitHub for new changes now. The bot also DMs you by itself when something new is pushed',
      async run(ctx) {
        const { updateRepo, updateBranch } = ctx.config;
        const before = store.db.lastSha;
        const state = await updates.check({ force: false });
        if (state === 'sent') return; // the update DM was just sent
        if (state === 'busy') return ctx.reply('Already checking, try again in a moment.');
        const sha = (store.db.lastSha || before || '').slice(0, 7);
        return ctx.reply(`✅ You are up to date.\nLatest commit: ${sha || 'unknown'}\nhttps://github.com/${updateRepo}/tree/${updateBranch}`);
      },
    },
  ],
};
