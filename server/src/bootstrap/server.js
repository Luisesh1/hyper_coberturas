function startHttpServer({ server, port, onShutdown }) {
  return new Promise((resolve, reject) => {
    let shuttingDown = false;

    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });

    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;

      if (typeof onShutdown === 'function') {
        await Promise.resolve(onShutdown());
      }
      server.close(() => process.exit(0));
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

module.exports = { startHttpServer };
