import { WebSocket } from 'ws';
import { startServerWithClient, connectReq } from './src/gateway/test-helpers.ts';

async function main() {
  const started = await startServerWithClient('secret', { controlUiEnabled: true });
  const { server, port, ws: bootstrap, envSnapshot } = started;
  console.log('server port', port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const res = await connectReq(ws, { token: 'secret', scopes: ['operator.write'] });
  console.log('connect response', JSON.stringify(res, null, 2));
  ws.close();
  bootstrap.close();
  await server.close();
  envSnapshot.restore();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
