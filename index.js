const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error(`Node.js ${process.versions.node} is too old. This bot needs Node 20 or newer (set it in your host's settings).`);
  process.exit(1);
}

require('dotenv').config();
const { remote, enabled } = require('./lib/remote');

// With DATABASE_URL, the login and settings are restored from the database before anything reads the disk.
remote
  .pull()
  .then((n) => enabled && console.log(`Database connected, ${n} saved file(s) restored.`))
  .catch((e) => console.error('Could not reach the database, using local files only:', e.message))
  .then(() => {
    require('./app');
    remote.start();
  });
