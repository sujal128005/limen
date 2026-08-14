'use strict';
const net = require('net');

// Tests, e2e and the snapshot recorder each boot their own EVM and server.
// Fixed ports meant `npm test` failed while `npm start` was running, which is
// exactly when you want to run it.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { getFreePort };
